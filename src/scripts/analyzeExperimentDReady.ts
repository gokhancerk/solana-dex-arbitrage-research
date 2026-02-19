/**
 * EXPERIMENT_D_READY — Offline Analysis Script
 *
 * Reads data/telemetry/trades.jsonl, filters EXPERIMENT_D_READY records,
 * computes per-pair scores, and produces whitelist/blacklist JSON files.
 *
 * Usage:
 *   npx tsx src/scripts/analyzeExperimentDReady.ts
 *
 * Output:
 *   - Console summary (counts, per-pair stats)
 *   - data/telemetry/experiment_d_ready_summary.json
 *   - data/telemetry/whitelistPairs.json
 *   - data/telemetry/blacklistPairs.json
 */

import { promises as fs } from "fs";
import path from "path";

// ── Types ──

interface ExperimentDRecord {
  ts: number;
  mode: string;
  pairId: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  status: "READY" | "NO_OPP" | "REJECTED" | "ERROR";
  marketClassification: {
    type: string;
    impact1k: number;
    impact3k: number;
    impact5k: number;
    routeMarkets: number;
    volume24h: number;
    liquidity: number;
    volumeLiquidityRatio: number;
    slippageCurveRatio: number;
    eligible: boolean;
    rejectReasons: string[];
  };
  opportunity: {
    notionalUsdc: number;
    direction: string;
    expectedNetProfitUsdc: number;
    minNetProfitUsdc: number;
    profitDriftUsdc: number | null;
    simulatedOutAmountUsdc: number | null;
  };
  latencyMetrics: {
    detectSlot: number;
    detectTimestamp: number;
    quoteReceivedTimestamp: number;
    quoteLatencyMs: number;
    buildLatencyMs: number;
    simulationLatencyMs: number;
    detectToSendLatencyMs: number;
    quoteToSendLatencyMs: number;
    executionMode: string;
  };
  jitoPrep: {
    attempted: boolean;
    skippedReason: string | null;
    latencyMs: number | null;
    subTimings: {
      blockhashFetchMs: number | null;
      tipAccountsFetchMs: number | null;
      bundleBuildMs: number | null;
    };
    retries: number | null;
    retryDelayMsTotal: number | null;
    errorStage: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  errorMessage?: string;
}

// ── Scoring weights (deterministic) ──
const W1 = 100;  // opportunityFrequency
const W2 = 10;   // medianExpectedProfit
const W3 = 20;   // driftP95Abs
const W4 = 200;  // tailRate1500

// ── Whitelist thresholds ──
const MIN_OPP_FREQ = 0.02;           // 2%
const MIN_MEDIAN_PROFIT = 0.15;      // USDC
const MAX_TAIL_RATE_1500 = 0.01;     // 1%
const MAX_D2S_P95 = 900;             // ms

// ── Stats helpers ──

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Main ──

const DATA_DIR = path.resolve(process.cwd(), "data", "telemetry");
const TRADES_FILE = path.join(DATA_DIR, "trades.jsonl");

async function main() {
  // Read JSONL
  let raw: string;
  try {
    raw = await fs.readFile(TRADES_FILE, "utf-8");
  } catch {
    console.error(`[ERROR] Cannot read ${TRADES_FILE}`);
    process.exit(1);
  }

  const lines = raw.split("\n").filter(Boolean);
  const records: ExperimentDRecord[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.mode === "EXPERIMENT_D_READY") {
        records.push(obj as ExperimentDRecord);
      }
    } catch { /* skip malformed lines */ }
  }

  if (records.length === 0) {
    console.log("[ANALYSIS] No EXPERIMENT_D_READY records found.");
    return;
  }

  // ── Global counts ──
  const total = records.length;
  const readyCount = records.filter((r) => r.status === "READY").length;
  const noOppCount = records.filter((r) => r.status === "NO_OPP").length;
  const rejectedCount = records.filter((r) => r.status === "REJECTED").length;
  const errorCount = records.filter((r) => r.status === "ERROR").length;

  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║  EXPERIMENT_D_READY — Analysis Report                  ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`  Total records:   ${total}`);
  console.log(`  READY:           ${readyCount}  (${(readyCount / total * 100).toFixed(1)}%)`);
  console.log(`  NO_OPP:          ${noOppCount}  (${(noOppCount / total * 100).toFixed(1)}%)`);
  console.log(`  REJECTED:        ${rejectedCount}  (${(rejectedCount / total * 100).toFixed(1)}%)`);
  console.log(`  ERROR:           ${errorCount}  (${(errorCount / total * 100).toFixed(1)}%)`);

  // ── Per-pair analysis ──
  const pairGroups = new Map<string, ExperimentDRecord[]>();
  for (const r of records) {
    const key = r.pairId;
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key)!.push(r);
  }

  interface PairStats {
    pairId: string;
    baseSymbol?: string;
    total: number;
    readyCount: number;
    noOppCount: number;
    rejectedCount: number;
    errorCount: number;
    opportunityFrequency: number;
    medianExpectedProfit: number;
    driftP95: number;
    d2sP95: number;
    tailRate1500: number;
    score: number;
    whitelisted: boolean;
    blacklistReasons: string[];
  }

  const pairStats: PairStats[] = [];

  console.log(`\n─── Per-Pair Breakdown ───────────────────────────────────\n`);

  for (const [pairId, recs] of pairGroups) {
    const pairTotal = recs.length;
    const pairReady = recs.filter((r) => r.status === "READY");
    const pairNoOpp = recs.filter((r) => r.status === "NO_OPP").length;
    const pairRejected = recs.filter((r) => r.status === "REJECTED").length;
    const pairError = recs.filter((r) => r.status === "ERROR").length;

    const oppFreq = pairReady.length / pairTotal;

    // Metrics from READY records
    const profits = pairReady.map((r) => r.opportunity.expectedNetProfitUsdc);
    const medProfit = median(profits);

    const drifts = pairReady
      .map((r) => r.opportunity.profitDriftUsdc)
      .filter((d): d is number => d !== null);
    const driftP95Abs = drifts.length > 0 ? Math.abs(percentile(drifts.map(Math.abs), 95)) : 0;

    const d2sValues = pairReady.map((r) => r.latencyMetrics.detectToSendLatencyMs);
    const d2sP95 = percentile(d2sValues, 95);

    const tailRate = d2sValues.length > 0
      ? d2sValues.filter((d) => d > 1500).length / d2sValues.length
      : 0;

    // Score
    const score = W1 * oppFreq + W2 * medProfit - W3 * driftP95Abs - W4 * tailRate;

    // Whitelist check
    const blacklistReasons: string[] = [];
    if (oppFreq < MIN_OPP_FREQ) blacklistReasons.push(`oppFreq=${(oppFreq * 100).toFixed(1)}% < ${MIN_OPP_FREQ * 100}%`);
    if (medProfit < MIN_MEDIAN_PROFIT) blacklistReasons.push(`medianProfit=${medProfit.toFixed(4)} < ${MIN_MEDIAN_PROFIT}`);
    if (tailRate > MAX_TAIL_RATE_1500) blacklistReasons.push(`tailRate1500=${(tailRate * 100).toFixed(1)}% > ${MAX_TAIL_RATE_1500 * 100}%`);
    if (d2sP95 > MAX_D2S_P95) blacklistReasons.push(`d2sP95=${d2sP95.toFixed(0)}ms > ${MAX_D2S_P95}ms`);

    const whitelisted = blacklistReasons.length === 0;
    const symbol = recs[0].baseSymbol ?? pairId.slice(0, 8);

    pairStats.push({
      pairId,
      baseSymbol: recs[0].baseSymbol,
      total: pairTotal,
      readyCount: pairReady.length,
      noOppCount: pairNoOpp,
      rejectedCount: pairRejected,
      errorCount: pairError,
      opportunityFrequency: oppFreq,
      medianExpectedProfit: medProfit,
      driftP95: driftP95Abs,
      d2sP95,
      tailRate1500: tailRate,
      score,
      whitelisted,
      blacklistReasons,
    });

    const emoji = whitelisted ? "✓" : "✗";
    console.log(
      `  ${emoji} ${symbol.padEnd(10)} ` +
        `total=${String(pairTotal).padStart(4)} ` +
        `READY=${String(pairReady.length).padStart(4)} ` +
        `oppFreq=${(oppFreq * 100).toFixed(1).padStart(5)}% ` +
        `medProfit=${medProfit.toFixed(4).padStart(8)} ` +
        `d2sP95=${d2sP95.toFixed(0).padStart(5)}ms ` +
        `tail1500=${(tailRate * 100).toFixed(1).padStart(5)}% ` +
        `score=${score.toFixed(2).padStart(8)}` +
        (blacklistReasons.length > 0 ? `  [${blacklistReasons.join("; ")}]` : "")
    );
  }

  // ── Sort by score descending ──
  pairStats.sort((a, b) => b.score - a.score);

  // ── Whitelist / Blacklist ──
  const whitelist = pairStats.filter((p) => p.whitelisted).map((p) => ({
    pairId: p.pairId,
    baseSymbol: p.baseSymbol,
    score: p.score,
    opportunityFrequency: p.opportunityFrequency,
    medianExpectedProfit: p.medianExpectedProfit,
    d2sP95: p.d2sP95,
    tailRate1500: p.tailRate1500,
  }));

  const blacklist = pairStats.filter((p) => !p.whitelisted).map((p) => ({
    pairId: p.pairId,
    baseSymbol: p.baseSymbol,
    score: p.score,
    blacklistReasons: p.blacklistReasons,
  }));

  console.log(`\n─── Summary ─────────────────────────────────────────────\n`);
  console.log(`  Whitelisted pairs: ${whitelist.length}`);
  console.log(`  Blacklisted pairs: ${blacklist.length}`);

  if (whitelist.length > 0) {
    console.log(`\n  Top whitelisted:`);
    for (const w of whitelist.slice(0, 5)) {
      console.log(`    ${w.baseSymbol ?? w.pairId}: score=${w.score.toFixed(2)}, oppFreq=${(w.opportunityFrequency * 100).toFixed(1)}%, medProfit=${w.medianExpectedProfit.toFixed(4)}`);
    }
  }

  // ── Write output files ──
  const summary = {
    generatedAt: new Date().toISOString(),
    totalRecords: total,
    readyCount,
    noOppCount,
    rejectedCount,
    errorCount,
    pairStats,
    scoringWeights: { W1, W2, W3, W4 },
    whitelistThresholds: { MIN_OPP_FREQ, MIN_MEDIAN_PROFIT, MAX_TAIL_RATE_1500, MAX_D2S_P95 },
  };

  await fs.mkdir(DATA_DIR, { recursive: true });

  await fs.writeFile(
    path.join(DATA_DIR, "experiment_d_ready_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  await fs.writeFile(
    path.join(DATA_DIR, "whitelistPairs.json"),
    JSON.stringify(whitelist, null, 2),
    "utf-8"
  );

  await fs.writeFile(
    path.join(DATA_DIR, "blacklistPairs.json"),
    JSON.stringify(blacklist, null, 2),
    "utf-8"
  );

  console.log(`\n  Output written to:`);
  console.log(`    ${path.join(DATA_DIR, "experiment_d_ready_summary.json")}`);
  console.log(`    ${path.join(DATA_DIR, "whitelistPairs.json")}`);
  console.log(`    ${path.join(DATA_DIR, "blacklistPairs.json")}`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
