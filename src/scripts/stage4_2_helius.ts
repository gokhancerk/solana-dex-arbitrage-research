/**
 * Stage4.2 — Helius Execution Test
 *
 * A/B test: Same route, same pairs, different execution path.
 * Uses Helius Priority Fee API + sendTransaction instead of Jito bundle.
 *
 * Spec:
 *   - Notional:   30 USDC
 *   - Max trades: 10
 *   - Trigger:    quotedBps ≥ 10 (unchanged)
 *   - Exec path:  Helius Priority Fee + sequential
 *   - PASS:       median(realizedBps) > 0
 *   - FAIL:       median(realizedBps) ≤ 0
 *
 * Usage:
 *   npx tsx src/scripts/stage4_2_helius.ts
 *   npm run stage4:helius
 */

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import {
  Keypair,
  VersionedTransaction,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { loadConfig } from "../config.js";
import { getConnection } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, buildJupiterSwap } from "../jupiter.js";
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
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  Stage4.2 Constants
// ══════════════════════════════════════════════════════════════

const NOTIONAL_USDC = 15;             // $15 trade (adjusted for balance)
const MAX_TRADES = 3;                 // TEMP: 3 trades for infra test
const TRIGGER_BPS = 10;              // TEMP: lowered for infra test (normal: 10)
const POLL_MS = 3_000;                // Poll interval
const SLIPPAGE_BPS = 100;             // 1% slippage for execution
const MAX_TICKS_NO_EDGE = 200;        // Max ticks without edge before abort

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
  priorityFeeMicroLamports?: number;
  feeSol?: number;
  feeUsdc?: number;
  latencyMs?: number;
  // TX details
  leg1Sig?: string;
  leg2Sig?: string;
}

interface Stage4Summary {
  generatedAt: string;
  testName: string;
  execPath: string;
  totalTrades: number;
  successCount: number;
  failCount: number;
  failRate: number;
  medianRealizedBps: number;
  avgRealizedBps: number;
  totalProfitUsdc: number;
  totalFeesUsdc: number;
  netProfitUsdc: number;
  avgLatencyMs: number;
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

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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
//  Helius Priority Fee API
// ══════════════════════════════════════════════════════════════

async function getHeliusPriorityFee(rpcUrl: string): Promise<number> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'priority-fee',
        method: 'getPriorityFeeEstimate',
        params: [{
          options: {
            priorityLevel: 'High'
          }
        }]
      })
    });

    const result = await response.json();
    if (result.result?.priorityFeeEstimate) {
      return Math.ceil(result.result.priorityFeeEstimate);
    }
    return 50_000; // fallback
  } catch {
    return 50_000; // fallback
  }
}

// ══════════════════════════════════════════════════════════════
//  Helius sendTransaction with Priority Fee
// ══════════════════════════════════════════════════════════════

async function sendWithHelius(
  connection: Connection,
  tx: VersionedTransaction,
  signer: Keypair,
  priorityFee: number
): Promise<{ signature: string; latencyMs: number }> {
  const t0 = Date.now();

  // Sign the transaction
  tx.sign([signer]);

  // Send with optimized options
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });

  // Wait for confirmation
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  return {
    signature,
    latencyMs: Date.now() - t0,
  };
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stage4.2 — Helius Execution Test ($${NOTIONAL_USDC} × ${MAX_TRADES} trades)        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // ── Load config ──
  const cfg = loadConfig();
  const connection = getConnection();
  const owner = getKeypairFromEnv();
  const ownerPub = owner.publicKey;
  const jupiterApiKey = cfg.jupiterApiKey ?? "";
  const rpcUrl = process.env.SOLANA_RPC_PRIMARY!;

  console.log(`  Wallet:        ${ownerPub.toBase58()}`);
  console.log(`  Notional:      $${NOTIONAL_USDC}`);
  console.log(`  Max trades:    ${MAX_TRADES}`);
  console.log(`  Trigger:       ≥${TRIGGER_BPS} bps`);
  console.log(`  Slippage:      ${SLIPPAGE_BPS / 100}%`);
  console.log(`  Exec path:     Helius Priority Fee + sendTransaction`);
  console.log(`  NO JITO:       ✓`);

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

  // Filter to SOL, mSOL, whETH (same as Stage4)
  const allowedSymbols = new Set(["SOL", "mSOL", "whETH"]);
  pairs = pairs.filter((p) => allowedSymbols.has(p.baseSymbol));

  console.log(`  Pairs:         ${pairs.length}`);
  console.log(`\n  ⏱  Starting execution loop...\n`);

  // ── Output setup ──
  const outputDir = "archive/20260306_stage4_2_helius";
  await fs.mkdir(outputDir, { recursive: true });
  const tradesFile = path.join(outputDir, "trades.jsonl");

  // ── Trade loop ──
  const trades: TradeRecord[] = [];
  let tradeCount = 0;
  let tick = 0;
  let noEdgeTicks = 0;

  while (tradeCount < MAX_TRADES) {
    tick++;
    noEdgeTicks++;

    // Abort if no edge found for too long
    if (noEdgeTicks > MAX_TICKS_NO_EDGE) {
      console.log(`\n  ⚠️ No edge found after ${MAX_TICKS_NO_EDGE} ticks. Aborting test.`);
      break;
    }

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

    // Reset no-edge counter
    noEdgeTicks = 0;

    // ══════════════════════════════════════════════════════════════
    //  Execute Trade via Helius
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
      // Get Helius priority fee
      const priorityFee = await getHeliusPriorityFee(rpcUrl);
      record.priorityFeeMicroLamports = priorityFee;
      console.log(`     Priority fee: ${priorityFee} micro-lamports`);

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

      // ── Execute Leg 1 ──
      console.log(`     [Leg1] Sending via Helius...`);
      const leg1Result = await sendWithHelius(connection, leg1Tx, owner, priorityFee);
      record.leg1Sig = leg1Result.signature;
      console.log(`     [Leg1] ✓ ${leg1Result.signature.slice(0, 20)}... (${leg1Result.latencyMs}ms)`);

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

      // ── Execute Leg 2 ──
      console.log(`     [Leg2] Sending via Helius...`);
      const leg2Result = await sendWithHelius(connection, leg2Tx, owner, priorityFee);
      record.leg2Sig = leg2Result.signature;
      console.log(`     [Leg2] ✓ ${leg2Result.signature.slice(0, 20)}... (${leg2Result.latencyMs}ms)`);

      // ── Calculate realized profit ──
      const postUsdc = await getUsdcBalance(connection, ownerPub);
      const realizedProfitUnits = postUsdc - preUsdc;
      const realizedProfitUsdc = Number(realizedProfitUnits) / 1e6;
      const realizedBps = Number(((realizedProfitUsdc / NOTIONAL_USDC) * 10_000).toFixed(2));

      record.success = true;
      record.realizedBps = realizedBps;
      record.realizedProfitUsdc = realizedProfitUsdc;
      record.latencyMs = Date.now() - t0;

      // Estimate fees: ~5000 lamports base + priority fee per tx
      const baseFeePerTx = 5000; // lamports
      const computeUnits = 200_000;
      const priorityFeeLamports = (priorityFee * computeUnits) / 1_000_000;
      const totalFeeLamports = (baseFeePerTx + priorityFeeLamports) * 2; // 2 legs
      record.feeSol = totalFeeLamports / 1e9;
      record.feeUsdc = record.feeSol * 140; // SOL @ $140

      console.log(`     ✅ SUCCESS`);
      console.log(`        Realized: ${realizedBps.toFixed(1)} bps ($${realizedProfitUsdc.toFixed(4)})`);
      console.log(`        Latency: ${record.latencyMs}ms`);
      console.log(`        Fee: $${record.feeUsdc.toFixed(4)}`);

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
  console.log(`  Stage4.2 Helius Execution Summary`);
  console.log(`  ═══════════════════════════════════════════════════════════════\n`);

  if (trades.length === 0) {
    console.log(`  ⚠️ No trades executed. Test inconclusive.`);
    console.log(`  Reason: No edge ≥${TRIGGER_BPS} bps found within ${MAX_TICKS_NO_EDGE} ticks.`);
    process.exit(1);
  }

  const successTrades = trades.filter((t) => t.success);
  const failedTrades = trades.filter((t) => !t.success);
  const realizedBpsValues = successTrades.map((t) => t.realizedBps ?? 0);
  const latencyValues = successTrades.map((t) => t.latencyMs ?? 0);
  const medianBps = median(realizedBpsValues);
  const avgBps = avg(realizedBpsValues);
  const avgLatency = avg(latencyValues);
  const failRate = failedTrades.length / trades.length;

  const totalProfit = successTrades.reduce((sum, t) => sum + (t.realizedProfitUsdc ?? 0), 0);
  const totalFees = successTrades.reduce((sum, t) => sum + (t.feeUsdc ?? 0), 0);
  const netProfit = totalProfit - totalFees;

  // Gate evaluation: PASS if median(realizedBps) > 0
  const pass = medianBps > 0;
  const gate = pass ? "PASS" : "FAIL";
  const gateReason = pass
    ? `median(realizedBps) = ${medianBps.toFixed(1)} bps > 0 → Helius execution viable`
    : `median(realizedBps) = ${medianBps.toFixed(1)} bps ≤ 0 → Route economically non-viable`;

  const summary: Stage4Summary = {
    generatedAt: new Date().toISOString(),
    testName: "Stage4.2 Helius Execution",
    execPath: "Helius Priority Fee + sendTransaction",
    totalTrades: trades.length,
    successCount: successTrades.length,
    failCount: failedTrades.length,
    failRate,
    medianRealizedBps: medianBps,
    avgRealizedBps: avgBps,
    totalProfitUsdc: totalProfit,
    totalFeesUsdc: totalFees,
    netProfitUsdc: netProfit,
    avgLatencyMs: avgLatency,
    gate,
    gateReason,
  };

  console.log(`  Test:              ${summary.testName}`);
  console.log(`  Exec path:         ${summary.execPath}`);
  console.log(`  Total trades:      ${summary.totalTrades}`);
  console.log(`  Success:           ${summary.successCount}`);
  console.log(`  Failed:            ${summary.failCount} (${(summary.failRate * 100).toFixed(0)}%)`);
  console.log(`  Median realized:   ${summary.medianRealizedBps.toFixed(1)} bps`);
  console.log(`  Avg realized:      ${summary.avgRealizedBps.toFixed(1)} bps`);
  console.log(`  Avg latency:       ${summary.avgLatencyMs.toFixed(0)}ms`);
  console.log(`  Total profit:      $${summary.totalProfitUsdc.toFixed(4)}`);
  console.log(`  Total fees:        $${summary.totalFeesUsdc.toFixed(4)}`);
  console.log(`  Net profit:        $${summary.netProfitUsdc.toFixed(4)}`);
  console.log(`\n  ══════════════════════════════════════════════════════════════`);
  console.log(`  GATE: ${gate}`);
  console.log(`  ${gateReason}`);
  console.log(`  ══════════════════════════════════════════════════════════════\n`);

  // Per-trade breakdown
  console.log(`  ── Trade Breakdown ──`);
  console.log(`  ${'#'.padEnd(3)} ${'Symbol'.padEnd(8)} ${'Dir'.padEnd(6)} ${'QuotedBps'.padEnd(10)} ${'RealizedBps'.padEnd(12)} ${'Fee$'.padEnd(8)} ${'LatencyMs'.padEnd(10)} ${'Status'.padEnd(8)}`);
  for (const t of trades) {
    const status = t.success ? '✓' : `✗ ${t.failReason?.slice(0, 20) ?? ''}`;
    console.log(
      `  ${String(t.tradeId).padEnd(3)} ` +
      `${t.symbol.padEnd(8)} ` +
      `${t.direction.slice(0, 5).padEnd(6)} ` +
      `${t.quotedBps.toFixed(1).padEnd(10)} ` +
      `${(t.realizedBps?.toFixed(1) ?? 'N/A').padEnd(12)} ` +
      `${(t.feeUsdc?.toFixed(4) ?? 'N/A').padEnd(8)} ` +
      `${(t.latencyMs?.toString() ?? 'N/A').padEnd(10)} ` +
      `${status}`
    );
  }

  // Write summary
  const summaryFile = path.join(outputDir, "stage4_2_summary.json");
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`\n  📝 Summary: ${summaryFile}`);
  console.log(`  📝 Trades:  ${tradesFile}\n`);

  // Exit code based on gate
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Stage4.2 failed:", err);
  process.exit(1);
});
