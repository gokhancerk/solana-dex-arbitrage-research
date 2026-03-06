/**
 * Stage5 — Atomic Arb TX
 *
 * Execute both legs in a single VersionedTransaction for true atomic arbitrage.
 *
 * Structure:
 *   ComputeBudget (priority fee + compute units)
 *   Setup instructions (ATA creation, etc.)
 *   Swap1: Orca (USDC → TOKEN)
 *   Swap2: Raydium (TOKEN → USDC)
 *   Cleanup instructions
 *
 * Advantages:
 *   - No stale quote problem
 *   - No bundle required
 *   - No private relay required
 *   - True atomic execution (all-or-nothing)
 *
 * Gate:
 *   - TX success rate > 80%
 *   - median(realizedBps) > 0
 *   - PASS → production candidate
 *   - FAIL → route saturated
 *
 * Usage:
 *   npx tsx src/scripts/stage5_atomic.ts
 *   npm run stage5:atomic
 */

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { loadConfig } from "../config.js";
import { getConnection } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, fetchJupiterSwapInstructions, JupiterRouteInfo } from "../jupiter.js";
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
//  Stage5 Constants
// ══════════════════════════════════════════════════════════════

const NOTIONAL_USDC = 15;             // $15 trade
const MAX_TRADES = 3;                 // 3 trades for infra test
const TRIGGER_BPS = -10;              // INFRA TEST: lowered (production: 10)
const POLL_MS = 3_000;                // Poll interval
const SLIPPAGE_BPS = 100;             // 1% slippage
const MAX_TICKS_NO_EDGE = 100;        // Max ticks without edge
const COMPUTE_UNITS = 400_000;        // Higher for merged TX

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
  quotedBps: number;
  quotedProfitUsdc: number;
  success: boolean;
  failReason?: string;
  realizedBps?: number;
  realizedProfitUsdc?: number;
  priorityFeeMicroLamports?: number;
  feeSol?: number;
  feeUsdc?: number;
  latencyMs?: number;
  signature?: string;
  isAtomic: boolean;
}

interface Stage5Summary {
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
//  Helius Priority Fee
// ══════════════════════════════════════════════════════════════

async function getHeliusPriorityFee(rpcUrl: string): Promise<number> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "priority-fee",
        method: "getPriorityFeeEstimate",
        params: [{ options: { priorityLevel: "High" } }],
      }),
    });

    const result = await response.json();
    if (result.result?.priorityFeeEstimate) {
      return Math.ceil(result.result.priorityFeeEstimate);
    }
    return 50_000;
  } catch {
    return 50_000;
  }
}

// ══════════════════════════════════════════════════════════════
//  Load Address Lookup Tables
// ══════════════════════════════════════════════════════════════

async function loadAddressLookupTables(
  connection: Connection,
  addresses: string[]
): Promise<AddressLookupTableAccount[]> {
  const uniqueAddresses = [...new Set(addresses)];
  const accounts: AddressLookupTableAccount[] = [];

  for (const addr of uniqueAddresses) {
    try {
      const pubkey = new PublicKey(addr);
      const response = await connection.getAddressLookupTable(pubkey);
      if (response.value) {
        accounts.push(response.value);
      }
    } catch (err) {
      console.log(`  ⚠ Failed to load ALT: ${addr}`);
    }
  }

  return accounts;
}

// ══════════════════════════════════════════════════════════════
//  Build Atomic Arb Transaction
// ══════════════════════════════════════════════════════════════

async function buildAtomicArbTx(
  connection: Connection,
  owner: PublicKey,
  leg1Route: JupiterRouteInfo,
  leg2Route: JupiterRouteInfo,
  priorityFee: number
): Promise<{ tx: VersionedTransaction; altAccounts: AddressLookupTableAccount[] }> {
  // Fetch swap instructions for both legs
  console.log("     [Build] Fetching Leg1 instructions...");
  const leg1Ix = await fetchJupiterSwapInstructions({
    route: leg1Route,
    userPublicKey: owner,
    wrapAndUnwrapSol: true,
  });

  console.log("     [Build] Fetching Leg2 instructions...");
  const leg2Ix = await fetchJupiterSwapInstructions({
    route: leg2Route,
    userPublicKey: owner,
    wrapAndUnwrapSol: true,
  });

  // Load all address lookup tables
  const allAltAddresses = [
    ...leg1Ix.addressLookupTableAddresses,
    ...leg2Ix.addressLookupTableAddresses,
  ];
  console.log(`     [Build] Loading ${allAltAddresses.length} ALT addresses...`);
  const altAccounts = await loadAddressLookupTables(connection, allAltAddresses);
  console.log(`     [Build] Loaded ${altAccounts.length} ALT accounts`);

  // Build compute budget instructions
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: COMPUTE_UNITS,
  });

  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: priorityFee,
  });

  // Merge all instructions in order:
  // 1. Compute budget
  // 2. Leg1 setup
  // 3. Leg1 swap
  // 4. Leg1 cleanup (optional)
  // 5. Leg2 setup
  // 6. Leg2 swap
  // 7. Leg2 cleanup (optional)
  const instructions: TransactionInstruction[] = [
    computeBudgetIx,
    priorityFeeIx,
    ...leg1Ix.setupInstructions,
    leg1Ix.swapInstruction,
    ...(leg1Ix.cleanupInstruction ? [leg1Ix.cleanupInstruction] : []),
    ...leg2Ix.setupInstructions,
    leg2Ix.swapInstruction,
    ...(leg2Ix.cleanupInstruction ? [leg2Ix.cleanupInstruction] : []),
  ];

  console.log(`     [Build] Total instructions: ${instructions.length}`);

  // Get fresh blockhash
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Build versioned transaction with ALTs
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(altAccounts);

  const tx = new VersionedTransaction(message);

  return { tx, altAccounts };
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stage5 — Atomic Arb TX ($${NOTIONAL_USDC} × ${MAX_TRADES} trades)               ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

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
  console.log(`  Exec path:     ATOMIC (single TX with merged instructions)`);
  console.log(`  Compute:       ${COMPUTE_UNITS.toLocaleString()} units`);

  // Check balance
  const usdcBalance = await getUsdcBalance(connection, ownerPub);
  const usdcBalanceNum = Number(usdcBalance) / 1e6;
  console.log(`  USDC Balance:  $${usdcBalanceNum.toFixed(2)}`);

  if (usdcBalanceNum < NOTIONAL_USDC * 1.5) {
    console.error(`\n  ✗ Insufficient USDC balance. Need at least $${(NOTIONAL_USDC * 1.5).toFixed(2)}`);
    process.exit(1);
  }

  // Load pairs
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

  // Filter pairs
  const allowedSymbols = new Set(["SOL", "mSOL", "whETH"]);
  pairs = pairs.filter((p) => allowedSymbols.has(p.baseSymbol));

  console.log(`  Pairs:         ${pairs.length}`);
  console.log(`\n  ⏱  Starting atomic execution loop...\n`);

  // Output setup
  const outputDir = "archive/20260306_stage5_atomic";
  await fs.mkdir(outputDir, { recursive: true });
  const tradesFile = path.join(outputDir, "trades.jsonl");

  // Trade loop
  const trades: TradeRecord[] = [];
  let tradeCount = 0;
  let tick = 0;
  let noEdgeTicks = 0;

  while (tradeCount < MAX_TRADES) {
    tick++;
    noEdgeTicks++;

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
    } catch {
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
            const buyResult = await quoteOrcaExactIn(
              USDC_MINT,
              pair.baseMint,
              notionalUnits,
              jupiterApiKey
            );

            if (!buyResult.ok || buyResult.outAmountUnits <= 0n) continue;

            const sellResult = quoteRaydiumCpmmExactIn(
              reserves!,
              pair.baseMint,
              buyResult.outAmountUnits
            );

            if (!sellResult.ok) continue;

            const grossProfit = sellResult.outAmountUnits - notionalUnits;
            const netProfit = grossProfit - BUFFER_USDC_UNITS;
            const netProfitBps = Number(
              ((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2)
            );

            candidates.push({
              pair,
              direction,
              netProfitBps,
              netProfitUsdc: Number(netProfit) / 1e6,
            });
          } else {
            const buyResult = quoteRaydiumCpmmExactIn(reserves!, USDC_MINT, notionalUnits);

            if (!buyResult.ok || buyResult.outAmountUnits <= 0n) continue;

            const sellResult = await quoteOrcaExactIn(
              pair.baseMint,
              USDC_MINT,
              buyResult.outAmountUnits,
              jupiterApiKey
            );

            if (!sellResult.ok) continue;

            const grossProfit = sellResult.outAmountUnits - notionalUnits;
            const netProfit = grossProfit - BUFFER_USDC_UNITS;
            const netProfitBps = Number(
              ((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2)
            );

            candidates.push({
              pair,
              direction,
              netProfitBps,
              netProfitUsdc: Number(netProfit) / 1e6,
            });
          }
        } catch {
          // Quote failed
        }
      }
    }

    const bestEdge = candidates.reduce(
      (best, curr) => (curr.netProfitBps > best.netProfitBps ? curr : best),
      { netProfitBps: -Infinity } as EdgeCandidate
    );

    if (bestEdge.netProfitBps < TRIGGER_BPS) {
      console.log(
        `  [Tick ${tick}] Best edge: ${bestEdge.netProfitBps?.toFixed(1) ?? "N/A"} bps ` +
          `(need ≥${TRIGGER_BPS}) — waiting...`
      );
      await sleep(POLL_MS);
      continue;
    }

    // Reset counter
    noEdgeTicks = 0;

    // ══════════════════════════════════════════════════════════════
    //  Execute Atomic Trade
    // ══════════════════════════════════════════════════════════════

    tradeCount++;
    const tradeId = tradeCount;
    const t0 = Date.now();

    console.log(`\n  ══════════════════════════════════════════════════════════════`);
    console.log(`  🚀 Trade #${tradeId}: ${bestEdge.pair.baseSymbol} ${bestEdge.direction} [ATOMIC]`);
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
      isAtomic: true,
    };

    try {
      // Get priority fee
      const priorityFee = await getHeliusPriorityFee(rpcUrl);
      record.priorityFeeMicroLamports = priorityFee;
      console.log(`     Priority fee: ${priorityFee} micro-lamports`);

      // Get pre-trade balance
      const preUsdc = await getUsdcBalance(connection, ownerPub);

      // Determine direction
      const isOrcaFirst = bestEdge.direction === "O_TO_R";
      const leg1Dex = isOrcaFirst ? "Whirlpool" : "Raydium,RaydiumCLMM,RaydiumCP";
      const leg2Dex = isOrcaFirst ? "Raydium,RaydiumCLMM,RaydiumCP" : "Whirlpool";

      // Get leg1 quote (USDC → TOKEN)
      console.log(`     [Quote] Leg1: ${isOrcaFirst ? "Orca" : "Raydium"} (USDC→TOKEN)...`);
      const leg1Quote = await fetchJupiterQuote({
        inputMint: USDC_MINT,
        outputMint: bestEdge.pair.baseMint,
        amount: notionalUnits,
        slippageBps: SLIPPAGE_BPS,
        dexes: leg1Dex,
      });

      const leg1ExpectedOut = leg1Quote.meta.expectedOut;

      // Get leg2 quote (TOKEN → USDC)
      console.log(`     [Quote] Leg2: ${isOrcaFirst ? "Raydium" : "Orca"} (TOKEN→USDC)...`);
      const leg2Quote = await fetchJupiterQuote({
        inputMint: bestEdge.pair.baseMint,
        outputMint: USDC_MINT,
        amount: leg1ExpectedOut,
        slippageBps: SLIPPAGE_BPS,
        dexes: leg2Dex,
      });

      // Build atomic TX
      console.log(`     [Build] Creating atomic TX with merged instructions...`);
      const { tx, altAccounts } = await buildAtomicArbTx(
        connection,
        ownerPub,
        leg1Quote.route,
        leg2Quote.route,
        priorityFee
      );

      // Sign
      tx.sign([owner]);

      // Send
      console.log(`     [Send] Executing atomic TX...`);
      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });
      record.signature = signature;
      console.log(`     [Send] TX: ${signature.slice(0, 20)}...`);

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(`TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      // Calculate realized profit
      const postUsdc = await getUsdcBalance(connection, ownerPub);
      const realizedProfitUnits = postUsdc - preUsdc;
      const realizedProfitUsdc = Number(realizedProfitUnits) / 1e6;
      const realizedBps = Number(((realizedProfitUsdc / NOTIONAL_USDC) * 10_000).toFixed(2));

      record.success = true;
      record.realizedBps = realizedBps;
      record.realizedProfitUsdc = realizedProfitUsdc;
      record.latencyMs = Date.now() - t0;

      // Estimate fees
      const baseFee = 5000;
      const priorityFeeLamports = (priorityFee * COMPUTE_UNITS) / 1_000_000;
      record.feeSol = (baseFee + priorityFeeLamports) / 1e9;
      record.feeUsdc = record.feeSol * 140;

      console.log(`     ✅ ATOMIC SUCCESS`);
      console.log(`        Realized: ${realizedBps.toFixed(1)} bps ($${realizedProfitUsdc.toFixed(4)})`);
      console.log(`        Latency: ${record.latencyMs}ms`);
      console.log(`        Fee: $${record.feeUsdc.toFixed(4)}`);
      console.log(`        🔗 https://solscan.io/tx/${signature}`);
    } catch (err) {
      record.success = false;
      record.failReason = err instanceof Error ? err.message : String(err);
      record.latencyMs = Date.now() - t0;

      console.log(`     ❌ FAILED: ${record.failReason}`);
    }

    // Log trade
    trades.push(record);
    await fs.appendFile(tradesFile, JSON.stringify(record) + "\n");

    await sleep(2000);
  }

  // ══════════════════════════════════════════════════════════════
  //  Summary
  // ══════════════════════════════════════════════════════════════

  console.log(`\n  ═══════════════════════════════════════════════════════════════`);
  console.log(`  Stage5 Atomic Execution Summary`);
  console.log(`  ═══════════════════════════════════════════════════════════════\n`);

  if (trades.length === 0) {
    console.log(`  ⚠️ No trades executed. Test inconclusive.`);
    process.exit(1);
  }

  const successTrades = trades.filter((t) => t.success);
  const failedTrades = trades.filter((t) => !t.success);
  const realizedBpsValues = successTrades.map((t) => t.realizedBps ?? 0);
  const latencyValues = successTrades.map((t) => t.latencyMs ?? 0);
  const medianBps = median(realizedBpsValues);
  const avgBps = avg(realizedBpsValues);
  const avgLatency = avg(latencyValues);
  const successRate = successTrades.length / trades.length;
  const failRate = failedTrades.length / trades.length;

  const totalProfit = successTrades.reduce((sum, t) => sum + (t.realizedProfitUsdc ?? 0), 0);
  const totalFees = successTrades.reduce((sum, t) => sum + (t.feeUsdc ?? 0), 0);
  const netProfit = totalProfit - totalFees;

  // Gate: success rate > 80% AND median(realizedBps) > 0
  const pass = successRate > 0.8 && medianBps > 0;
  const gate = pass ? "PASS" : "FAIL";
  const gateReason = pass
    ? `successRate(${(successRate * 100).toFixed(0)}%) > 80% AND median(${medianBps.toFixed(1)}bps) > 0 → PRODUCTION CANDIDATE`
    : successRate <= 0.8
    ? `successRate(${(successRate * 100).toFixed(0)}%) ≤ 80% → Execution issues`
    : `median(${medianBps.toFixed(1)}bps) ≤ 0 → Route saturated`;

  const summary: Stage5Summary = {
    generatedAt: new Date().toISOString(),
    testName: "Stage5 Atomic Arb TX",
    execPath: "Atomic (merged instructions, single TX)",
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
  console.log(`  Success:           ${summary.successCount} (${(successRate * 100).toFixed(0)}%)`);
  console.log(`  Failed:            ${summary.failCount}`);
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

  // Trade breakdown
  console.log(`  ── Trade Breakdown ──`);
  for (const t of trades) {
    const status = t.success ? "✓" : `✗ ${t.failReason?.slice(0, 30) ?? ""}`;
    console.log(
      `  #${t.tradeId} ${t.symbol.padEnd(6)} ${t.direction.slice(0, 5)} ` +
        `Q:${t.quotedBps.toFixed(0)}bps R:${t.realizedBps?.toFixed(0) ?? "N/A"}bps ` +
        `${t.latencyMs ?? 0}ms ${status}`
    );
  }

  // Save summary
  const summaryFile = path.join(outputDir, "stage5_summary.json");
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`\n  📝 Summary: ${summaryFile}`);
  console.log(`  📝 Trades:  ${tradesFile}\n`);

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Stage5 failed:", err);
  process.exit(1);
});
