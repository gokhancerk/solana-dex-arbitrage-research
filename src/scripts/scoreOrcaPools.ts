/**
 * Orca Pool Scoring — Milestone M1 (Micro + Scale Whitelists)
 *
 * Reads data/candidatePools.json (from discover:orca), fetches live
 * Orca whirlpool metadata, computes TVL-based deterministic impact
 * metrics at 5 notional levels (30, 100, 1k, 3k, 5k USDC), and outputs:
 *
 *   - data/orca_pool_scores.json       (full scored records with poolMeta)
 *   - data/poolSoftlist.json           (research candidates — near-miss union)
 *   - data/poolWhitelist_micro.json    ($20–$100 live micro candidates)
 *   - data/poolWhitelist_scale.json    ($1k–$3k scale candidates)
 *   - data/orca_pool_summary.json      (histograms + per-tier rejection breakdown)
 *
 * No Jupiter routing. TVL-based deterministic impact estimation.
 *
 * Usage:
 *   npm run score:orca
 *   npx tsx src/scripts/scoreOrcaPools.ts
 *   npx tsx src/scripts/scoreOrcaPools.ts --dry
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Notional levels for impact measurement (USD) — micro + scale */
const N1_MICRO = 30;
const N2_MICRO = 100;
const N3_SCALE = 1_000;
const N4_SCALE = 3_000;
const N5_SCALE = 5_000;

/** Small epsilon for division safety */
const EPS = 1e-8;

// ── Micro whitelist thresholds ($20–$100 sizing) ──
const MICRO_THRESHOLDS = {
  minLiquidityUsd: 40_000,
  minVolume24hUsd: 20_000,
  minVolLiqRatio: 0.03,
  maxImpact100Pct: 0.50,
  maxCurveRatioMicro: 5,
  maxFeeBps: 100,
} as const;

// ── Scale whitelist thresholds ($1k–$3k sizing) ──
const SCALE_THRESHOLDS = {
  minLiquidityUsd: 100_000,
  minVolume24hUsd: 50_000,
  minVolLiqRatio: 0.05,
  minImpact3kPct: 0.10,
  maxImpact3kPct: 1.20,
  maxCurveRatioScale: 4,
  maxFeeBps: 100,
} as const;

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface CandidatePoolInput {
  poolId: string;
  baseMint: string;
  quoteMint: string;
  tokenMintA: string;
  tokenMintB: string;
  baseSymbol: string;
  baseDecimals: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volumeLiquidityRatio: number;
  feeBps: number;
  tickSpacing: number;
  score: number;
}

interface CandidatePoolsFile {
  generatedAtMs: number;
  version: string;
  quoteMint: string;
  poolType: string;
  source: string;
  candidates: CandidatePoolInput[];
}

/**
 * Price data from Orca whirlpool list — fetched once for all pools.
 */
interface OrcaPoolMeta {
  price: number;
  tvl: number;
  lpFeeRate: number;
  tickSpacing: number;
}

interface PoolMetaOutput {
  dex: "orca";
  poolType: "whirlpool";
  poolId: string;
  feeBps: number;
  tickSpacing: number;
  liquidityUsd: number;
  volume24hUsd: number;
  lpFeeRate: number;
  price: number | null;
}

interface ScoredPool extends CandidatePoolInput {
  // Micro impacts
  impact30Pct: number;
  impact100Pct: number;
  // Scale impacts
  impact1kPct: number;
  impact3kPct: number;
  impact5kPct: number;
  // Curve ratios
  curveRatio_micro: number | null;   // impact100 / max(impact30, eps)
  curveRatio_scale: number | null;   // impact5k / max(impact1k, eps)
  // Metadata
  quoteFillOk: boolean;
  quoteError?: string;
  poolMeta: PoolMetaOutput;
}

interface ListEntry {
  poolId: string;
  baseMint: string;
  baseSymbol: string;
  liquidityUsd: number;
  volume24hUsd: number;
  volumeLiquidityRatio: number;
  feeBps: number;
  tickSpacing: number;
  impact30Pct: number;
  impact100Pct: number;
  impact1kPct: number;
  impact3kPct: number;
  impact5kPct: number;
  curveRatio_micro: number | null;
  curveRatio_scale: number | null;
  score: number;
  poolMeta: PoolMetaOutput;
}

interface SoftlistEntry extends ListEntry {
  rejectReasons: string[];
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const wait = (attempt + 1) * 3_000;
        console.warn(`  [HTTP] 429 rate-limited — retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await sleep((attempt + 1) * 2_000);
    }
  }
  throw new Error(`fetchWithRetry exhausted: ${url}`);
}

// ══════════════════════════════════════════════════════════════
//  Orca Pool Metadata Fetch
// ══════════════════════════════════════════════════════════════

async function fetchOrcaPoolMeta(): Promise<Map<string, OrcaPoolMeta>> {
  console.log("  [Orca] Fetching whirlpool metadata for scoring…");
  const res = await fetchWithRetry("https://api.mainnet.orca.so/v1/whirlpool/list");
  const data = (await res.json()) as {
    whirlpools?: Array<{
      address: string;
      price?: number;
      tvl?: number;
      lpFeeRate?: number;
      tickSpacing?: number;
    }>;
  };

  const map = new Map<string, OrcaPoolMeta>();
  for (const wp of data.whirlpools ?? []) {
    if (wp.price !== undefined && wp.tvl !== undefined) {
      map.set(wp.address, {
        price: wp.price,
        tvl: wp.tvl,
        lpFeeRate: wp.lpFeeRate ?? 0,
        tickSpacing: wp.tickSpacing ?? 0,
      });
    }
  }

  console.log(`  [Orca] ${map.size} pools with price/tvl metadata`);
  return map;
}

// ══════════════════════════════════════════════════════════════
//  Impact Estimation (TVL-based, deterministic, no routing)
// ══════════════════════════════════════════════════════════════

/**
 * Estimate effective price impact using constant-product approximation:
 *
 *   impact ≈ notional / TVL * 100   (percent)
 *
 * Plus fee component. This is an upper-bound for CLMM pools
 * (concentrated liquidity within active range may have lower actual impact).
 * Deterministic and consistent across runs — no Jupiter routing.
 */
function estimateImpactPct(
  notionalUsd: number,
  tvlUsd: number,
  lpFeeRate: number,
): number {
  if (tvlUsd <= 0) return 100;
  const ammImpact = (notionalUsd / tvlUsd) * 100;
  const feePct = lpFeeRate * 100;
  return Number((ammImpact + feePct).toFixed(4));
}

// ══════════════════════════════════════════════════════════════
//  Pool Scoring
// ══════════════════════════════════════════════════════════════

function scorePool(
  pool: CandidatePoolInput,
  meta: OrcaPoolMeta | undefined,
): ScoredPool {
  const tvl = meta?.tvl ?? pool.liquidityUsd;
  const lpFeeRate = meta?.lpFeeRate ?? (pool.feeBps / 10_000);
  const price = meta?.price ?? null;

  // Compute impacts at all 5 notional levels
  const impact30 = estimateImpactPct(N1_MICRO, tvl, lpFeeRate);
  const impact100 = estimateImpactPct(N2_MICRO, tvl, lpFeeRate);
  const impact1k = estimateImpactPct(N3_SCALE, tvl, lpFeeRate);
  const impact3k = estimateImpactPct(N4_SCALE, tvl, lpFeeRate);
  const impact5k = estimateImpactPct(N5_SCALE, tvl, lpFeeRate);

  // Curve ratios
  const curveRatio_micro = impact30 > EPS
    ? Number((impact100 / impact30).toFixed(4))
    : null;

  const curveRatio_scale = impact1k > EPS
    ? Number((impact5k / impact1k).toFixed(4))
    : null;

  const quoteFillOk = tvl > 0 && meta !== undefined;

  const scored: ScoredPool = {
    ...pool,
    impact30Pct: impact30,
    impact100Pct: impact100,
    impact1kPct: impact1k,
    impact3kPct: impact3k,
    impact5kPct: impact5k,
    curveRatio_micro,
    curveRatio_scale,
    quoteFillOk,
    poolMeta: {
      dex: "orca",
      poolType: "whirlpool",
      poolId: pool.poolId,
      feeBps: pool.feeBps,
      tickSpacing: meta?.tickSpacing ?? pool.tickSpacing,
      liquidityUsd: Math.round(tvl),
      volume24hUsd: pool.volume24hUsd,
      lpFeeRate,
      price,
    },
  };

  if (!meta) {
    scored.quoteError = "no metadata from Orca API for this pool";
  }

  return scored;
}

// ══════════════════════════════════════════════════════════════
//  Tier Classification
// ══════════════════════════════════════════════════════════════

function toListEntry(s: ScoredPool): ListEntry {
  return {
    poolId: s.poolId,
    baseMint: s.baseMint,
    baseSymbol: s.baseSymbol,
    liquidityUsd: s.liquidityUsd,
    volume24hUsd: s.volume24hUsd,
    volumeLiquidityRatio: s.volumeLiquidityRatio,
    feeBps: s.feeBps,
    tickSpacing: s.tickSpacing,
    impact30Pct: s.impact30Pct,
    impact100Pct: s.impact100Pct,
    impact1kPct: s.impact1kPct,
    impact3kPct: s.impact3kPct,
    impact5kPct: s.impact5kPct,
    curveRatio_micro: s.curveRatio_micro,
    curveRatio_scale: s.curveRatio_scale,
    score: s.score,
    poolMeta: s.poolMeta,
  };
}

// ── Micro classification ──

type MicroReject =
  | "quoteFillFail"
  | "lowLiquidity"
  | "lowVolume"
  | "lowVolLiqRatio"
  | "impactTooHigh"
  | "curveTooSteep"
  | "highFee";

function getMicroRejects(s: ScoredPool): MicroReject[] {
  const reasons: MicroReject[] = [];
  if (!s.quoteFillOk) reasons.push("quoteFillFail");
  if (s.liquidityUsd < MICRO_THRESHOLDS.minLiquidityUsd) reasons.push("lowLiquidity");
  if (s.volume24hUsd < MICRO_THRESHOLDS.minVolume24hUsd) reasons.push("lowVolume");
  if (s.volumeLiquidityRatio < MICRO_THRESHOLDS.minVolLiqRatio) reasons.push("lowVolLiqRatio");
  if (s.impact100Pct > MICRO_THRESHOLDS.maxImpact100Pct) reasons.push("impactTooHigh");
  if (s.curveRatio_micro !== null && s.curveRatio_micro > MICRO_THRESHOLDS.maxCurveRatioMicro) reasons.push("curveTooSteep");
  if (s.feeBps > MICRO_THRESHOLDS.maxFeeBps) reasons.push("highFee");
  return reasons;
}

function classifyMicro(s: ScoredPool): boolean {
  return getMicroRejects(s).length === 0;
}

// ── Scale classification ──

type ScaleReject =
  | "quoteFillFail"
  | "lowLiquidity"
  | "lowVolume"
  | "lowVolLiqRatio"
  | "impactTooLow"
  | "impactTooHigh"
  | "curveTooSteep"
  | "highFee";

function getScaleRejects(s: ScoredPool): ScaleReject[] {
  const reasons: ScaleReject[] = [];
  if (!s.quoteFillOk) reasons.push("quoteFillFail");
  if (s.liquidityUsd < SCALE_THRESHOLDS.minLiquidityUsd) reasons.push("lowLiquidity");
  if (s.volume24hUsd < SCALE_THRESHOLDS.minVolume24hUsd) reasons.push("lowVolume");
  if (s.volumeLiquidityRatio < SCALE_THRESHOLDS.minVolLiqRatio) reasons.push("lowVolLiqRatio");
  if (s.impact3kPct < SCALE_THRESHOLDS.minImpact3kPct) reasons.push("impactTooLow");
  if (s.impact3kPct > SCALE_THRESHOLDS.maxImpact3kPct) reasons.push("impactTooHigh");
  if (s.curveRatio_scale !== null && s.curveRatio_scale > SCALE_THRESHOLDS.maxCurveRatioScale) reasons.push("curveTooSteep");
  if (s.feeBps > SCALE_THRESHOLDS.maxFeeBps) reasons.push("highFee");
  return reasons;
}

function classifyScale(s: ScoredPool): boolean {
  return getScaleRejects(s).length === 0;
}

// ── Softlist: union of near-miss micro + scale (fail 1–2 conditions) ──
// Also includes pools that fully pass either tier.

function classifySoftlist(s: ScoredPool): { pass: boolean; rejectReasons: string[] } {
  const microRejects = getMicroRejects(s);
  const scaleRejects = getScaleRejects(s);

  const microNearMiss = microRejects.length >= 1 && microRejects.length <= 2;
  const scaleNearMiss = scaleRejects.length >= 1 && scaleRejects.length <= 2;
  const microPass = microRejects.length === 0;
  const scalePass = scaleRejects.length === 0;

  const pass = microNearMiss || scaleNearMiss || microPass || scalePass;

  const allRejects = new Set([...microRejects, ...scaleRejects]);
  return { pass, rejectReasons: Array.from(allRejects) };
}

// ══════════════════════════════════════════════════════════════
//  Histogram Builder
// ══════════════════════════════════════════════════════════════

function buildHistogram(values: number[], buckets: number[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (let i = 0; i < buckets.length; i++) {
    const lo = i === 0 ? 0 : buckets[i - 1];
    const hi = buckets[i];
    hist[`${lo}-${hi}`] = values.filter((v) => v >= lo && v < hi).length;
  }
  const last = buckets[buckets.length - 1];
  hist[`${last}+`] = values.filter((v) => v >= last).length;
  return hist;
}

// ══════════════════════════════════════════════════════════════
//  Rejection Breakdown (per-tier, waterfall style)
// ══════════════════════════════════════════════════════════════

function buildRejectBreakdown(
  scored: ScoredPool[],
  getRejects: (s: ScoredPool) => string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of scored) {
    const reasons = getRejects(s);
    if (reasons.length === 0) continue;
    // Count dominant (first) reject for waterfall analysis
    const dominant = reasons[0];
    counts[dominant] = (counts[dominant] ?? 0) + 1;
  }
  return counts;
}

// ══════════════════════════════════════════════════════════════
//  Summary Generation
// ══════════════════════════════════════════════════════════════

function generateSummary(
  scored: ScoredPool[],
  softlist: SoftlistEntry[],
  microWhitelist: ListEntry[],
  scaleWhitelist: ListEntry[],
): object {
  const impact3kValues = scored.map((s) => s.impact3kPct);
  const impact100Values = scored.map((s) => s.impact100Pct);
  const liqValues = scored.map((s) => s.liquidityUsd);
  const volValues = scored.map((s) => s.volume24hUsd);

  return {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    version: "orca_pool_m1",
    scoredPools: scored.length,
    quoteFillOkCount: scored.filter((s) => s.quoteFillOk).length,
    quoteFillFailCount: scored.filter((s) => !s.quoteFillOk).length,
    softlistCount: softlist.length,
    microWhitelistCount: microWhitelist.length,
    scaleWhitelistCount: scaleWhitelist.length,
    dominantRejectReasons: {
      micro: buildRejectBreakdown(scored, getMicroRejects),
      scale: buildRejectBreakdown(scored, getScaleRejects),
    },
    histogram: {
      liquidityUsd: buildHistogram(liqValues, [40_000, 80_000, 100_000, 200_000, 400_000, 800_000]),
      volume24hUsd: buildHistogram(volValues, [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]),
      impact3kPct: buildHistogram(impact3kValues, [0.05, 0.1, 0.2, 0.5, 1.0, 1.5, 2.0, 5.0]),
      impact100Pct: buildHistogram(impact100Values, [0.01, 0.05, 0.1, 0.2, 0.5, 1.0]),
    },
    top20MicroByScore: microWhitelist.slice(0, 20),
    top20ScaleByScore: scaleWhitelist.slice(0, 20),
  };
}

// ══════════════════════════════════════════════════════════════
//  CLI & Main
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Orca Pool Scoring — M1 Micro + Scale Whitelists            ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // ── Read candidatePools.json ──
  const dataDir = path.resolve(process.cwd(), "data");
  const inputPath = path.join(dataDir, "candidatePools.json");

  let inputData: CandidatePoolsFile;
  try {
    const raw = await fs.readFile(inputPath, "utf-8");
    inputData = JSON.parse(raw) as CandidatePoolsFile;
  } catch {
    console.error(`  ✗ Failed to read ${inputPath}`);
    console.error(`    Run 'npm run discover:orca' first to generate candidatePools.json`);
    process.exit(1);
  }

  if (inputData.version !== "orca_pool_v1") {
    console.warn(`  ⚠ Expected version "orca_pool_v1", got "${inputData.version}". Proceeding anyway.`);
  }

  const pools = inputData.candidates;
  console.log(`  Input:     ${pools.length} candidate pools`);
  console.log(`  Notionals: micro=${N1_MICRO},${N2_MICRO} | scale=${N3_SCALE},${N4_SCALE},${N5_SCALE} USDC`);
  console.log(`  Method:    TVL-based deterministic impact estimation`);
  console.log(`  Dry run:   ${dryRun}\n`);

  // ── Fetch live Orca pool metadata ──
  const poolMeta = await fetchOrcaPoolMeta();

  // ── Score all pools ──
  const scored: ScoredPool[] = [];

  for (const pool of pools) {
    const meta = poolMeta.get(pool.poolId);
    const result = scorePool(pool, meta);
    scored.push(result);

    const sym = (pool.baseSymbol || pool.baseMint.slice(0, 8)).padEnd(12);
    const status = result.quoteFillOk ? "✓" : "✗";
    const tvl = meta?.tvl ?? pool.liquidityUsd;
    console.log(
      `  [Score] ${sym} ${status}  i100=${result.impact100Pct.toFixed(3)}%  i3k=${result.impact3kPct.toFixed(3)}%  cμ=${result.curveRatio_micro?.toFixed(2) ?? "—"}  cS=${result.curveRatio_scale?.toFixed(2) ?? "—"}  tvl=$${tvl.toLocaleString()}`,
    );
  }

  console.log(`\n  Scoring complete: ${scored.length} pools\n`);

  // ── Classify tiers ──
  const microWhitelist = scored.filter(classifyMicro).map(toListEntry);
  const scaleWhitelist = scored.filter(classifyScale).map(toListEntry);

  // Softlist: near-miss union
  const softlistEntries: SoftlistEntry[] = [];
  for (const s of scored) {
    const { pass, rejectReasons } = classifySoftlist(s);
    if (pass) {
      softlistEntries.push({ ...toListEntry(s), rejectReasons });
    }
  }

  // Sort all lists by score desc
  microWhitelist.sort((a, b) => b.score - a.score);
  scaleWhitelist.sort((a, b) => b.score - a.score);
  softlistEntries.sort((a, b) => b.score - a.score);

  // ── Console summary ──
  const fillOk = scored.filter((s) => s.quoteFillOk).length;
  const fillFail = scored.filter((s) => !s.quoteFillOk).length;

  console.log(`  Quote fill OK:       ${fillOk}`);
  console.log(`  Quote fill FAIL:     ${fillFail}`);
  console.log(`  Softlist count:      ${softlistEntries.length}`);
  console.log(`  Micro whitelist:     ${microWhitelist.length}`);
  console.log(`  Scale whitelist:     ${scaleWhitelist.length}`);

  // ── Micro table ──
  if (microWhitelist.length > 0) {
    console.log(`\n─── Micro Whitelist (top 20) ───────────────────────────────\n`);
    console.log(
      `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"i100%".padStart(8)} ${"cμ".padStart(6)} ${"Liq ($)".padStart(12)} ${"Fee".padStart(6)} ${"Score".padStart(8)}`,
    );
    console.log(
      `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(8)}`,
    );
    for (let i = 0; i < Math.min(microWhitelist.length, 20); i++) {
      const c = microWhitelist[i];
      console.log(
        `  ${String(i + 1).padStart(3)}  ${c.baseSymbol.padEnd(14)} ${c.impact100Pct.toFixed(3).padStart(8)} ${(c.curveRatio_micro?.toFixed(2) ?? "—").padStart(6)} ${("$" + c.liquidityUsd.toLocaleString()).padStart(12)} ${(c.feeBps + "bp").padStart(6)} ${c.score.toFixed(3).padStart(8)}`,
      );
    }
  } else {
    console.log(`\n  ⚠ No micro whitelist candidates.`);
  }

  // ── Scale table ──
  if (scaleWhitelist.length > 0) {
    console.log(`\n─── Scale Whitelist (top 20) ───────────────────────────────\n`);
    console.log(
      `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"i3k%".padStart(8)} ${"cS".padStart(6)} ${"Liq ($)".padStart(12)} ${"Fee".padStart(6)} ${"Score".padStart(8)}`,
    );
    console.log(
      `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(8)}`,
    );
    for (let i = 0; i < Math.min(scaleWhitelist.length, 20); i++) {
      const c = scaleWhitelist[i];
      console.log(
        `  ${String(i + 1).padStart(3)}  ${c.baseSymbol.padEnd(14)} ${c.impact3kPct.toFixed(3).padStart(8)} ${(c.curveRatio_scale?.toFixed(2) ?? "—").padStart(6)} ${("$" + c.liquidityUsd.toLocaleString()).padStart(12)} ${(c.feeBps + "bp").padStart(6)} ${c.score.toFixed(3).padStart(8)}`,
      );
    }
  } else {
    console.log(`\n  ⚠ No scale whitelist candidates.`);
  }

  // ── Rejection breakdown ──
  console.log(`\n─── Dominant Reject Reasons ────────────────────────────────\n`);
  console.log(`  MICRO tier:`);
  const microRejects = buildRejectBreakdown(scored, getMicroRejects);
  for (const [reason, count] of Object.entries(microRejects).sort((a, b) => b[1] - a[1])) {
    if (count > 0) console.log(`    ${reason.padEnd(20)} ${count}`);
  }
  console.log(`\n  SCALE tier:`);
  const scaleRejects = buildRejectBreakdown(scored, getScaleRejects);
  for (const [reason, count] of Object.entries(scaleRejects).sort((a, b) => b[1] - a[1])) {
    if (count > 0) console.log(`    ${reason.padEnd(20)} ${count}`);
  }

  // ── Write outputs ──
  if (dryRun) {
    console.log(`\n  [DRY RUN] Skipping file writes.\n`);
    return;
  }

  await fs.mkdir(dataDir, { recursive: true });

  // 1. orca_pool_scores.json
  const scoresPath = path.join(dataDir, "orca_pool_scores.json");
  await fs.writeFile(
    scoresPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "orca_pool_m1",
        pools: scored.map((s) => ({
          poolId: s.poolId,
          baseMint: s.baseMint,
          baseSymbol: s.baseSymbol,
          baseDecimals: s.baseDecimals,
          liquidityUsd: s.liquidityUsd,
          volume24hUsd: s.volume24hUsd,
          volumeLiquidityRatio: s.volumeLiquidityRatio,
          feeBps: s.feeBps,
          tickSpacing: s.tickSpacing,
          impact30Pct: s.impact30Pct,
          impact100Pct: s.impact100Pct,
          impact1kPct: s.impact1kPct,
          impact3kPct: s.impact3kPct,
          impact5kPct: s.impact5kPct,
          curveRatio_micro: s.curveRatio_micro,
          curveRatio_scale: s.curveRatio_scale,
          quoteFillOk: s.quoteFillOk,
          quoteError: s.quoteError ?? null,
          score: s.score,
          poolMeta: s.poolMeta,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`\n  ✓ Scores written to ${scoresPath}`);

  // 2. poolSoftlist.json
  const softlistPath = path.join(dataDir, "poolSoftlist.json");
  await fs.writeFile(
    softlistPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "orca_pool_m1",
        description: "Research candidates: union of near-miss micro + scale (fail <= 2 conditions)",
        microThresholds: MICRO_THRESHOLDS,
        scaleThresholds: SCALE_THRESHOLDS,
        pools: softlistEntries,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Softlist (${softlistEntries.length} pools) written to ${softlistPath}`);

  // 3. poolWhitelist_micro.json
  const microPath = path.join(dataDir, "poolWhitelist_micro.json");
  await fs.writeFile(
    microPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "orca_pool_m1",
        tier: "micro",
        sizingRange: "$20–$100",
        thresholds: MICRO_THRESHOLDS,
        pools: microWhitelist,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Micro whitelist (${microWhitelist.length} pools) written to ${microPath}`);

  // 4. poolWhitelist_scale.json
  const scalePath = path.join(dataDir, "poolWhitelist_scale.json");
  await fs.writeFile(
    scalePath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "orca_pool_m1",
        tier: "scale",
        sizingRange: "$1k–$3k",
        thresholds: SCALE_THRESHOLDS,
        pools: scaleWhitelist,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Scale whitelist (${scaleWhitelist.length} pools) written to ${scalePath}`);

  // 5. orca_pool_summary.json
  const summary = generateSummary(scored, softlistEntries, microWhitelist, scaleWhitelist);
  const summaryPath = path.join(dataDir, "orca_pool_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Summary written to ${summaryPath}`);

  // ── Acceptance criteria ──
  console.log(`\n─── M1 Acceptance Criteria ─────────────────────────────────\n`);
  console.log(`  [${softlistEntries.length > 0 ? "✓" : "✗"}] poolSoftlist.json count > 0: ${softlistEntries.length}`);
  console.log(`  [${microWhitelist.length >= 10 ? "✓" : "⚠"}] poolWhitelist_micro count >= 10 (target): ${microWhitelist.length}`);
  console.log(`  [${scaleWhitelist.length >= 3 ? "✓" : "⚠"}] poolWhitelist_scale count >= 3 (target): ${scaleWhitelist.length}`);
  console.log(`  [✓] orca_pool_summary.json with dominant rejection reasons`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
