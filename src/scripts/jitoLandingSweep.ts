/**
 * Jito Landing Sweep — Tip Ladder Test
 *
 * Separates infrastructure rate-limits from actual landing failures.
 * Tests tip ladder: [10k, 25k, 50k, 100k] lamports.
 *
 * Metrics:
 *   - submitSuccess: Bundle accepted by Jito (not 429/5xx)
 *   - landedRate: Bundle landed on-chain
 *   - timeoutRate: Bundle submitted but didn't land
 *   - realizedNet: Actual profit after fees
 *
 * Verdict:
 *   - If 50k-100k tip still can't land → Route1 FAIL (MEV competition too high)
 *   - If infra issues dominate → fix infra first
 *
 * Usage:
 *   npx tsx src/scripts/jitoLandingSweep.ts
 */

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { loadConfig } from "../config.js";
import { getConnection } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, buildJupiterSwap } from "../jupiter.js";
import {
  prepareAtomicBundle,
  sendJitoBundle,
  waitForBundleLanding,
  checkBundleTxResults,
  getJitoTipAccounts,
} from "../jito.js";
import {
  PoolPairInput,
  PairsFile,
  RaydiumPoolReserves,
  OrcaPoolMeta,
  DexQuoteResult,
  USDC_MINT,
  USDC_DECIMALS,
  BUFFER_USDC_UNITS,
  fetchRaydiumReserves,
  fetchOrcaPoolMeta,
  quoteRaydiumCpmmExactIn,
  quoteOrcaExactIn,
  checkMintDecimals,
  sleep,
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

const TIP_LADDER = [10_000, 25_000, 50_000, 100_000]; // lamports
const NOTIONAL_USDC = 10;              // $10 test trade
const TRIGGER_BPS = 10;                // Min edge to trigger
const MAX_TESTS_PER_TIP = 3;           // Max attempts per tip level
const POLL_MS = 5_000;                 // Poll interval for edge
const SLIPPAGE_BPS = 100;              // 1% slippage
const COOLDOWN_AFTER_429_MS = 65_000;  // Wait after rate limit

const DIRECTIONS = ["O_TO_R", "R_TO_O"] as const;
type Direction = (typeof DIRECTIONS)[number];

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface TipTestResult {
  tipLamports: number;
  testId: number;
  // Infra metrics
  tipAccountFetchOk: boolean;
  tipAccountFetchError?: string;
  submitOk: boolean;
  submitError?: string;  // "429" | "5xx" | "timeout" | other
  // Landing metrics
  landed: boolean;
  landingStatus?: string; // "Landed" | "Timeout" | "Failed" | etc
  landingTimeMs?: number;
  // On-chain verification
  bothTxConfirmed?: boolean;
  leg1Confirmed?: boolean;
  leg2Confirmed?: boolean;
  // Trade metrics
  quotedBps?: number;
  realizedBps?: number;
  realizedNetUsdc?: number;
  // TX info
  bundleId?: string;
  leg1Sig?: string;
  leg2Sig?: string;
  timestampUTC: string;
}

interface TipLevelSummary {
  tipLamports: number;
  tipSol: number;
  attempts: number;
  submitSuccessCount: number;
  submitSuccessRate: number;
  landedCount: number;
  landedRate: number;   // landed / submitSuccess
  timeoutCount: number;
  timeoutRate: number;  // timeout / submitSuccess
  infraFailCount: number; // 429, 5xx, tip fetch fail
  avgLandingTimeMs: number;
  avgRealizedBps: number;
  avgRealizedNetUsdc: number;
}

interface SweepSummary {
  generatedAt: string;
  totalTests: number;
  tipLevelResults: TipLevelSummary[];
  verdict: "PASS" | "FAIL" | "INFRA_BLOCKED";
  verdictReason: string;
  recommendation: string;
}

interface EdgeCandidate {
  pair: PoolPairInput;
  direction: Direction;
  netProfitBps: number;
  netProfitUsdc: number;
  orcaOutUnits: bigint;
  raydiumOutUnits: bigint;
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

async function getUsdcBalance(conn: Connection, owner: PublicKey): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner);
  try {
    const acc = await getAccount(conn, ata);
    return acc.amount;
  } catch {
    return 0n;
  }
}

function categorizeError(error: unknown): { code: string; message: string } {
  const msg = String(error);
  if (msg.includes("429") || msg.includes("rate-limit") || msg.includes("Rate-limited")) {
    return { code: "429", message: "Rate limited" };
  }
  if (msg.includes("5") && msg.includes("00")) {
    return { code: "5xx", message: "Server error" };
  }
  if (msg.includes("404")) {
    return { code: "404", message: "Endpoint not found" };
  }
  if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("TIMEOUT")) {
    return { code: "timeout", message: "Request timeout" };
  }
  if (msg.includes("Network congested")) {
    return { code: "congested", message: "Network congested" };
  }
  return { code: "unknown", message: msg.slice(0, 100) };
}

async function testTipAccountFetch(): Promise<{ ok: boolean; error?: string }> {
  try {
    const accounts = await getJitoTipAccounts();
    if (accounts && accounts.length > 0) {
      return { ok: true };
    }
    return { ok: false, error: "Empty tip accounts" };
  } catch (err) {
    const cat = categorizeError(err);
    return { ok: false, error: `${cat.code}: ${cat.message}` };
  }
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Jito Landing Sweep — Tip Ladder Test                        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const cfg = loadConfig();
  const connection = getConnection();
  const owner = getKeypairFromEnv();
  const ownerPub = owner.publicKey;
  const jupiterApiKey = cfg.jupiterApiKey ?? "";
  const priorityFee = cfg.rpc.priorityFeeMicrolamports ?? 50_000;

  console.log(`  Wallet:        ${ownerPub.toBase58()}`);
  console.log(`  Notional:      $${NOTIONAL_USDC}`);
  console.log(`  Tip ladder:    ${TIP_LADDER.map(t => `${t/1000}k`).join(", ")} lamports`);
  console.log(`  Tests/tip:     ${MAX_TESTS_PER_TIP}`);
  console.log(`  Trigger:       ≥${TRIGGER_BPS} bps\n`);

  // Check balance
  const usdcBalance = await getUsdcBalance(connection, ownerPub);
  const usdcBalanceNum = Number(usdcBalance) / 1e6;
  console.log(`  USDC Balance:  $${usdcBalanceNum.toFixed(2)}`);

  if (usdcBalanceNum < NOTIONAL_USDC + 5) {
    console.error(`  ❌ Insufficient balance (need $${NOTIONAL_USDC + 5})`);
    process.exit(1);
  }

  // Load pairs
  const pairsPath = path.join(process.cwd(), "data", "route1_pool_pairs.json");
  const pairsData: PairsFile = JSON.parse(await fs.readFile(pairsPath, "utf-8"));
  let pairs = pairsData.pairs.slice(0, 5); // Top 5 pairs

  // Filter to tested tokens
  const allowedSymbols = new Set(["SOL", "mSOL", "whETH"]);
  pairs = pairs.filter((p) => allowedSymbols.has(p.baseSymbol));
  console.log(`  Pairs:         ${pairs.length}\n`);

  const allResults: TipTestResult[] = [];
  let cooldownActive = false;
  let cooldownUntil = 0;
  let preTradeUsdc = usdcBalanceNum;

  // ═══════════════════════════════════════════════════════════════
  //  Test each tip level
  // ═══════════════════════════════════════════════════════════════

  for (const tipLamports of TIP_LADDER) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  TIP LEVEL: ${tipLamports.toLocaleString()} lamports (${(tipLamports / 1e9).toFixed(5)} SOL)`);
    console.log(`${"═".repeat(60)}\n`);

    let testsCompleted = 0;

    while (testsCompleted < MAX_TESTS_PER_TIP) {
      // Check cooldown
      if (cooldownActive && Date.now() < cooldownUntil) {
        const waitSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.log(`  ⏳ Rate-limit cooldown: ${waitSec}s remaining...`);
        await sleep(5000);
        continue;
      }
      cooldownActive = false;

      const result: TipTestResult = {
        tipLamports,
        testId: testsCompleted + 1,
        tipAccountFetchOk: false,
        submitOk: false,
        landed: false,
        timestampUTC: new Date().toISOString(),
      };

      // ── Step 1: Test tip account fetch ──
      console.log(`  [Test ${testsCompleted + 1}/${MAX_TESTS_PER_TIP}] Checking tip accounts...`);
      const tipTest = await testTipAccountFetch();
      result.tipAccountFetchOk = tipTest.ok;
      result.tipAccountFetchError = tipTest.error;

      if (!tipTest.ok) {
        console.log(`     ⚠ Tip account fetch failed: ${tipTest.error}`);
        if (tipTest.error?.includes("429") || tipTest.error?.includes("timeout")) {
          cooldownActive = true;
          cooldownUntil = Date.now() + COOLDOWN_AFTER_429_MS;
          console.log(`     ⏳ Activating cooldown (${COOLDOWN_AFTER_429_MS/1000}s)`);
        }
        allResults.push(result);
        testsCompleted++;
        continue;
      }
      console.log(`     ✓ Tip accounts OK`);

      // ── Step 2: Find edge opportunity ──
      console.log(`     Scanning for edge ≥${TRIGGER_BPS} bps...`);
      
      let foundEdge = false;
      let bestEdge: EdgeCandidate | null = null;

      // Poll for edge (max 10 ticks)
      for (let tick = 0; tick < 10 && !foundEdge; tick++) {
        // Fetch live data
        let raydiumReserves: Map<string, RaydiumPoolReserves>;
        let orcaPoolMeta: Map<string, OrcaPoolMeta>;

        try {
          [raydiumReserves, orcaPoolMeta] = await Promise.all([
            fetchRaydiumReserves(pairs),
            fetchOrcaPoolMeta(pairs),
          ]);
        } catch {
          console.log(`     [Tick ${tick + 1}] Data fetch failed, retrying...`);
          await sleep(POLL_MS);
          continue;
        }

        const notionalUnits = BigInt(NOTIONAL_USDC) * BigInt(10 ** USDC_DECIMALS);
        const candidates: EdgeCandidate[] = [];

        for (const pair of pairs) {
          const reserves = raydiumReserves.get(pair.raydiumPoolId);
          const orcaMeta = orcaPoolMeta.get(pair.orcaPoolId);

          const mintCheck = checkMintDecimals(pair, orcaMeta, reserves);
          if (!mintCheck.ok) continue;

          for (const direction of DIRECTIONS) {
            try {
              if (direction === "O_TO_R") {
                // Buy on Orca, sell on Raydium
                const buyResult = await quoteOrcaExactIn(
                  USDC_MINT,
                  pair.baseMint,
                  notionalUnits,
                  jupiterApiKey,
                );

                if (!buyResult.ok || buyResult.outAmountUnits <= 0n) continue;

                const sellResult = quoteRaydiumCpmmExactIn(
                  reserves!,
                  pair.baseMint,
                  buyResult.outAmountUnits,
                );

                if (!sellResult.ok) continue;

                const grossProfit = sellResult.outAmountUnits - notionalUnits;
                const netProfit = grossProfit - BUFFER_USDC_UNITS;
                const netProfitBps = Number(((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2));

                candidates.push({
                  pair,
                  direction,
                  netProfitBps,
                  netProfitUsdc: Number(netProfit) / 1e6,
                  orcaOutUnits: buyResult.outAmountUnits,
                  raydiumOutUnits: sellResult.outAmountUnits,
                });
              } else {
                // Buy on Raydium, sell on Orca
                const buyResult = quoteRaydiumCpmmExactIn(
                  reserves!,
                  USDC_MINT,
                  notionalUnits,
                );

                if (!buyResult.ok || buyResult.outAmountUnits <= 0n) continue;

                const sellResult = await quoteOrcaExactIn(
                  pair.baseMint,
                  USDC_MINT,
                  buyResult.outAmountUnits,
                  jupiterApiKey,
                );

                if (!sellResult.ok) continue;

                const grossProfit = sellResult.outAmountUnits - notionalUnits;
                const netProfit = grossProfit - BUFFER_USDC_UNITS;
                const netProfitBps = Number(((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2));

                candidates.push({
                  pair,
                  direction,
                  netProfitBps,
                  netProfitUsdc: Number(netProfit) / 1e6,
                  orcaOutUnits: sellResult.outAmountUnits,
                  raydiumOutUnits: buyResult.outAmountUnits,
                });
              }
            } catch {
              // Quote failed, skip
            }
          }
        }

        // Find best edge
        const best = candidates.reduce(
          (bestC, curr) => (curr.netProfitBps > bestC.netProfitBps ? curr : bestC),
          { netProfitBps: -Infinity } as EdgeCandidate,
        );

        if (best.netProfitBps >= TRIGGER_BPS) {
          foundEdge = true;
          bestEdge = best;
        } else {
          console.log(
            `     [Tick ${tick + 1}] Best edge: ${best.netProfitBps?.toFixed(1) ?? "N/A"} bps ` +
            `(need ≥${TRIGGER_BPS}) — waiting...`
          );
          await sleep(POLL_MS);
        }
      }

      if (!bestEdge) {
        console.log(`     ⏭ No edge found after 10 ticks, skipping test`);
        testsCompleted++;
        continue;
      }

      console.log(`     ✓ Edge found: ${bestEdge.netProfitBps.toFixed(1)} bps (${bestEdge.pair.baseSymbol} ${bestEdge.direction})`);
      result.quotedBps = bestEdge.netProfitBps;

      // ── Step 3: Build transactions ──
      console.log(`     Building swap TXs...`);
      
      const { pair, direction } = bestEdge;
      const notionalUnits = BigInt(NOTIONAL_USDC) * BigInt(10 ** USDC_DECIMALS);
      
      try {
        const isOrcaFirst = direction === "O_TO_R";
        const leg1Dex = isOrcaFirst ? "Whirlpool" : "Raydium,RaydiumCLMM,RaydiumCP";
        const leg2Dex = isOrcaFirst ? "Raydium,RaydiumCLMM,RaydiumCP" : "Whirlpool";

        // Build Leg1 TX
        const leg1Quote = await fetchJupiterQuote({
          inputMint: USDC_MINT,
          outputMint: pair.baseMint,
          amount: notionalUnits,
          slippageBps: SLIPPAGE_BPS,
          dexes: leg1Dex,
        });

        const leg1Tx = await buildJupiterSwap({
          route: leg1Quote.route,
          userPublicKey: ownerPub,
          priorityFeeMicroLamports: priorityFee,
        });

        // Use expected output from Leg1 for Leg2 input
        const leg1ExpectedOut = leg1Quote.meta.expectedOut;

        // Build Leg2 TX
        const leg2Quote = await fetchJupiterQuote({
          inputMint: pair.baseMint,
          outputMint: USDC_MINT,
          amount: leg1ExpectedOut,
          slippageBps: SLIPPAGE_BPS,
          dexes: leg2Dex,
        });

        const leg2Tx = await buildJupiterSwap({
          route: leg2Quote.route,
          userPublicKey: ownerPub,
          priorityFeeMicroLamports: priorityFee,
        });

        // ── Step 4: Prepare and send bundle ──
        console.log(`     Preparing Jito bundle (tip: ${tipLamports} lamports)...`);
        
        const bundleData = await prepareAtomicBundle({
          leg1Tx,
          leg2Tx,
          signer: owner,
          tipLamports,
        });

        result.leg1Sig = bundleData.txSignatures[0];
        result.leg2Sig = bundleData.txSignatures[1];

        console.log(`     Sending bundle...`);
        const sendStart = Date.now();

        try {
          const bundleId = await sendJitoBundle(bundleData.signedTxs);
          result.bundleId = bundleId;
          result.submitOk = true;
          console.log(`     ✓ Bundle submitted: ${bundleId.slice(0, 20)}...`);

          // ── Step 5: Wait for landing ──
          console.log(`     Waiting for landing...`);
          const landingResult = await waitForBundleLanding(bundleId, 30_000);
          result.landingTimeMs = Date.now() - sendStart;
          result.landingStatus = landingResult.status;

          if (landingResult.status === "Landed") {
            result.landed = true;
            console.log(`     ✓ Bundle landed! (${result.landingTimeMs}ms)`);

            // Verify on-chain
            const txResults = await checkBundleTxResults(
              bundleData.txSignatures[0],
              bundleData.txSignatures[1]
            );
            result.bothTxConfirmed = txResults.outcome === "bothSucceeded";
            result.leg1Confirmed = txResults.leg1.confirmed && !txResults.leg1.err;
            result.leg2Confirmed = txResults.leg2.confirmed && !txResults.leg2.err;

            // Calculate realized P/L
            await sleep(2000); // Wait for balance update
            const postBalance = await getUsdcBalance(connection, ownerPub);
            const postBalanceNum = Number(postBalance) / 1e6;
            
            const tipCostUsdc = (tipLamports / 1e9) * 150; // ~$150/SOL estimate
            const realizedNet = postBalanceNum - preTradeUsdc;
            result.realizedNetUsdc = realizedNet;
            result.realizedBps = Math.round((realizedNet / NOTIONAL_USDC) * 10000);

            console.log(`     Realized: ${result.realizedBps} bps ($${realizedNet.toFixed(4)})`);

            // Update pre-trade balance for next iteration
            preTradeUsdc = postBalanceNum;

          } else {
            console.log(`     ✗ Landing failed: ${landingResult.status} (${result.landingTimeMs}ms)`);
          }

        } catch (sendErr) {
          const cat = categorizeError(sendErr);
          result.submitError = `${cat.code}: ${cat.message}`;
          console.log(`     ✗ Submit failed: ${result.submitError}`);

          if (cat.code === "429") {
            cooldownActive = true;
            cooldownUntil = Date.now() + COOLDOWN_AFTER_429_MS;
            console.log(`     ⏳ Activating cooldown (${COOLDOWN_AFTER_429_MS/1000}s)`);
          }
        }

      } catch (buildErr) {
        console.log(`     ✗ Build failed: ${String(buildErr).slice(0, 100)}`);
        result.submitError = `build: ${String(buildErr).slice(0, 80)}`;
      }

      allResults.push(result);
      testsCompleted++;

      // Brief pause between tests
      await sleep(2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Generate Summary
  // ═══════════════════════════════════════════════════════════════

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SWEEP SUMMARY`);
  console.log(`${"═".repeat(60)}\n`);

  const tipLevelResults: TipLevelSummary[] = [];

  for (const tipLamports of TIP_LADDER) {
    const tipResults = allResults.filter(r => r.tipLamports === tipLamports);
    const attempts = tipResults.length;
    const infraFails = tipResults.filter(r => !r.tipAccountFetchOk || (r.submitError && ["429", "5xx", "timeout"].some(c => r.submitError!.includes(c)))).length;
    const submitSuccess = tipResults.filter(r => r.submitOk).length;
    const landed = tipResults.filter(r => r.landed).length;
    const timeouts = tipResults.filter(r => r.submitOk && !r.landed && r.landingStatus?.includes("Timeout")).length;
    
    const landingTimes = tipResults.filter(r => r.landingTimeMs).map(r => r.landingTimeMs!);
    const avgLandingTime = landingTimes.length > 0 ? landingTimes.reduce((a, b) => a + b, 0) / landingTimes.length : 0;
    
    const realizedBpsArr = tipResults.filter(r => r.realizedBps !== undefined).map(r => r.realizedBps!);
    const avgRealizedBps = realizedBpsArr.length > 0 ? realizedBpsArr.reduce((a, b) => a + b, 0) / realizedBpsArr.length : 0;
    
    const realizedNetArr = tipResults.filter(r => r.realizedNetUsdc !== undefined).map(r => r.realizedNetUsdc!);
    const avgRealizedNet = realizedNetArr.length > 0 ? realizedNetArr.reduce((a, b) => a + b, 0) / realizedNetArr.length : 0;

    const summary: TipLevelSummary = {
      tipLamports,
      tipSol: tipLamports / 1e9,
      attempts,
      submitSuccessCount: submitSuccess,
      submitSuccessRate: attempts > 0 ? submitSuccess / attempts : 0,
      landedCount: landed,
      landedRate: submitSuccess > 0 ? landed / submitSuccess : 0,
      timeoutCount: timeouts,
      timeoutRate: submitSuccess > 0 ? timeouts / submitSuccess : 0,
      infraFailCount: infraFails,
      avgLandingTimeMs: avgLandingTime,
      avgRealizedBps,
      avgRealizedNetUsdc: avgRealizedNet,
    };

    tipLevelResults.push(summary);

    console.log(`  ${tipLamports.toLocaleString().padStart(7)} lamports (${summary.tipSol.toFixed(5)} SOL):`);
    console.log(`     Attempts:       ${attempts}`);
    console.log(`     Infra fails:    ${infraFails} (${(infraFails/attempts*100 || 0).toFixed(0)}%)`);
    console.log(`     Submit OK:      ${submitSuccess} (${(summary.submitSuccessRate*100).toFixed(0)}%)`);
    console.log(`     Landed:         ${landed} (${(summary.landedRate*100).toFixed(0)}% of submitted)`);
    console.log(`     Timeout:        ${timeouts} (${(summary.timeoutRate*100).toFixed(0)}% of submitted)`);
    console.log(`     Avg landing:    ${avgLandingTime.toFixed(0)}ms`);
    console.log(`     Avg realized:   ${avgRealizedBps.toFixed(1)} bps ($${avgRealizedNet.toFixed(4)})`);
    console.log();
  }

  // Determine verdict
  let verdict: "PASS" | "FAIL" | "INFRA_BLOCKED";
  let verdictReason: string;
  let recommendation: string;

  const highTipResults = tipLevelResults.filter(t => t.tipLamports >= 50_000);
  const totalInfraFails = tipLevelResults.reduce((sum, t) => sum + t.infraFailCount, 0);
  const totalAttempts = tipLevelResults.reduce((sum, t) => sum + t.attempts, 0);
  const infraFailRate = totalAttempts > 0 ? totalInfraFails / totalAttempts : 0;

  if (infraFailRate > 0.7) {
    verdict = "INFRA_BLOCKED";
    verdictReason = `Infra failures dominate (${(infraFailRate*100).toFixed(0)}% rate-limited/timeout)`;
    recommendation = "Fix Jito endpoint issues first. Consider: (1) Wait for rate-limit cooldown, (2) Use private relay, (3) Reduce request frequency.";
  } else if (highTipResults.length > 0) {
    const maxLandedRate = Math.max(...highTipResults.map(t => t.landedRate));
    if (maxLandedRate < 0.3) {
      verdict = "FAIL";
      verdictReason = `High tip (50k-100k) landing rate too low (${(maxLandedRate*100).toFixed(0)}%)`;
      recommendation = "Route1 (public Orca↔Raydium) has high MEV competition. Pivot to: (1) Less-contested pairs, (2) Private relay hypothesis, (3) Different route.";
    } else {
      const bestTip = highTipResults.reduce((best, t) => t.landedRate > best.landedRate ? t : best);
      if (bestTip.avgRealizedBps > 0) {
        verdict = "PASS";
        verdictReason = `Tip ${bestTip.tipLamports} achieves ${(bestTip.landedRate*100).toFixed(0)}% land rate with ${bestTip.avgRealizedBps.toFixed(1)} bps profit`;
        recommendation = `Use tip ${bestTip.tipLamports} lamports for production.`;
      } else {
        verdict = "FAIL";
        verdictReason = `Landing works but realized profit negative (${bestTip.avgRealizedBps.toFixed(1)} bps)`;
        recommendation = "Edge exists but tip + fees exceed profit. Need higher edge opportunities or lower tip.";
      }
    }
  } else {
    verdict = "FAIL";
    verdictReason = "No high-tip tests completed";
    recommendation = "Retry when infra is stable.";
  }

  console.log(`${"═".repeat(60)}`);
  console.log(`  VERDICT: ${verdict}`);
  console.log(`  Reason:  ${verdictReason}`);
  console.log(`  Action:  ${recommendation}`);
  console.log(`${"═".repeat(60)}\n`);

  // Save results
  const sweepSummary: SweepSummary = {
    generatedAt: new Date().toISOString(),
    totalTests: allResults.length,
    tipLevelResults,
    verdict,
    verdictReason,
    recommendation,
  };

  const outDir = path.join(process.cwd(), "data", "telemetry");
  await fs.mkdir(outDir, { recursive: true });
  
  await fs.writeFile(
    path.join(outDir, "jito_landing_sweep.json"),
    JSON.stringify(sweepSummary, null, 2)
  );
  
  await fs.writeFile(
    path.join(outDir, "jito_landing_sweep_raw.json"),
    JSON.stringify(allResults, null, 2)
  );

  console.log(`  Results saved to data/telemetry/jito_landing_sweep*.json\n`);
}

// ══════════════════════════════════════════════════════════════
//  Entry
// ══════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error("Jito Landing Sweep failed:", err);
  process.exit(1);
});
