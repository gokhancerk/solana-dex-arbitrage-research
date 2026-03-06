/**
 * Stage4Dust — Minimal Dust Trade Execution
 *
 * Real on-chain execution with minimal capital to validate edge profitability.
 *
 * Spec:
 *   - Notional: 5 USDC
 *   - Max trades: 10
 *   - Trigger: quotedBps ≥ 10
 *   - Log: quotedBps, realizedBps, fee, latency, fail
 *   - PASS: median(realizedBps) > 0 AND failRate < 30%
 *   - FAIL: otherwise → kill-switch
 *
 * Usage:
 *   npx tsx src/scripts/stage4Dust.ts
 *   npm run stage4:dust
 */

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { loadConfig } from "../config.js";
import { getConnection, sendVersionedWithOpts, waitForConfirmation } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, buildJupiterSwap } from "../jupiter.js";
import {
  prepareAtomicBundle,
  sendJitoBundle,
  waitForBundleLanding,
  checkBundleTxResults,
} from "../jito.js";
import {
  PoolPairInput,
  PairsFile,
  RaydiumPoolReserves,
  OrcaPoolMeta,
  USDC_MINT,
  USDC_DECIMALS,
  BUFFER_USDC_UNITS,
  fetchRaydiumReserves,
  fetchOrcaPoolMeta,
  quoteRaydiumCpmmExactIn,
  quoteOrcaExactIn,
  checkMintDecimals,
  sleep,
  parallelLimit,
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  CLI Arguments
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const NO_JITO = args.includes("--no-jito") || args.includes("--sequential");

// ══════════════════════════════════════════════════════════════
//  Stage4 Constants
// ══════════════════════════════════════════════════════════════

const USE_JITO_BUNDLE = !NO_JITO;     // Use Jito atomic bundle (faster)
const NOTIONAL_USDC = 15;             // $15 trade
const MAX_TRADES = 10;                // Stop after 10 trades
const TRIGGER_BPS = 10;               // Min edge to trigger execution
const POLL_MS = 3_000;                // Poll interval
const SLIPPAGE_BPS = 100;             // 1% slippage for execution
const ORCA_CONCURRENCY = 4;

const DIRECTIONS = ["O_TO_R", "R_TO_O"] as const;
type Direction = (typeof DIRECTIONS)[number];

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface TradeRecord {
  tradeId: number;
  timestampUTC: string;
  symbol: string;
  direction: Direction;
  notionalUsdc: number;
  // Quote metrics
  quotedBps: number;
  quotedProfitUsdc: number;
  // Execution metrics
  success: boolean;
  failReason?: string;
  realizedBps?: number;
  realizedProfitUsdc?: number;
  // Fee & latency
  feeSol?: number;
  feeUsdc?: number;
  latencyMs?: number;
  // TX details
  leg1Sig?: string;
  leg2Sig?: string;
}

interface Stage4Summary {
  generatedAt: string;
  totalTrades: number;
  successCount: number;
  failCount: number;
  failRate: number;
  medianRealizedBps: number;
  totalProfitUsdc: number;
  totalFeesUsdc: number;
  netProfitUsdc: number;
  gate: "PASS" | "FAIL";
  gateReason: string;
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function getUsdcBalance(connection: Connection, owner: PublicKey): Promise<bigint> {
  const usdcMint = new PublicKey(USDC_MINT);
  const ata = await getAssociatedTokenAddress(usdcMint, owner);
  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stage4Dust — Real Execution ($${NOTIONAL_USDC} × ${MAX_TRADES} trades)             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // ── Load config ──
  const cfg = loadConfig();
  const connection = getConnection();
  const owner = getKeypairFromEnv();
  const ownerPub = owner.publicKey;
  const jupiterApiKey = cfg.jupiterApiKey ?? "";
  const priorityFee = cfg.rpc.priorityFeeMicrolamports ?? 50_000;

  console.log(`  Wallet:        ${ownerPub.toBase58()}`);
  console.log(`  Notional:      $${NOTIONAL_USDC}`);
  console.log(`  Max trades:    ${MAX_TRADES}`);
  console.log(`  Trigger:       ≥${TRIGGER_BPS} bps`);
  console.log(`  Slippage:      ${SLIPPAGE_BPS / 100}%`);
  console.log(`  Exec mode:     ${USE_JITO_BUNDLE ? "Jito Bundle (atomic)" : "Sequential (fallback)"}`);
  if (NO_JITO) console.log(`  ⚠  --no-jito flag active`);

  // ── Check wallet balance ──
  const usdcBalance = await getUsdcBalance(connection, ownerPub);
  const usdcBalanceNum = Number(usdcBalance) / 1e6;
  console.log(`  USDC Balance:  $${usdcBalanceNum.toFixed(2)}`);

  if (usdcBalanceNum < NOTIONAL_USDC * 1.5) {
    console.error(`\n  ✗ Insufficient USDC balance. Need at least $${(NOTIONAL_USDC * 1.5).toFixed(2)}`);
    process.exit(1);
  }

  // ── Load pool pairs ──
  const pairFiles = ["route1_pool_pairs.json"];
  let pairs: PoolPairInput[] = [];

  for (const file of pairFiles) {
    const p = path.join("data", file);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const pf: PairsFile = JSON.parse(raw);
      pairs.push(...pf.pairs);
    } catch {
      console.error(`  ✗ Failed to load ${p}`);
      process.exit(1);
    }
  }

  // Filter to SOL, mSOL, whETH
  const allowedSymbols = new Set(["SOL", "mSOL", "whETH"]);
  pairs = pairs.filter((p) => allowedSymbols.has(p.baseSymbol));

  console.log(`  Pairs:         ${pairs.length}`);
  console.log(`\n  ⏱  Starting execution loop...\n`);

  // ── Output setup ──
  const outputDir = "archive/20260305_stage4_dust";
  await fs.mkdir(outputDir, { recursive: true });
  const tradesFile = path.join(outputDir, "trades.jsonl");

  // ── Trade loop ──
  const trades: TradeRecord[] = [];
  let tradeCount = 0;
  let tick = 0;

  while (tradeCount < MAX_TRADES) {
    tick++;

    // Fetch live data
    let raydiumReserves: Map<string, RaydiumPoolReserves>;
    let orcaPoolMeta: Map<string, OrcaPoolMeta>;

    try {
      [raydiumReserves, orcaPoolMeta] = await Promise.all([
        fetchRaydiumReserves(pairs),
        fetchOrcaPoolMeta(pairs),
      ]);
    } catch (err) {
      console.log(`  [Tick ${tick}] Data fetch failed, retrying...`);
      await sleep(POLL_MS);
      continue;
    }

    // Find best edge
    interface EdgeCandidate {
      pair: PoolPairInput;
      direction: Direction;
      netProfitBps: number;
      netProfitUsdc: number;
      orcaInAmountUnits: bigint;
      orcaOutUnits: bigint;
      raydiumOutUnits: bigint;
      orcaInputMint: string;
      orcaOutputMint: string;
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
              orcaInAmountUnits: notionalUnits,
              orcaOutUnits: buyResult.outAmountUnits,
              raydiumOutUnits: sellResult.outAmountUnits,
              orcaInputMint: USDC_MINT,
              orcaOutputMint: pair.baseMint,
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
              orcaInAmountUnits: buyResult.outAmountUnits,
              orcaOutUnits: sellResult.outAmountUnits,
              raydiumOutUnits: buyResult.outAmountUnits,
              orcaInputMint: pair.baseMint,
              orcaOutputMint: USDC_MINT,
            });
          }
        } catch {
          // Quote failed, skip
        }
      }
    }

    // Find best edge
    const bestEdge = candidates.reduce(
      (best, curr) => (curr.netProfitBps > best.netProfitBps ? curr : best),
      { netProfitBps: -Infinity } as EdgeCandidate,
    );

    if (bestEdge.netProfitBps < TRIGGER_BPS) {
      console.log(
        `  [Tick ${tick}] Best edge: ${bestEdge.netProfitBps?.toFixed(1) ?? "N/A"} bps ` +
        `(need ≥${TRIGGER_BPS}) — waiting...`
      );
      await sleep(POLL_MS);
      continue;
    }

    // ══════════════════════════════════════════════════════════════
    //  Execute Trade
    // ══════════════════════════════════════════════════════════════

    tradeCount++;
    const tradeId = tradeCount;
    const t0 = Date.now();

    console.log(`\n  ══════════════════════════════════════════════════════════════`);
    console.log(`  🚀 Trade #${tradeId}: ${bestEdge.pair.baseSymbol} ${bestEdge.direction}`);
    console.log(`     Quoted: ${bestEdge.netProfitBps.toFixed(1)} bps ($${bestEdge.netProfitUsdc.toFixed(4)})`);

    const record: TradeRecord = {
      tradeId,
      timestampUTC: new Date().toISOString(),
      symbol: bestEdge.pair.baseSymbol,
      direction: bestEdge.direction,
      notionalUsdc: NOTIONAL_USDC,
      quotedBps: bestEdge.netProfitBps,
      quotedProfitUsdc: bestEdge.netProfitUsdc,
      success: false,
    };

    try {
      // Get pre-trade USDC balance
      const preUsdc = await getUsdcBalance(connection, ownerPub);

      // Direction determines which DEX is Leg1 vs Leg2:
      //   O_TO_R: Leg1 = Orca (USDC→BASE), Leg2 = Raydium (BASE→USDC)
      //   R_TO_O: Leg1 = Raydium (USDC→BASE), Leg2 = Orca (BASE→USDC)

      const isOrcaFirst = bestEdge.direction === "O_TO_R";
      const leg1Dex = isOrcaFirst ? "Whirlpool" : "Raydium,RaydiumCLMM,RaydiumCP";
      const leg2Dex = isOrcaFirst ? "Raydium,RaydiumCLMM,RaydiumCP" : "Whirlpool";

      // ── Build both legs ──
      console.log(`     [Build] Leg1: ${isOrcaFirst ? 'Orca' : 'Raydium'} (USDC→BASE)...`);
      const notionalUnits = BigInt(NOTIONAL_USDC) * BigInt(10 ** USDC_DECIMALS);

      const leg1Quote = await fetchJupiterQuote({
        inputMint: USDC_MINT,
        outputMint: bestEdge.pair.baseMint,
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
      console.log(`     [Build] Leg2: ${isOrcaFirst ? 'Raydium' : 'Orca'} (BASE→USDC) with ${leg1ExpectedOut} units...`);

      const leg2Quote = await fetchJupiterQuote({
        inputMint: bestEdge.pair.baseMint,
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

      if (USE_JITO_BUNDLE) {
        // ══════════════════════════════════════════════════════════════
        //  Jito Atomic Bundle Execution
        // ══════════════════════════════════════════════════════════════
        console.log(`     [Jito] Preparing atomic bundle...`);

        const bundleData = await prepareAtomicBundle({
          leg1Tx,
          leg2Tx,
          signer: owner,
          tipLamports: 100_000, // 0.0001 SOL tip (~$0.015)
        });

        console.log(`     [Jito] Sending bundle...`);
        const bundleId = await sendJitoBundle(bundleData.signedTxs);
        console.log(`     [Jito] Bundle ID: ${bundleId.slice(0, 20)}...`);

        record.leg1Sig = bundleData.txSignatures[0];
        record.leg2Sig = bundleData.txSignatures[1];

        // Wait for bundle landing
        console.log(`     [Jito] Waiting for landing...`);
        const landingResult = await waitForBundleLanding(bundleId, 30_000);

        if (landingResult.status !== "Landed") {
          throw new Error(`Bundle failed: ${landingResult.status}`);
        }

        // Verify TX results
        const txResults = await checkBundleTxResults(
          bundleData.txSignatures[0],
          bundleData.txSignatures[1]
        );
        if (txResults.outcome !== "bothSucceeded") {
          const errMsg = txResults.leg1.err || txResults.leg2.err || txResults.outcome;
          throw new Error(`TX failed on-chain: ${errMsg}`);
        }

        console.log(`     [Jito] Bundle landed ✓ (slot ${landingResult.landedSlot})`);

      } else {
        // ══════════════════════════════════════════════════════════════
        //  Sequential Execution (fallback)
        // ══════════════════════════════════════════════════════════════
        
        // Sign and send Leg 1
        leg1Tx.sign([owner]);
        console.log(`     [Leg1] Sending TX...`);
        const leg1Sig = await sendVersionedWithOpts(connection, leg1Tx, {
          skipPreflight: true,
          maxRetries: 3,
        });
        record.leg1Sig = leg1Sig;
        console.log(`     [Leg1] TX sent: ${leg1Sig.slice(0, 20)}...`);

        // Wait for confirmation
        await waitForConfirmation(leg1Sig, "confirmed", 30_000);

        // Sign and send Leg 2
        leg2Tx.sign([owner]);
        console.log(`     [Leg2] Sending TX...`);
        const leg2Sig = await sendVersionedWithOpts(connection, leg2Tx, {
          skipPreflight: true,
          maxRetries: 3,
        });
        record.leg2Sig = leg2Sig;
        console.log(`     [Leg2] TX sent: ${leg2Sig.slice(0, 20)}...`);

        // Wait for confirmation
        await waitForConfirmation(leg2Sig, "confirmed", 30_000);
      }

      // ── Calculate realized profit ──
      const postUsdc = await getUsdcBalance(connection, ownerPub);
      const realizedProfitUnits = postUsdc - preUsdc;
      const realizedProfitUsdc = Number(realizedProfitUnits) / 1e6;
      const realizedBps = Number(((realizedProfitUsdc / NOTIONAL_USDC) * 10_000).toFixed(2));

      record.success = true;
      record.realizedBps = realizedBps;
      record.realizedProfitUsdc = realizedProfitUsdc;
      record.latencyMs = Date.now() - t0;

      // Fee: Jito tip + base fees
      record.feeSol = USE_JITO_BUNDLE ? 0.00002 : 0.0001; // Jito more efficient
      record.feeUsdc = record.feeSol * 140;

      console.log(`     ✅ SUCCESS`);
      console.log(`        Realized: ${realizedBps.toFixed(1)} bps ($${realizedProfitUsdc.toFixed(4)})`);
      console.log(`        Latency: ${record.latencyMs}ms`);

    } catch (err) {
      record.success = false;
      record.failReason = err instanceof Error ? err.message : String(err);
      record.latencyMs = Date.now() - t0;

      console.log(`     ❌ FAILED: ${record.failReason}`);
    }

    // Log trade
    trades.push(record);
    await fs.appendFile(tradesFile, JSON.stringify(record) + "\n");

    // Brief cooldown
    await sleep(2000);
  }

  // ══════════════════════════════════════════════════════════════
  //  Summary & Gate Evaluation
  // ══════════════════════════════════════════════════════════════

  console.log(`\n  ═══════════════════════════════════════════════════════════════`);
  console.log(`  Stage4Dust Summary`);
  console.log(`  ═══════════════════════════════════════════════════════════════\n`);

  const successTrades = trades.filter((t) => t.success);
  const failedTrades = trades.filter((t) => !t.success);
  const realizedBpsValues = successTrades.map((t) => t.realizedBps ?? 0);
  const medianBps = median(realizedBpsValues);
  const failRate = failedTrades.length / trades.length;

  const totalProfit = successTrades.reduce((sum, t) => sum + (t.realizedProfitUsdc ?? 0), 0);
  const totalFees = successTrades.reduce((sum, t) => sum + (t.feeUsdc ?? 0), 0);
  const netProfit = totalProfit - totalFees;

  // Gate evaluation
  const pass = medianBps > 0 && failRate < 0.3;
  const gate = pass ? "PASS" : "FAIL";
  const gateReason = pass
    ? `median(${medianBps.toFixed(1)}bps) > 0 AND failRate(${(failRate * 100).toFixed(0)}%) < 30%`
    : medianBps <= 0
      ? `median(${medianBps.toFixed(1)}bps) ≤ 0 → KILL SWITCH`
      : `failRate(${(failRate * 100).toFixed(0)}%) ≥ 30% → KILL SWITCH`;

  const summary: Stage4Summary = {
    generatedAt: new Date().toISOString(),
    totalTrades: trades.length,
    successCount: successTrades.length,
    failCount: failedTrades.length,
    failRate,
    medianRealizedBps: medianBps,
    totalProfitUsdc: totalProfit,
    totalFeesUsdc: totalFees,
    netProfitUsdc: netProfit,
    gate,
    gateReason,
  };

  console.log(`  Total trades:      ${summary.totalTrades}`);
  console.log(`  Success:           ${summary.successCount}`);
  console.log(`  Failed:            ${summary.failCount} (${(summary.failRate * 100).toFixed(0)}%)`);
  console.log(`  Median realized:   ${summary.medianRealizedBps.toFixed(1)} bps`);
  console.log(`  Total profit:      $${summary.totalProfitUsdc.toFixed(4)}`);
  console.log(`  Total fees:        $${summary.totalFeesUsdc.toFixed(4)}`);
  console.log(`  Net profit:        $${summary.netProfitUsdc.toFixed(4)}`);
  console.log(`\n  ══════════════════════════════════════════════════════════════`);
  console.log(`  GATE: ${gate}`);
  console.log(`  ${gateReason}`);
  console.log(`  ══════════════════════════════════════════════════════════════\n`);

  // Write summary
  const summaryFile = path.join(outputDir, "stage4_summary.json");
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`  📝 Summary: ${summaryFile}`);
  console.log(`  📝 Trades:  ${tradesFile}\n`);

  // Exit code based on gate
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Stage4Dust failed:", err);
  process.exit(1);
});
