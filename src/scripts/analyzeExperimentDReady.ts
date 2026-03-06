/**
 * EXPERIMENT_D_READY — Offline Analysis Script (v2.3 Eligibility-Fix)
 *
 * Reads data/telemetry/trades.jsonl, filters EXPERIMENT_D_READY records,
 * computes per-pair scores, produces softlist + whitelist JSON files,
 * AND prints a comprehensive root-cause diagnostic block.
 *
 * v2.3 changes:
 *   - eligibilityRate REMOVED as softlist hard gate (now diagnostic-only)
 *   - Softlist gates: quoteFillRate≥30%, tailRate≤15%, d2sP95≤1200ms,
 *     route≤4, curve≤5  (no eligibility gate)
 *   - Whitelist keeps eligibilityRate gate but guarded by numQuotes≥50
 *   - Minimum sample guard: numQuotes<50 → unstableStats=true →
 *     d2s/tail gates relaxed for softlist (research mode)
 *
 * Root-cause outputs (console + JSON):
 *   1. Global counts (N_total, N_REJECTED, softlistCount, whitelistCount)
 *   2. Route distribution (histogram, pctLe3, pctEq4, pctGe5, p95)
 *   3. Latency distribution (avgD2S, p95D2S, p99D2S, tailRate1500)
 *   4. Reject reason histograms (all / softlist tier / whitelist tier)
 *   5. Near-miss lists (route fail top 10, latency fail top 10)
 *
 * Usage:
 *   npx tsx src/scripts/analyzeExperimentDReady.ts
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
  poolMeta?: {
    sourceDex: string;
    poolType: string;
    poolId: string;
    feeBps: number;
    liqUsd: number;
    vol24hUsd: number;
  };
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
    complexRoute?: boolean;
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
// eligibilityRate kept as negative-weight diagnostic in score, NOT a gate
const W1 = 100;  // eligibilityRate (diagnostic weight, not gate)
const W2 = 50;   // quoteFillRate
const W3 = 20;   // driftP95Abs
const W4 = 200;  // tailRate1500

// ── Minimum sample guard ──
// When numQuotes < MIN_QUOTES_STABLE, d2s/tail stats are unreliable.
// Softlist will NOT block on d2s/tail for unstable pairs (research mode).
const MIN_QUOTES_STABLE = 50;

// ── Softlist thresholds ──
// NOTE: eligibilityRate is NOT a softlist gate (v2.3)
const SOFT_MAX_TAIL_RATE_1500 = 0.15;
const SOFT_MAX_D2S_P95 = 1200;
const SOFT_MIN_QUOTE_FILL_RATE = 0.30;
const SOFT_MAX_ROUTE_MARKETS = 4;
const SOFT_MAX_SLIPPAGE_CURVE = 5;

// ── Whitelist thresholds ──
const WL_MIN_ELIGIBILITY_RATE = 0.20; // guarded by numQuotes >= MIN_QUOTES_STABLE
const WL_MAX_TAIL_RATE_1500 = 0.03;
const WL_MAX_D2S_P95 = 900;
const WL_MIN_QUOTE_FILL_RATE = 0.60;
const WL_MAX_COMPLEX_ROUTE = false;
const WL_MAX_ROUTE_MARKETS = 3;
const WL_MAX_SLIPPAGE_CURVE = 4;

// Type C impact range for near-miss detection
const TYPE_C_IMPACT3K_MIN = 0.05;  // research lower bound
const TYPE_C_IMPACT3K_MAX = 1.0;

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

function pct(num: number, den: number): string {
  return den > 0 ? ((num / den) * 100).toFixed(1) : "0.0";
}

// ── Categorical tier-fail classifier ──
type TierFailCategory =
  | "FAIL_ROUTE"
  | "FAIL_D2S"
  | "FAIL_CURVE"
  | "FAIL_ELIGIBILITY_RATE"
  | "FAIL_VOL_LIQ"
  | "FAIL_LIQ"
  | "FAIL_QUOTE_FILL"
  | "FAIL_TAIL_RATE"
  | "FAIL_OTHER";

function categorizeTierReasons(reasons: string[]): TierFailCategory[] {
  const cats: TierFailCategory[] = [];
  for (const r of reasons) {
    const rl = r.toLowerCase();
    if (rl.includes("maxroute") || rl.includes("complexroute") || rl.includes("route")) cats.push("FAIL_ROUTE");
    else if (rl.includes("d2sp95") || rl.includes("d2s")) cats.push("FAIL_D2S");
    else if (rl.includes("curve") || rl.includes("slippage_curve")) cats.push("FAIL_CURVE");
    else if (rl.includes("elig")) cats.push("FAIL_ELIGIBILITY_RATE");
    else if (rl.includes("vol/liq") || rl.includes("vol_liq")) cats.push("FAIL_VOL_LIQ");
    else if (rl.includes("liq") && !rl.includes("vol")) cats.push("FAIL_LIQ");
    else if (rl.includes("qfill") || rl.includes("quote")) cats.push("FAIL_QUOTE_FILL");
    else if (rl.includes("tail")) cats.push("FAIL_TAIL_RATE");
    else cats.push("FAIL_OTHER");
  }
  return [...new Set(cats)]; // dedupe
}

// ── Main ──

const DATA_DIR = path.resolve(process.cwd(), "data", "telemetry");
const TRADES_FILE = path.join(DATA_DIR, "trades.jsonl");

async function main() {
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
    } catch { /* skip malformed */ }
  }

  if (records.length === 0) {
    console.log("[ANALYSIS] No EXPERIMENT_D_READY records found.");
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  1. GLOBAL COUNTS
  // ════════════════════════════════════════════════════════════════

  const N = records.length;
  const N_READY = records.filter((r) => r.status === "READY").length;
  const N_NO_OPP = records.filter((r) => r.status === "NO_OPP").length;
  const N_REJECTED = records.filter((r) => r.status === "REJECTED").length;
  const N_ERROR = records.filter((r) => r.status === "ERROR").length;
  const N_ELIGIBLE = N_READY + N_NO_OPP;

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  EXPERIMENT_D_READY — Root-Cause Analysis (v2.3)          ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  console.log(`\n┌─ 1. Global Counts ─────────────────────────────────────────`);
  console.log(`│  N_total:     ${N}`);
  console.log(`│  N_READY:     ${N_READY}  (${pct(N_READY, N)}%)`);
  console.log(`│  N_NO_OPP:    ${N_NO_OPP}  (${pct(N_NO_OPP, N)}%)`);
  console.log(`│  N_REJECTED:  ${N_REJECTED}  (${pct(N_REJECTED, N)}%)`);
  console.log(`│  N_ERROR:     ${N_ERROR}  (${pct(N_ERROR, N)}%)`);
  console.log(`│  N_ELIGIBLE:  ${N_ELIGIBLE}  (${pct(N_ELIGIBLE, N)}%)`);

  // ════════════════════════════════════════════════════════════════
  //  2. ROUTE DISTRIBUTION
  // ════════════════════════════════════════════════════════════════

  const routeMarketsHist = new Map<number, number>();
  const allRouteValues: number[] = [];
  for (const r of records) {
    if (r.status === "ERROR") continue;
    const rm = r.marketClassification?.routeMarkets ?? 0;
    if (rm > 0) {
      routeMarketsHist.set(rm, (routeMarketsHist.get(rm) ?? 0) + 1);
      allRouteValues.push(rm);
    }
  }
  allRouteValues.sort((a, b) => a - b);
  const nWithRoute = allRouteValues.length;
  const routeLe3 = allRouteValues.filter((v) => v <= 3).length;
  const routeEq4 = allRouteValues.filter((v) => v === 4).length;
  const routeGe5 = allRouteValues.filter((v) => v >= 5).length;
  const p95Route = percentile(allRouteValues, 95);

  console.log(`│`);
  console.log(`├─ 2. Route Distribution ────────────────────────────────────`);
  console.log(`│  routeMarketsHistogram:`);
  for (const rm of [...routeMarketsHist.keys()].sort((a, b) => a - b)) {
    const count = routeMarketsHist.get(rm)!;
    const bar = "█".repeat(Math.min(Math.round((count / nWithRoute) * 40), 40));
    console.log(`│    routes=${rm}: ${String(count).padStart(4)}  (${pct(count, nWithRoute).padStart(5)}%)  ${bar}`);
  }
  console.log(`│  pctRoutesLe3:  ${pct(routeLe3, nWithRoute)}%  (${routeLe3}/${nWithRoute})`);
  console.log(`│  pctRoutesEq4:  ${pct(routeEq4, nWithRoute)}%  (${routeEq4}/${nWithRoute})`);
  console.log(`│  pctRoutesGe5:  ${pct(routeGe5, nWithRoute)}%  (${routeGe5}/${nWithRoute})`);
  console.log(`│  p95RouteMarkets: ${p95Route}`);

  // C1 metric: routes≤3 AND complexRoute=false (whitelist-eligible route structure)
  let countRoutesLe3AndNotComplex = 0;
  for (const r of records) {
    if (r.status === "ERROR") continue;
    const rm = r.marketClassification?.routeMarkets ?? 0;
    const cr = r.marketClassification?.complexRoute === true;
    if (rm > 0 && rm <= 3 && !cr) countRoutesLe3AndNotComplex++;
  }
  const pctRoutesLe3AndNotComplex = nWithRoute > 0
    ? (countRoutesLe3AndNotComplex / nWithRoute * 100).toFixed(1)
    : "0.0";
  console.log(`│`);
  console.log(`│  C1 route quality (routes≤3 AND NOT complexRoute):`);
  console.log(`│    countRoutesLe3AndNotComplex: ${countRoutesLe3AndNotComplex}`);
  console.log(`│    pctRoutesLe3AndNotComplex:   ${pctRoutesLe3AndNotComplex}%`);
  if (countRoutesLe3AndNotComplex === 0) {
    console.log(`│    ⚠ ZERO C1-quality routes — whitelist will be empty. Discovery not producing C1 candidates.`);
  }

  // ════════════════════════════════════════════════════════════════
  //  3. LATENCY DISTRIBUTION
  // ════════════════════════════════════════════════════════════════

  const d2sValues: number[] = [];
  for (const r of records) {
    const d = r.latencyMetrics?.detectToSendLatencyMs;
    if (d && d > 0) d2sValues.push(d);
  }
  d2sValues.sort((a, b) => a - b);
  const avgD2S = Math.round(mean(d2sValues));
  const p95D2S = Math.round(percentile(d2sValues, 95));
  const p99D2S = Math.round(percentile(d2sValues, 99));
  const tailRate1500Global = d2sValues.length > 0
    ? d2sValues.filter((d) => d > 1500).length / d2sValues.length
    : 0;

  console.log(`│`);
  console.log(`├─ 3. Latency Distribution ──────────────────────────────────`);
  console.log(`│  avgD2S:          ${avgD2S}ms`);
  console.log(`│  p95D2S:          ${p95D2S}ms`);
  console.log(`│  p99D2S:          ${p99D2S}ms`);
  console.log(`│  tailRate1500:    ${(tailRate1500Global * 100).toFixed(1)}%  (${d2sValues.filter((d) => d > 1500).length}/${d2sValues.length})`);

  // ════════════════════════════════════════════════════════════════
  //  4. REJECT REASON HISTOGRAMS
  // ════════════════════════════════════════════════════════════════

  // 4a. Global reject reason histogram (from marketClassification.rejectReasons)
  const globalRejectCounts = new Map<string, number>();
  for (const r of records) {
    for (const reason of (r.marketClassification?.rejectReasons ?? [])) {
      globalRejectCounts.set(reason, (globalRejectCounts.get(reason) ?? 0) + 1);
    }
  }

  console.log(`│`);
  console.log(`├─ 4. Reject Reason Histograms ─────────────────────────────`);
  console.log(`│`);
  console.log(`│  4a. rejectReasonHistogramTotal (top 10):`);
  const sortedGlobalRejects = [...globalRejectCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedGlobalRejects.length === 0) {
    console.log(`│      (none)`);
  }
  for (const [reason, count] of sortedGlobalRejects.slice(0, 10)) {
    console.log(`│    ${String(count).padStart(4)}x (${pct(count, N).padStart(5)}%)  ${reason}`);
  }

  // ── Per-pair analysis (needed for tier histograms & near-miss) ──
  const pairGroups = new Map<string, ExperimentDRecord[]>();
  for (const r of records) {
    if (!pairGroups.has(r.pairId)) pairGroups.set(r.pairId, []);
    pairGroups.get(r.pairId)!.push(r);
  }

  interface PairStats {
    pairId: string;
    baseSymbol?: string;
    total: number;
    readyCount: number;
    noOppCount: number;
    rejectedCount: number;
    errorCount: number;
    rejectedRate: number;
    eligibilityRate: number;   // diagnostic only, NOT a softlist gate
    quoteFillRate: number;
    hasComplexRoute: boolean;
    maxRouteMarkets: number;
    avgImpact3k: number;
    avgSlippageCurve: number;
    rejectReasonHistogram: Record<string, number>;
    topRejectReasons: string[];
    opportunityFrequency: number;
    medianExpectedProfit: number;
    medianExpectedProfitAll: number;
    driftP95: number;
    d2sP95: number;
    tailRate1500: number;
    numQuotes: number;          // count of records with quotes
    unstableStats: boolean;     // true when numQuotes < MIN_QUOTES_STABLE
    score: number;
    tier: "whitelist" | "softlist" | "blacklist";
    tierRejectReasons: string[];
    // Extra fields for near-miss / root-cause
    poolType: string;
    sourceDex: string;
  }

  const pairStats: PairStats[] = [];

  for (const [pairId, recs] of pairGroups) {
    const pairTotal = recs.length;
    const pairReady = recs.filter((r) => r.status === "READY");
    const pairNoOpp = recs.filter((r) => r.status === "NO_OPP").length;
    const pairRejected = recs.filter((r) => r.status === "REJECTED");
    const pairError = recs.filter((r) => r.status === "ERROR").length;

    const oppFreq = pairReady.length / pairTotal;
    const rejectedRate = pairRejected.length / pairTotal;
    const eligibleCount = pairReady.length + pairNoOpp;
    const eligibilityRate = eligibleCount / pairTotal;

    const quotedRecords = recs.filter((r) => r.opportunity.simulatedOutAmountUsdc !== null);
    const quoteFillRate = quotedRecords.length / pairTotal;

    const hasComplexRoute = recs.some((r) => (r.marketClassification as any)?.complexRoute === true);
    const maxRouteMarkets = Math.max(...recs.map((r) => r.marketClassification?.routeMarkets ?? 0));

    const impact3kValues = recs.filter((r) => r.status !== "ERROR").map((r) => r.marketClassification.impact3k);
    const avgImpact3k = mean(impact3kValues);
    const curveValues = recs.filter((r) => r.status !== "ERROR").map((r) => r.marketClassification.slippageCurveRatio);
    const avgSlippageCurve = mean(curveValues);

    const rejectReasonCounts = new Map<string, number>();
    for (const r of pairRejected) {
      for (const reason of (r.marketClassification?.rejectReasons ?? [])) {
        rejectReasonCounts.set(reason, (rejectReasonCounts.get(reason) ?? 0) + 1);
      }
    }
    const topRejectReasons = [...rejectReasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => `${reason} (${count}x)`);

    const profits = pairReady.map((r) => r.opportunity.expectedNetProfitUsdc);
    const medProfit = median(profits);
    const allProfits = quotedRecords.map((r) => r.opportunity.expectedNetProfitUsdc);
    const medProfitAll = median(allProfits);

    const drifts = pairReady
      .map((r) => r.opportunity.profitDriftUsdc)
      .filter((d): d is number => d !== null);
    const driftP95Abs = drifts.length > 0 ? Math.abs(percentile(drifts.map(Math.abs), 95)) : 0;

    const pairD2s = quotedRecords.map((r) => r.latencyMetrics.detectToSendLatencyMs);
    const d2sP95 = percentile(pairD2s, 95);
    const tailRate = pairD2s.length > 0
      ? pairD2s.filter((d) => d > 1500).length / pairD2s.length
      : 0;

    const rejectReasonHistogram: Record<string, number> = Object.fromEntries(rejectReasonCounts);
    const numQuotes = quotedRecords.length;
    const unstableStats = numQuotes < MIN_QUOTES_STABLE;
    const score = W1 * eligibilityRate + W2 * quoteFillRate - W3 * driftP95Abs - W4 * tailRate;

    // ── Tier classification (v2.3: no elig gate on softlist) ──

    // Whitelist (strict): elig gate kept but guarded by sample size
    const wlReasons: string[] = [];
    if (unstableStats) {
      wlReasons.push(`unstableStats (numQuotes=${numQuotes} < ${MIN_QUOTES_STABLE})`);
    } else {
      if (eligibilityRate < WL_MIN_ELIGIBILITY_RATE) wlReasons.push(`elig=${(eligibilityRate * 100).toFixed(1)}% < ${WL_MIN_ELIGIBILITY_RATE * 100}%`);
    }
    if (quoteFillRate < WL_MIN_QUOTE_FILL_RATE) wlReasons.push(`qFill=${(quoteFillRate * 100).toFixed(1)}% < ${WL_MIN_QUOTE_FILL_RATE * 100}%`);
    if (tailRate > WL_MAX_TAIL_RATE_1500) wlReasons.push(`tail=${(tailRate * 100).toFixed(1)}% > ${WL_MAX_TAIL_RATE_1500 * 100}%`);
    if (d2sP95 > WL_MAX_D2S_P95) wlReasons.push(`d2sP95=${d2sP95.toFixed(0)}ms > ${WL_MAX_D2S_P95}ms`);
    if (WL_MAX_COMPLEX_ROUTE === false && hasComplexRoute) wlReasons.push(`complexRoute (routes=${maxRouteMarkets})`);
    if (maxRouteMarkets > WL_MAX_ROUTE_MARKETS) wlReasons.push(`maxRoute=${maxRouteMarkets} > ${WL_MAX_ROUTE_MARKETS}`);
    if (avgSlippageCurve > WL_MAX_SLIPPAGE_CURVE) wlReasons.push(`curve=${avgSlippageCurve.toFixed(2)} > ${WL_MAX_SLIPPAGE_CURVE}`);

    // Softlist (research): NO eligibilityRate gate.
    // When unstableStats=true, d2s/tail gates are relaxed (not applied).
    const slReasons: string[] = [];
    if (quoteFillRate < SOFT_MIN_QUOTE_FILL_RATE) slReasons.push(`qFill=${(quoteFillRate * 100).toFixed(1)}% < ${SOFT_MIN_QUOTE_FILL_RATE * 100}%`);
    if (!unstableStats) {
      // Only apply latency-based gates when stats are stable
      if (tailRate > SOFT_MAX_TAIL_RATE_1500) slReasons.push(`tail=${(tailRate * 100).toFixed(1)}% > ${SOFT_MAX_TAIL_RATE_1500 * 100}%`);
      if (d2sP95 > SOFT_MAX_D2S_P95) slReasons.push(`d2sP95=${d2sP95.toFixed(0)}ms > ${SOFT_MAX_D2S_P95}ms`);
    }
    // Structural gates always apply (not sample-dependent)
    if (maxRouteMarkets > SOFT_MAX_ROUTE_MARKETS) slReasons.push(`maxRoute=${maxRouteMarkets} > ${SOFT_MAX_ROUTE_MARKETS}`);
    if (avgSlippageCurve > SOFT_MAX_SLIPPAGE_CURVE) slReasons.push(`curve=${avgSlippageCurve.toFixed(2)} > ${SOFT_MAX_SLIPPAGE_CURVE}`);

    let tier: "whitelist" | "softlist" | "blacklist";
    let tierRejectReasons: string[];
    if (wlReasons.length === 0) {
      tier = "whitelist";
      tierRejectReasons = [];
    } else if (slReasons.length === 0) {
      tier = "softlist";
      tierRejectReasons = wlReasons;
    } else {
      tier = "blacklist";
      tierRejectReasons = slReasons;
    }

    // Pool meta (from first record that has it)
    const poolRec = recs.find((r) => r.poolMeta);
    const poolType = poolRec?.poolMeta?.poolType ?? "unknown";
    const sourceDex = poolRec?.poolMeta?.sourceDex ?? "unknown";

    pairStats.push({
      pairId,
      baseSymbol: recs[0].baseSymbol,
      total: pairTotal,
      readyCount: pairReady.length,
      noOppCount: pairNoOpp,
      rejectedCount: pairRejected.length,
      errorCount: pairError,
      rejectedRate,
      eligibilityRate,
      quoteFillRate,
      hasComplexRoute,
      maxRouteMarkets,
      avgImpact3k,
      avgSlippageCurve,
      rejectReasonHistogram,
      topRejectReasons,
      opportunityFrequency: oppFreq,
      medianExpectedProfit: medProfit,
      medianExpectedProfitAll: medProfitAll,
      driftP95: driftP95Abs,
      d2sP95,
      tailRate1500: tailRate,
      numQuotes,
      unstableStats,
      score,
      tier,
      tierRejectReasons,
      poolType,
      sourceDex,
    });
  }

  pairStats.sort((a, b) => b.score - a.score);

  // ── Tier counts ──
  const whitelistPairs = pairStats.filter((p) => p.tier === "whitelist");
  const softlistPairs = pairStats.filter((p) => p.tier === "softlist");
  const blacklistPairs = pairStats.filter((p) => p.tier === "blacklist");

  // 4b. Softlist tier fail histogram (categorical)
  const softFailHist = new Map<TierFailCategory, number>();
  for (const p of pairStats) {
    // Every pair that is NOT softlist-eligible
    if (p.tier === "blacklist") {
      const cats = categorizeTierReasons(p.tierRejectReasons);
      for (const c of cats) {
        softFailHist.set(c, (softFailHist.get(c) ?? 0) + 1);
      }
    }
  }

  console.log(`│`);
  console.log(`│  4b. softTierFailHistogram (why not softlist — categorical):`);
  const softFailTotal = [...softFailHist.values()].reduce((a, b) => a + b, 0);
  if (softFailTotal === 0) {
    console.log(`│      (none — all pairs qualify for softlist or higher)`);
  }
  for (const [cat, count] of [...softFailHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`│    ${String(count).padStart(4)}x (${pct(count, blacklistPairs.length).padStart(5)}%)  ${cat}`);
  }

  // 4c. Whitelist tier fail histogram (categorical)
  const wlFailHist = new Map<TierFailCategory, number>();
  for (const p of pairStats) {
    if (p.tier !== "whitelist") {
      const cats = categorizeTierReasons(p.tierRejectReasons);
      for (const c of cats) {
        wlFailHist.set(c, (wlFailHist.get(c) ?? 0) + 1);
      }
    }
  }

  console.log(`│`);
  console.log(`│  4c. whitelistFailHistogram (why not whitelist — categorical):`);
  const wlFailTotal = [...wlFailHist.values()].reduce((a, b) => a + b, 0);
  if (wlFailTotal === 0) {
    console.log(`│      (none — all pairs qualify for whitelist)`);
  }
  for (const [cat, count] of [...wlFailHist.entries()].sort((a, b) => b[1] - a[1])) {
    const nonWl = pairStats.length - whitelistPairs.length;
    console.log(`│    ${String(count).padStart(4)}x (${pct(count, nonWl).padStart(5)}%)  ${cat}`);
  }

  // 4d. Pool type + DEX histograms
  const poolTypeHist = new Map<string, number>();
  const dexHist = new Map<string, number>();
  for (const p of pairStats) {
    poolTypeHist.set(p.poolType, (poolTypeHist.get(p.poolType) ?? 0) + 1);
    dexHist.set(p.sourceDex, (dexHist.get(p.sourceDex) ?? 0) + 1);
  }

  console.log(`│`);
  console.log(`│  4d. poolTypeHistogram:`);
  for (const [pt, count] of [...poolTypeHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`│    ${pt.padEnd(12)} ${count}`);
  }
  console.log(`│  dexHistogram:`);
  for (const [dex, count] of [...dexHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`│    ${dex.padEnd(12)} ${count}`);
  }

  // 4e. Route distribution by poolType
  const routeByPoolType = new Map<string, number[]>();
  for (const r of records) {
    if (r.status === "ERROR") continue;
    const pt = r.poolMeta?.poolType ?? "unknown";
    if (!routeByPoolType.has(pt)) routeByPoolType.set(pt, []);
    routeByPoolType.get(pt)!.push(r.marketClassification.routeMarkets);
  }

  console.log(`│`);
  console.log(`│  4e. avgRouteMarkets by poolType:`);
  for (const [pt, vals] of [...routeByPoolType.entries()].sort()) {
    const avg = mean(vals);
    const p95 = percentile(vals, 95);
    const le3 = vals.filter((v) => v <= 3).length;
    console.log(`│    ${pt.padEnd(12)} avg=${avg.toFixed(1)} p95=${p95} pctLe3=${pct(le3, vals.length)}% (n=${vals.length})`);
  }

  // 4f. D2S by poolType
  const d2sByPoolType = new Map<string, number[]>();
  for (const r of records) {
    const d = r.latencyMetrics?.detectToSendLatencyMs;
    if (!d || d <= 0) continue;
    const pt = r.poolMeta?.poolType ?? "unknown";
    if (!d2sByPoolType.has(pt)) d2sByPoolType.set(pt, []);
    d2sByPoolType.get(pt)!.push(d);
  }

  console.log(`│  avgD2S by poolType:`);
  for (const [pt, vals] of [...d2sByPoolType.entries()].sort()) {
    const avg = Math.round(mean(vals));
    const p95 = Math.round(percentile(vals, 95));
    console.log(`│    ${pt.padEnd(12)} avg=${avg}ms p95=${p95}ms (n=${vals.length})`);
  }

  // ════════════════════════════════════════════════════════════════
  //  5. NEAR-MISS LISTS
  // ════════════════════════════════════════════════════════════════

  console.log(`│`);
  console.log(`├─ 5. Near-Miss Lists ──────────────────────────────────────`);

  // 5A: Impact in Type C range BUT routes > SOFT_MAX_ROUTE_MARKETS
  const nearMissRoute = pairStats
    .filter((p) =>
      p.avgImpact3k >= TYPE_C_IMPACT3K_MIN &&
      p.avgImpact3k <= TYPE_C_IMPACT3K_MAX &&
      p.maxRouteMarkets > SOFT_MAX_ROUTE_MARKETS
    )
    .sort((a, b) => a.maxRouteMarkets - b.maxRouteMarkets)
    .slice(0, 10);

  console.log(`│`);
  console.log(`│  5A. Route-fail near-misses (impact in TypeC range, routes too deep):`);
  if (nearMissRoute.length === 0) {
    console.log(`│      (none)`);
  } else {
    console.log(`│  ${"pairId".padEnd(12)} ${"poolType".padEnd(10)} ${"dex".padEnd(10)} ${"imp3k".padStart(7)} ${"routes".padStart(6)} ${"d2sP95".padStart(8)} ${"tail%".padStart(7)} ${"elig%".padStart(7)} ${"qfill%".padStart(7)}`);
    for (const p of nearMissRoute) {
      console.log(
        `│  ${(p.baseSymbol ?? p.pairId.slice(0, 10)).padEnd(12)} ${p.poolType.padEnd(10)} ${p.sourceDex.padEnd(10)} ` +
        `${p.avgImpact3k.toFixed(3).padStart(7)} ${String(p.maxRouteMarkets).padStart(6)} ` +
        `${p.d2sP95.toFixed(0).padStart(7)}ms ${(p.tailRate1500 * 100).toFixed(1).padStart(6)}% ` +
        `${(p.eligibilityRate * 100).toFixed(1).padStart(6)}% ${(p.quoteFillRate * 100).toFixed(1).padStart(6)}%`
      );
    }
  }

  // 5B: Impact in Type C range BUT d2sP95 > SOFT_MAX_D2S_P95
  const nearMissLatency = pairStats
    .filter((p) =>
      p.avgImpact3k >= TYPE_C_IMPACT3K_MIN &&
      p.avgImpact3k <= TYPE_C_IMPACT3K_MAX &&
      p.d2sP95 > SOFT_MAX_D2S_P95
    )
    .sort((a, b) => a.d2sP95 - b.d2sP95) // closest to threshold first
    .slice(0, 10);

  console.log(`│`);
  console.log(`│  5B. Latency-fail near-misses (impact in TypeC range, d2sP95 too high):`);
  if (nearMissLatency.length === 0) {
    console.log(`│      (none)`);
  } else {
    console.log(`│  ${"pairId".padEnd(12)} ${"poolType".padEnd(10)} ${"dex".padEnd(10)} ${"imp3k".padStart(7)} ${"routes".padStart(6)} ${"d2sP95".padStart(8)} ${"tail%".padStart(7)} ${"elig%".padStart(7)} ${"qfill%".padStart(7)}`);
    for (const p of nearMissLatency) {
      console.log(
        `│  ${(p.baseSymbol ?? p.pairId.slice(0, 10)).padEnd(12)} ${p.poolType.padEnd(10)} ${p.sourceDex.padEnd(10)} ` +
        `${p.avgImpact3k.toFixed(3).padStart(7)} ${String(p.maxRouteMarkets).padStart(6)} ` +
        `${p.d2sP95.toFixed(0).padStart(7)}ms ${(p.tailRate1500 * 100).toFixed(1).padStart(6)}% ` +
        `${(p.eligibilityRate * 100).toFixed(1).padStart(6)}% ${(p.quoteFillRate * 100).toFixed(1).padStart(6)}%`
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  PER-PAIR TABLE
  // ════════════════════════════════════════════════════════════════

  console.log(`│`);
  console.log(`├─ Per-Pair Breakdown ──────────────────────────────────────`);

  const unstableCount = pairStats.filter((p) => p.unstableStats).length;
  const stableCount = pairStats.length - unstableCount;
  console.log(`│  (${stableCount} stable, ${unstableCount} unstable [numQuotes<${MIN_QUOTES_STABLE}])`);
  console.log(`│`);

  for (const ps of pairStats) {
    const tierEmoji = ps.tier === "whitelist" ? "★" : ps.tier === "softlist" ? "○" : "✗";
    const crTag = ps.hasComplexRoute ? "[CR]" : "";
    const usTag = ps.unstableStats ? "~" : " "; // ~ = unstable stats
    const symbol = ps.baseSymbol ?? ps.pairId.slice(0, 8);
    console.log(
      `│  ${tierEmoji}${usTag}${symbol.padEnd(10)}${crTag.padEnd(5)} ` +
      `[${ps.tier.padEnd(9)}] ` +
      `n=${String(ps.total).padStart(3)} ` +
      `nQ=${String(ps.numQuotes).padStart(3)} ` +
      `elig=${(ps.eligibilityRate * 100).toFixed(0).padStart(3)}% ` +
      `qf=${(ps.quoteFillRate * 100).toFixed(0).padStart(3)}% ` +
      `d2s=${ps.d2sP95.toFixed(0).padStart(5)}ms ` +
      `tail=${(ps.tailRate1500 * 100).toFixed(1).padStart(5)}% ` +
      `rt=${ps.maxRouteMarkets} ` +
      `imp=${ps.avgImpact3k.toFixed(3)} ` +
      `sc=${ps.score.toFixed(1).padStart(6)}`
    );
    if (ps.unstableStats) {
      console.log(`│       ⚠ unstableStats: numQuotes=${ps.numQuotes} < ${MIN_QUOTES_STABLE} (d2s/tail gates relaxed for softlist)`);
    }
    if (ps.tierRejectReasons.length > 0) {
      console.log(`│       tierFail: [${ps.tierRejectReasons.join("; ")}]`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  TIER SUMMARY
  // ════════════════════════════════════════════════════════════════

  console.log(`│`);
  console.log(`├─ Tier Summary ────────────────────────────────────────────`);
  console.log(`│  ★ Whitelist (strict live):   ${whitelistPairs.length}`);
  console.log(`│  ○ Softlist  (research):      ${softlistPairs.length}`);
  console.log(`│  ✗ Blacklist:                 ${blacklistPairs.length}`);
  console.log(`│  softlistCount:     ${softlistPairs.length}`);
  console.log(`│  whitelistCount:    ${whitelistPairs.length}`);

  if (whitelistPairs.length > 0) {
    console.log(`│`);
    console.log(`│  Top whitelist (live-ready):`);
    for (const w of whitelistPairs.slice(0, 10)) {
      console.log(`│    ★ ${(w.baseSymbol ?? w.pairId).padEnd(12)} score=${w.score.toFixed(2)} elig=${(w.eligibilityRate * 100).toFixed(0)}% qFill=${(w.quoteFillRate * 100).toFixed(0)}% d2sP95=${w.d2sP95.toFixed(0)}ms`);
    }
  }
  if (softlistPairs.length > 0) {
    console.log(`│`);
    console.log(`│  Top softlist (keep observing):`);
    for (const s of softlistPairs.slice(0, 10)) {
      console.log(`│    ○ ${(s.baseSymbol ?? s.pairId).padEnd(12)} score=${s.score.toFixed(2)} elig=${(s.eligibilityRate * 100).toFixed(0)}% qFill=${(s.quoteFillRate * 100).toFixed(0)}% d2sP95=${s.d2sP95.toFixed(0)}ms`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  KILLER VERDICT
  // ════════════════════════════════════════════════════════════════

  // Determine the single dominant reason for softlist=0
  const killerCandidates: Array<{ label: string; score: number; detail: string }> = [];

  // Route killer
  const routeFailPct = blacklistPairs.length > 0
    ? (softFailHist.get("FAIL_ROUTE") ?? 0) / blacklistPairs.length
    : 0;
  killerCandidates.push({
    label: "ROUTE",
    score: routeFailPct,
    detail: `${(routeFailPct * 100).toFixed(1)}% of blacklisted pairs fail on route (p95Route=${p95Route})`,
  });

  // D2S killer
  const d2sFailPct = blacklistPairs.length > 0
    ? (softFailHist.get("FAIL_D2S") ?? 0) / blacklistPairs.length
    : 0;
  killerCandidates.push({
    label: "D2S_LATENCY",
    score: d2sFailPct,
    detail: `${(d2sFailPct * 100).toFixed(1)}% fail on d2sP95 (global p95=${p95D2S}ms, p99=${p99D2S}ms)`,
  });

  // Curve killer
  const curveFailPct = blacklistPairs.length > 0
    ? (softFailHist.get("FAIL_CURVE") ?? 0) / blacklistPairs.length
    : 0;
  killerCandidates.push({
    label: "CURVE",
    score: curveFailPct,
    detail: `${(curveFailPct * 100).toFixed(1)}% fail on slippage curve`,
  });

  // NOTE: ELIGIBILITY_RATE is no longer a softlist gate (v2.3).
  // It can still appear in WL fail histogram but not in soft fail.

  // Quote fill killer
  const qfillFailPct = blacklistPairs.length > 0
    ? (softFailHist.get("FAIL_QUOTE_FILL") ?? 0) / blacklistPairs.length
    : 0;
  killerCandidates.push({
    label: "QUOTE_FILL",
    score: qfillFailPct,
    detail: `${(qfillFailPct * 100).toFixed(1)}% fail on quote fill rate < ${SOFT_MIN_QUOTE_FILL_RATE * 100}%`,
  });

  // Tail rate killer (only for stable-stats pairs)
  const tailFailPct = blacklistPairs.length > 0
    ? (softFailHist.get("FAIL_TAIL_RATE") ?? 0) / blacklistPairs.length
    : 0;
  killerCandidates.push({
    label: "TAIL_RATE",
    score: tailFailPct,
    detail: `${(tailFailPct * 100).toFixed(1)}% fail on tail rate > ${SOFT_MAX_TAIL_RATE_1500 * 100}% (stable-stats only)`,
  });

  killerCandidates.sort((a, b) => b.score - a.score);

  console.log(`│`);
  console.log(`├─ KILLER VERDICT ──────────────────────────────────────────`);
  if (softlistPairs.length === 0 && blacklistPairs.length > 0) {
    const top = killerCandidates[0];
    console.log(`│  ⚠ softlist=0 PRIMARY KILLER: ${top.label} (${top.detail})`);
    console.log(`│`);
    console.log(`│  All fail categories (sorted):`);
    for (const k of killerCandidates.filter((k) => k.score > 0)) {
      console.log(`│    ${k.label.padEnd(22)} ${(k.score * 100).toFixed(1)}%  — ${k.detail}`);
    }
  } else if (softlistPairs.length > 0 && whitelistPairs.length === 0) {
    console.log(`│  ○ softlist exists but whitelist=0.`);
    console.log(`│  Whitelist fail categories:`);
    for (const k of killerCandidates.filter((k) => k.score > 0)) {
      console.log(`│    ${k.label.padEnd(22)} ${(k.score * 100).toFixed(1)}%`);
    }
  } else if (whitelistPairs.length > 0) {
    console.log(`│  ★ Whitelist has ${whitelistPairs.length} pairs — no killer identified.`);
  } else {
    console.log(`│  ⚠ No pairs analyzed — check data.`);
  }
  console.log(`└────────────────────────────────────────────────────────────\n`);

  // ════════════════════════════════════════════════════════════════
  //  WRITE OUTPUT FILES
  // ════════════════════════════════════════════════════════════════

  function pairOutputShape(p: PairStats) {
    return {
      pairId: p.pairId,
      baseSymbol: p.baseSymbol,
      score: p.score,
      tier: p.tier,
      eligibilityRate: p.eligibilityRate,
      quoteFillRate: p.quoteFillRate,
      hasComplexRoute: p.hasComplexRoute,
      maxRouteMarkets: p.maxRouteMarkets,
      avgImpact3k: p.avgImpact3k,
      d2sP95: p.d2sP95,
      tailRate1500: p.tailRate1500,
      numQuotes: p.numQuotes,
      unstableStats: p.unstableStats,
      medianExpectedProfitAll: p.medianExpectedProfitAll,
      rejectReasonHistogram: p.rejectReasonHistogram,
      tierRejectReasons: p.tierRejectReasons,
      poolType: p.poolType,
      sourceDex: p.sourceDex,
    };
  }

  const whitelist = whitelistPairs.map(pairOutputShape);
  const softlist = softlistPairs.map(pairOutputShape);
  const blacklist = blacklistPairs.map(pairOutputShape);

  const routeMarketsHistogram: Record<string, number> = Object.fromEntries(
    [...routeMarketsHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])
  );
  const globalRejectHistogram: Record<string, number> = Object.fromEntries(
    [...globalRejectCounts.entries()].sort((a, b) => b[1] - a[1])
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    // 1. Global counts
    totalRecords: N,
    N_READY,
    N_NO_OPP,
    N_REJECTED,
    N_ERROR,
    N_ELIGIBLE,
    softlistCount: softlistPairs.length,
    whitelistCount: whitelistPairs.length,
    blacklistCount: blacklistPairs.length,
    // 2. Route distribution
    routeMarketsHistogram,
    pctRoutesLe3: nWithRoute > 0 ? routeLe3 / nWithRoute : 0,
    pctRoutesEq4: nWithRoute > 0 ? routeEq4 / nWithRoute : 0,
    pctRoutesGe5: nWithRoute > 0 ? routeGe5 / nWithRoute : 0,
    p95RouteMarkets: p95Route,
    countRoutesLe3AndNotComplex,
    pctRoutesLe3AndNotComplex: nWithRoute > 0 ? countRoutesLe3AndNotComplex / nWithRoute : 0,
    // 3. Latency distribution
    avgD2S,
    p95D2S,
    p99D2S,
    tailRate1500Global,
    // 4. Reject histograms
    rejectReasonHistogramTotal: globalRejectHistogram,
    softTierFailHistogram: Object.fromEntries(softFailHist),
    whitelistFailHistogram: Object.fromEntries(wlFailHist),
    poolTypeHistogram: Object.fromEntries(poolTypeHist),
    dexHistogram: Object.fromEntries(dexHist),
    // 5. Near-miss
    nearMissRoute: nearMissRoute.map((p) => ({
      pairId: p.pairId,
      baseSymbol: p.baseSymbol,
      poolType: p.poolType,
      dex: p.sourceDex,
      impact3k: p.avgImpact3k,
      routes: p.maxRouteMarkets,
      d2sP95: p.d2sP95,
      tailRate1500: p.tailRate1500,
      eligRate: p.eligibilityRate,
      qfill: p.quoteFillRate,
    })),
    nearMissLatency: nearMissLatency.map((p) => ({
      pairId: p.pairId,
      baseSymbol: p.baseSymbol,
      poolType: p.poolType,
      dex: p.sourceDex,
      impact3k: p.avgImpact3k,
      routes: p.maxRouteMarkets,
      d2sP95: p.d2sP95,
      tailRate1500: p.tailRate1500,
      eligRate: p.eligibilityRate,
      qfill: p.quoteFillRate,
    })),
    // Killer verdict
    killerVerdict: killerCandidates.slice(0, 5).map((k) => ({
      category: k.label,
      pctAffected: Number((k.score * 100).toFixed(1)),
      detail: k.detail,
    })),
    // Thresholds (for reproducibility)
    MIN_QUOTES_STABLE,
    softlistThresholds: {
      NOTE: "eligibilityRate NOT a gate (v2.3), d2s/tail relaxed when unstableStats",
      MIN_QUOTE_FILL_RATE: SOFT_MIN_QUOTE_FILL_RATE,
      MAX_TAIL_RATE_1500: SOFT_MAX_TAIL_RATE_1500,
      MAX_D2S_P95: SOFT_MAX_D2S_P95,
      MAX_ROUTE_MARKETS: SOFT_MAX_ROUTE_MARKETS,
      MAX_SLIPPAGE_CURVE: SOFT_MAX_SLIPPAGE_CURVE,
    },
    whitelistThresholds: {
      MIN_ELIGIBILITY_RATE: WL_MIN_ELIGIBILITY_RATE,
      MIN_QUOTE_FILL_RATE: WL_MIN_QUOTE_FILL_RATE,
      MAX_TAIL_RATE_1500: WL_MAX_TAIL_RATE_1500,
      MAX_D2S_P95: WL_MAX_D2S_P95,
      MAX_COMPLEX_ROUTE: WL_MAX_COMPLEX_ROUTE,
      MAX_ROUTE_MARKETS: WL_MAX_ROUTE_MARKETS,
      MAX_SLIPPAGE_CURVE: WL_MAX_SLIPPAGE_CURVE,
    },
    scoringWeights: { W1, W2, W3, W4 },
    pairStats: pairStats.map(pairOutputShape),
  };

  await fs.mkdir(DATA_DIR, { recursive: true });

  await fs.writeFile(
    path.join(DATA_DIR, "experiment_d_ready_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );
  await fs.writeFile(
    path.join(DATA_DIR, "softlistPairs.json"),
    JSON.stringify(softlist, null, 2),
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

  console.log(`Output written to:`);
  console.log(`  ${path.join(DATA_DIR, "experiment_d_ready_summary.json")}`);
  console.log(`  ${path.join(DATA_DIR, "softlistPairs.json")}`);
  console.log(`  ${path.join(DATA_DIR, "whitelistPairs.json")}`);
  console.log(`  ${path.join(DATA_DIR, "blacklistPairs.json")}`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
