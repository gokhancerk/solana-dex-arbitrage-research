/**
 * EXPERIMENT_D_READY — Type C Research Mode (per-cycle pair scanner)
 *
 * Iterates candidate pairs from data/candidatePairs.json, classifies each
 * via market filter, fetches Jupiter round-trip quotes, builds + simulates
 * transactions, and optionally runs Jito bundle prep (dry).
 *
 * Every cycle produces a deterministic JSONL record to data/telemetry/trades.jsonl.
 *
 * Runtime flags:
 *   DRY_RUN=true  MODE=EXPERIMENT_D_READY  JITO_PREP=true  SIMULATE=true
 *
 * Usage:
 *   MODE=EXPERIMENT_D_READY npm start
 */

import { performance } from "perf_hooks";
import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";

import { loadConfig } from "./config.js";
import { loadCandidatePairs, type CandidatePair } from "./candidatePairProvider.js";
import { classifyMarketByMint } from "./marketFilter.js";
import { fetchJupiterQuote, buildJupiterSwap, simulateJupiterTx } from "./jupiter.js";
import { getConnection } from "./solana.js";
import { toRaw, fromRaw } from "./tokens.js";
import { getKeypairFromEnv } from "./wallet.js";
import { suggestPriorityFee } from "./fees.js";
import { prepareAtomicBundle, JitoPrepError, JitoPrepSkip } from "./jito.js";
import type {
  MarketClassification,
  ExperimentDReadyRecord,
  ExperimentDReadyStatus,
  ExperimentDJitoPrep,
  JitoPrepErrorStage,
  JitoPrepSkipReason,
  SimulationOutcome,
} from "./types.js";

// ── Output paths ──
const DATA_DIR = path.resolve(process.cwd(), "data", "telemetry");
const TRADES_FILE = path.join(DATA_DIR, "trades.jsonl");

let dataDirEnsured = false;
async function ensureDataDir(): Promise<void> {
  if (dataDirEnsured) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  dataDirEnsured = true;
}

async function appendRecord(record: ExperimentDReadyRecord): Promise<void> {
  await ensureDataDir();
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(TRADES_FILE, line, "utf-8");
}

// ── Fee estimation helpers (mirrored from execution.ts) ──
const BASE_FEE_LAMPORTS = 5_000;
const ASSUMED_CU_PER_TX = 200_000;

function estimateTxFeeSol(priorityFeeMicro: number, legCount: number): number {
  const priorityLamports = (priorityFeeMicro * ASSUMED_CU_PER_TX) / 1_000_000;
  const perTx = BASE_FEE_LAMPORTS + priorityLamports;
  return (perTx * legCount) / 1e9;
}

// ── Main cycle runner ──

export interface ExperimentDReadyOptions {
  /** Seconds between full scan cycles (default: 30) */
  cycleSleepSec?: number;
  /** Max cycles to run (0 = infinite, default: 0) */
  maxCycles?: number;
  /** Per-pair delay in ms to avoid rate limits (default: 1500) */
  pairDelayMs?: number;
}

/**
 * Start the EXPERIMENT_D_READY scanner loop.
 * Returns when maxCycles is reached or process is interrupted.
 */
export async function runExperimentDReady(opts: ExperimentDReadyOptions = {}): Promise<void> {
  const cycleSleep = (opts.cycleSleepSec ?? 30) * 1000;
  const maxCycles = opts.maxCycles ?? 0;
  const pairDelayMs = opts.pairDelayMs ?? 1500;

  const cfg = loadConfig();
  const owner: Keypair = getKeypairFromEnv();
  const ownerPub = owner.publicKey;
  const notionalUsdc = Number(process.env.TRADE_AMOUNT_USDC ?? cfg.notionalCapUsd);
  const minNetProfit = cfg.minNetProfitUsdc;
  const solUsdcRate = cfg.solUsdcRate;
  const slippageBps = cfg.slippageBps;
  const doJitoPrep = cfg.experimentJitoPrep;

  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗\n` +
    `║  EXPERIMENT_D_READY — Type C Research Mode                  ║\n` +
    `║  DRY_RUN=true  JITO_PREP=${doJitoPrep}  SIMULATE=true        ║\n` +
    `║  Notional: ${notionalUsdc} USDC | MinProfit: ${minNetProfit} USDC   ║\n` +
    `║  Output: ${TRADES_FILE}                                     ║\n` +
    `╚══════════════════════════════════════════════════════════════╝\n`
  );

  const pairs = await loadCandidatePairs();
  let cycle = 0;
  let running = true;

  const shutdown = () => { running = false; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    cycle++;
    if (maxCycles > 0 && cycle > maxCycles) break;

    console.log(`\n[EXPERIMENT_D_READY] ═══ Cycle ${cycle} başlıyor (${pairs.length} pair) ═══`);

    // Per-cycle stats accumulators
    const cycleRecords: ExperimentDReadyRecord[] = [];

    for (const pair of pairs) {
      if (!running) break;

      try {
        const record = await processPair(pair, {
          owner,
          ownerPub,
          notionalUsdc,
          minNetProfit,
          solUsdcRate,
          slippageBps,
          doJitoPrep,
        });

        // Attach poolMeta from v2 discovery if available
        if (pair.poolMeta) {
          record.poolMeta = {
            sourceDex: pair.poolMeta.sourceDex,
            poolType: pair.poolMeta.poolType,
            poolId: pair.poolMeta.poolId,
            feeBps: pair.poolMeta.feeBps,
            liqUsd: pair.poolMeta.poolLiquidityUsd,
            vol24hUsd: pair.poolMeta.poolVolume24hUsd,
            isDirectUsdcPool: pair.poolMeta.isDirectUsdcPool,
          };
        }

        await appendRecord(record);
        cycleRecords.push(record);

        const statusEmoji = record.status === "READY" ? "✓" : record.status === "REJECTED" ? "✗" : record.status === "NO_OPP" ? "○" : "⚠";
        console.log(
          `[EXPERIMENT_D_READY] ${statusEmoji} ${pair.baseSymbol ?? pair.baseMint.slice(0, 8)}/USDC → ` +
          `status=${record.status} | profit=${record.opportunity.expectedNetProfitUsdc.toFixed(4)} | ` +
          `D2S=${record.latencyMetrics.detectToSendLatencyMs}ms | ` +
          `routes=${record.marketClassification.routeMarkets}`
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[EXPERIMENT_D_READY] FATAL pair error (${pair.baseSymbol}): ${reason}`);
        // Write ERROR record
        const errRecord = buildErrorRecord(pair, reason, notionalUsdc, minNetProfit);
        await appendRecord(errRecord);
        cycleRecords.push(errRecord);
      }

      // Rate-limit delay between pairs
      if (pairDelayMs > 0) {
        await new Promise((r) => setTimeout(r, pairDelayMs));
      }
    }

    // ── Cycle Summary (v2.1) ──
    printCycleSummary(cycle, cycleRecords);

    console.log(`[EXPERIMENT_D_READY] ═══ Cycle ${cycle} tamamlandı ═══`);

    if (maxCycles > 0 && cycle >= maxCycles) break;
    if (running) {
      console.log(`[EXPERIMENT_D_READY] Sonraki cycle ${cycleSleep / 1000}s sonra…`);
      await new Promise((r) => setTimeout(r, cycleSleep));
    }
  }

  console.log(`[EXPERIMENT_D_READY] Scanner durduruldu. Toplam cycle: ${cycle}`);
}

// ── Cycle Summary (v2.1) ──

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function printCycleSummary(cycle: number, records: ExperimentDReadyRecord[]): void {
  if (records.length === 0) return;

  // Status distribution
  const statusCounts: Record<string, number> = {};
  for (const r of records) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  // RouteMarkets histogram (from non-ERROR records that have classification)
  const routeMarketsHist: Record<number, number> = {};
  const routeMarketsValues: number[] = [];
  let complexRouteCount = 0;

  for (const r of records) {
    if (r.status === "ERROR") continue;
    const rm = r.marketClassification.routeMarkets;
    if (rm > 0) {
      routeMarketsHist[rm] = (routeMarketsHist[rm] ?? 0) + 1;
      routeMarketsValues.push(rm);
    }
    if (r.marketClassification.complexRoute) complexRouteCount++;
  }

  routeMarketsValues.sort((a, b) => a - b);
  const totalWithRoute = routeMarketsValues.length;
  const routeLe3 = routeMarketsValues.filter((v) => v <= 3).length;
  const routeGe5 = routeMarketsValues.filter((v) => v >= 5).length;
  const pctLe3 = totalWithRoute > 0 ? ((routeLe3 / totalWithRoute) * 100).toFixed(1) : "0.0";
  const pctGe5 = totalWithRoute > 0 ? ((routeGe5 / totalWithRoute) * 100).toFixed(1) : "0.0";
  const p95Route = percentile(routeMarketsValues, 95);

  // D2S (detect-to-send) latency stats
  const d2sValues: number[] = [];
  for (const r of records) {
    const d2s = r.latencyMetrics.detectToSendLatencyMs;
    if (d2s > 0) d2sValues.push(d2s);
  }
  d2sValues.sort((a, b) => a - b);
  const avgD2S = d2sValues.length > 0 ? Math.round(d2sValues.reduce((s, v) => s + v, 0) / d2sValues.length) : 0;
  const p95D2S = percentile(d2sValues, 95);

  // Eligibility count
  const eligibleCount = records.filter((r) => r.marketClassification.eligible).length;
  const softlistCount = records.filter((r) => r.status === "NO_OPP" || r.status === "READY").length;

  // Pool type distribution (v2 records with poolMeta)
  const poolTypeCounts: Record<string, number> = {};
  for (const r of records) {
    const pt = r.poolMeta?.poolType ?? "unknown";
    poolTypeCounts[pt] = (poolTypeCounts[pt] ?? 0) + 1;
  }

  console.log(`\n─── Cycle ${cycle} Summary ────────────────────────────────────`);
  console.log(`  Total records:    ${records.length}`);
  console.log(`  Status:           ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  Eligible:         ${eligibleCount}/${records.length}`);
  console.log(`  Softlist (NO_OPP+READY): ${softlistCount}`);

  console.log(`\n  RouteMarkets Histogram:`);
  for (const rm of Object.keys(routeMarketsHist).map(Number).sort((a, b) => a - b)) {
    const count = routeMarketsHist[rm];
    const bar = "█".repeat(Math.min(count, 40));
    console.log(`    routes=${rm}: ${String(count).padStart(4)} ${bar}`);
  }
  console.log(`  p95RouteMarkets:    ${p95Route}`);
  console.log(`  pctRouteMarkets≤3:  ${pctLe3}% (${routeLe3}/${totalWithRoute})`);
  console.log(`  pctRouteMarkets≥5:  ${pctGe5}% (${routeGe5}/${totalWithRoute})`);
  console.log(`  complexRoute=true:  ${complexRouteCount}`);

  console.log(`\n  D2S Latency:`);
  console.log(`    avgD2S:  ${avgD2S}ms`);
  console.log(`    p95D2S:  ${Math.round(p95D2S)}ms`);

  if (Object.keys(poolTypeCounts).length > 1 || !poolTypeCounts["unknown"]) {
    console.log(`\n  Pool Types: ${Object.entries(poolTypeCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`──────────────────────────────────────────────────────────\n`);
}

// ── Per-pair processing ──

interface ProcessContext {
  owner: Keypair;
  ownerPub: import("@solana/web3.js").PublicKey;
  notionalUsdc: number;
  minNetProfit: number;
  solUsdcRate: number;
  slippageBps: number;
  doJitoPrep: boolean;
}

async function processPair(
  pair: CandidatePair,
  ctx: ProcessContext,
): Promise<ExperimentDReadyRecord> {
  const tag = `${pair.baseSymbol ?? pair.baseMint.slice(0, 8)}/USDC`;
  const ts = Date.now();
  const detectSlot = 0; // We don't use slot driver in this mode
  const detectTimestamp = ts;
  let quoteReceivedTimestamp = 0;
  let quoteLatencyMs = 0;
  let buildLatencyMs = 0;
  let simulationLatencyMs = 0;

  // ── Step 1: Market Classification ──
  const classStart = performance.now();
  let mc: MarketClassification;
  try {
    mc = await classifyMarketByMint(pair.baseMint, pair.quoteMint, pair.quoteDecimals, tag);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return buildErrorRecord(pair, `classification_failed: ${reason}`, ctx.notionalUsdc, ctx.minNetProfit);
  }
  const classMs = Math.round(performance.now() - classStart);

  // ── Step 2: Jupiter round-trip quotes (USDC→BASE→USDC) ──
  // Always fetch quotes (even for REJECTED) to populate opportunity data for research.
  const quoteStart = performance.now();
  const amountRaw = toRaw(ctx.notionalUsdc, pair.quoteDecimals);
  const cfg = loadConfig();

  let leg1ExpectedOut: bigint;
  let leg2ExpectedOut: bigint;
  let leg1Route: any;
  let leg2Route: any;
  let quoteFailed = false;

  try {
    // Leg 1: USDC → BASE
    const { route: r1, meta: m1 } = await fetchJupiterQuote({
      inputMint: pair.quoteMint,
      outputMint: pair.baseMint,
      amount: amountRaw,
      slippageBps: ctx.slippageBps,
    });
    leg1ExpectedOut = m1.expectedOut;
    leg1Route = r1;

    // Leg 2: BASE → USDC
    const { route: r2, meta: m2 } = await fetchJupiterQuote({
      inputMint: pair.baseMint,
      outputMint: pair.quoteMint,
      amount: m1.expectedOut,
      slippageBps: ctx.slippageBps,
    });
    leg2ExpectedOut = m2.expectedOut;
    leg2Route = r2;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // If filter already rejected, return REJECTED with the quote error info
    if (!mc.eligible) {
      return buildRecord(pair, "REJECTED", mc, {
        notionalUsdc: ctx.notionalUsdc,
        direction: "BUY_BASE_SELL_QUOTE",
        expectedNetProfitUsdc: 0,
        minNetProfitUsdc: ctx.minNetProfit,
        profitDriftUsdc: null,
        simulatedOutAmountUsdc: null,
      }, {
        detectSlot, detectTimestamp, quoteReceivedTimestamp: 0,
        quoteLatencyMs: Math.round(performance.now() - quoteStart),
        buildLatencyMs: 0, simulationLatencyMs: 0,
        detectToSendLatencyMs: Math.round(performance.now() - classStart),
        quoteToSendLatencyMs: 0, executionMode: "JITO_PREP",
      }, buildEmptyJitoPrep("DISABLED"));
    }
    return buildErrorRecord(pair, `quote_failed: ${reason}`, ctx.notionalUsdc, ctx.minNetProfit, mc);
  }

  quoteLatencyMs = Math.round(performance.now() - quoteStart);
  quoteReceivedTimestamp = Date.now();

  // ── Step 3: Net profit estimation ──
  const grossProfitRaw = leg2ExpectedOut - amountRaw;
  const grossProfitUsdc = Number(grossProfitRaw) / 10 ** pair.quoteDecimals;

  // Dynamic priority fee
  let dynamicFee = cfg.rpc.priorityFeeMicrolamports ?? 50_000;
  try {
    const connection = getConnection();
    const suggestion = await suggestPriorityFee(connection, cfg.maxPriorityFee);
    if (suggestion) dynamicFee = suggestion.priorityFeeMicrolamports;
  } catch { /* use default */ }

  const feeSol = estimateTxFeeSol(dynamicFee, 2);
  const feeUsdc = feeSol * ctx.solUsdcRate;
  const expectedNetProfitUsdc = grossProfitUsdc - feeUsdc;

  // ── Step 3b: Determine status based on eligibility + profit ──
  // REJECTED = market filter rejects (regardless of profit)
  // NO_OPP   = eligible but profit < min
  // READY    = eligible and profit >= min
  if (!mc.eligible) {
    // Filter rejected — record with full opportunity data from quotes
    return buildRecord(pair, "REJECTED", mc, {
      notionalUsdc: ctx.notionalUsdc,
      direction: "BUY_BASE_SELL_QUOTE",
      expectedNetProfitUsdc,
      minNetProfitUsdc: ctx.minNetProfit,
      profitDriftUsdc: null,
      simulatedOutAmountUsdc: fromRaw(leg2ExpectedOut, pair.quoteDecimals),
    }, {
      detectSlot, detectTimestamp, quoteReceivedTimestamp,
      quoteLatencyMs, buildLatencyMs: 0, simulationLatencyMs: 0,
      detectToSendLatencyMs: Date.now() - detectTimestamp,
      quoteToSendLatencyMs: Date.now() - quoteReceivedTimestamp,
      executionMode: "JITO_PREP",
    }, buildEmptyJitoPrep("DISABLED"));
  }

  // Eligible but profit below threshold → NO_OPP
  if (expectedNetProfitUsdc < ctx.minNetProfit) {
    return buildRecord(pair, "NO_OPP", mc, {
      notionalUsdc: ctx.notionalUsdc,
      direction: "BUY_BASE_SELL_QUOTE",
      expectedNetProfitUsdc,
      minNetProfitUsdc: ctx.minNetProfit,
      profitDriftUsdc: null,
      simulatedOutAmountUsdc: fromRaw(leg2ExpectedOut, pair.quoteDecimals),
    }, {
      detectSlot, detectTimestamp, quoteReceivedTimestamp,
      quoteLatencyMs, buildLatencyMs: 0, simulationLatencyMs: 0,
      detectToSendLatencyMs: Date.now() - detectTimestamp,
      quoteToSendLatencyMs: Date.now() - quoteReceivedTimestamp,
      executionMode: "JITO_PREP",
    }, buildEmptyJitoPrep("DISABLED"));
  }

  // ── Step 4: Build + Simulate ──
  const buildStart = performance.now();
  let leg1Tx: import("@solana/web3.js").VersionedTransaction;
  let leg2Tx: import("@solana/web3.js").VersionedTransaction;

  try {
    leg1Tx = await buildJupiterSwap({
      route: leg1Route,
      userPublicKey: ctx.ownerPub,
      priorityFeeMicroLamports: dynamicFee,
    });
    leg2Tx = await buildJupiterSwap({
      route: leg2Route,
      userPublicKey: ctx.ownerPub,
      priorityFeeMicroLamports: dynamicFee,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return buildErrorRecord(pair, `build_failed: ${reason}`, ctx.notionalUsdc, ctx.minNetProfit, mc);
  }
  buildLatencyMs = Math.round(performance.now() - buildStart);

  // Simulate both legs
  const simStart = performance.now();
  let sim1: SimulationOutcome;
  let sim2: SimulationOutcome;
  try {
    const connection = getConnection();
    [sim1, sim2] = await Promise.all([
      simulateJupiterTx(connection, leg1Tx),
      simulateJupiterTx(connection, leg2Tx),
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return buildErrorRecord(pair, `simulation_failed: ${reason}`, ctx.notionalUsdc, ctx.minNetProfit, mc);
  }
  simulationLatencyMs = Math.round(performance.now() - simStart);

  // Check simulation errors (warn but continue in dry-run)
  if (sim1.error) {
    console.warn(`[EXPERIMENT_D_READY] ${tag} Leg 1 sim error: ${sim1.error}`);
  }
  if (sim2.error) {
    console.warn(`[EXPERIMENT_D_READY] ${tag} Leg 2 sim error: ${sim2.error}`);
  }

  // ── Step 5: Jito Prep (optional) ──
  let jitoPrep: ExperimentDJitoPrep;

  if (ctx.doJitoPrep) {
    jitoPrep = await runJitoPrep(leg1Tx, leg2Tx, ctx.owner);
  } else {
    jitoPrep = buildEmptyJitoPrep("DISABLED");
  }

  // ── Step 6: Build READY record ──
  const endTimestamp = Date.now();

  return buildRecord(pair, "READY", mc, {
    notionalUsdc: ctx.notionalUsdc,
    direction: "BUY_BASE_SELL_QUOTE",
    expectedNetProfitUsdc,
    minNetProfitUsdc: ctx.minNetProfit,
    profitDriftUsdc: null, // no realized PnL in dry-run
    simulatedOutAmountUsdc: fromRaw(leg2ExpectedOut, pair.quoteDecimals),
  }, {
    detectSlot,
    detectTimestamp,
    quoteReceivedTimestamp,
    quoteLatencyMs,
    buildLatencyMs,
    simulationLatencyMs,
    detectToSendLatencyMs: endTimestamp - detectTimestamp,
    quoteToSendLatencyMs: endTimestamp - quoteReceivedTimestamp,
    executionMode: "JITO_PREP",
  }, jitoPrep);
}

// ── Jito Prep runner ──

async function runJitoPrep(
  leg1Tx: import("@solana/web3.js").VersionedTransaction,
  leg2Tx: import("@solana/web3.js").VersionedTransaction,
  signer: Keypair,
): Promise<ExperimentDJitoPrep> {
  try {
    const t0 = performance.now();
    const bundleData = await prepareAtomicBundle({ leg1Tx, leg2Tx, signer });
    const latencyMs = Math.round(performance.now() - t0);

    const sub = bundleData.prepTimings;
    const tipStats = bundleData.tipFetchStats;

    return {
      attempted: true,
      skippedReason: null,
      latencyMs,
      subTimings: {
        blockhashFetchMs: sub?.blockhashFetchMs ?? null,
        tipAccountsFetchMs: sub?.tipAccountsFetchMs ?? null,
        bundleBuildMs: sub?.bundleBuildMs ?? null,
      },
      retries: tipStats && tipStats.retries > 0 ? tipStats.retries : null,
      retryDelayMsTotal: tipStats && tipStats.retries > 0 ? tipStats.retryDelayMsTotal : null,
      errorStage: null,
      errorCode: null,
      errorMessage: null,
    };
  } catch (err: any) {
    if (err instanceof JitoPrepSkip) {
      return {
        attempted: true,
        skippedReason: err.reason,
        latencyMs: null,
        subTimings: {
          blockhashFetchMs: err.partialTimings?.blockhashFetchMs ?? null,
          tipAccountsFetchMs: err.partialTimings?.tipAccountsFetchMs ?? null,
          bundleBuildMs: err.partialTimings?.bundleBuildMs ?? null,
        },
        retries: null,
        retryDelayMsTotal: null,
        errorStage: null,
        errorCode: null,
        errorMessage: err.message?.slice(0, 300) ?? null,
      };
    }

    const stage: JitoPrepErrorStage = err instanceof JitoPrepError ? err.stage : "UNKNOWN";
    const code = err instanceof JitoPrepError ? err.code : (err.code ?? err.name ?? "UNKNOWN");

    return {
      attempted: true,
      skippedReason: "ERROR",
      latencyMs: null,
      subTimings: {
        blockhashFetchMs: (err instanceof JitoPrepError ? err.partialTimings?.blockhashFetchMs : null) ?? null,
        tipAccountsFetchMs: (err instanceof JitoPrepError ? err.partialTimings?.tipAccountsFetchMs : null) ?? null,
        bundleBuildMs: (err instanceof JitoPrepError ? err.partialTimings?.bundleBuildMs : null) ?? null,
      },
      retries: null,
      retryDelayMsTotal: null,
      errorStage: stage,
      errorCode: code,
      errorMessage: (err.message ?? String(err)).slice(0, 300),
    };
  }
}

// ── Record builders ──

function buildEmptyJitoPrep(reason: JitoPrepSkipReason): ExperimentDJitoPrep {
  return {
    attempted: false,
    skippedReason: reason,
    latencyMs: null,
    subTimings: { blockhashFetchMs: null, tipAccountsFetchMs: null, bundleBuildMs: null },
    retries: null,
    retryDelayMsTotal: null,
    errorStage: null,
    errorCode: null,
    errorMessage: null,
  };
}

function buildRecord(
  pair: CandidatePair,
  status: ExperimentDReadyStatus,
  mc: MarketClassification,
  opportunity: ExperimentDReadyRecord["opportunity"],
  latency: ExperimentDReadyRecord["latencyMetrics"],
  jitoPrep: ExperimentDJitoPrep,
): ExperimentDReadyRecord {
  return {
    ts: Date.now(),
    mode: "EXPERIMENT_D_READY",
    pairId: pair.pairId,
    baseMint: pair.baseMint,
    quoteMint: pair.quoteMint,
    baseSymbol: pair.baseSymbol,
    quoteSymbol: pair.quoteSymbol,
    status,
    marketClassification: {
      ...mc,
      eligible: mc.eligible,
      rejectReasons: mc.rejectReasons,
      complexRoute: mc.complexRoute ?? false,
    },
    opportunity,
    latencyMetrics: latency,
    jitoPrep,
  };
}

function buildErrorRecord(
  pair: CandidatePair,
  errorMessage: string,
  notionalUsdc: number,
  minNetProfit: number,
  mc?: MarketClassification,
): ExperimentDReadyRecord {
  const emptyMc: MarketClassification = mc ?? {
    type: "UNKNOWN",
    impact1k: 0,
    impact3k: 0,
    impact5k: 0,
    routeMarkets: 0,
    volume24h: 0,
    liquidity: 0,
    volumeLiquidityRatio: 0,
    slippageCurveRatio: 0,
    rejectReasons: [errorMessage],
    eligible: false,
  };

  const rec = buildRecord(pair, "ERROR", emptyMc, {
    notionalUsdc,
    direction: "BUY_BASE_SELL_QUOTE",
    expectedNetProfitUsdc: 0,
    minNetProfitUsdc: minNetProfit,
    profitDriftUsdc: null,
    simulatedOutAmountUsdc: null,
  }, {
    detectSlot: 0,
    detectTimestamp: Date.now(),
    quoteReceivedTimestamp: 0,
    quoteLatencyMs: 0,
    buildLatencyMs: 0,
    simulationLatencyMs: 0,
    detectToSendLatencyMs: 0,
    quoteToSendLatencyMs: 0,
    executionMode: "JITO_PREP",
  }, buildEmptyJitoPrep("DISABLED"));

  rec.errorMessage = errorMessage;
  return rec;
}
