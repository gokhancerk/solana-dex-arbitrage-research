/**
 * Orca-only Pool Discovery — Route=1 Candidate Whitelist Generator (Step 1)
 *
 * Enumerates Orca Whirlpools with USDC quote, applies deterministic
 * filtering (liquidity, volume, vol/liq ratio, fee, excluded mints),
 * scores, deduplicates by baseMint, and outputs:
 *   - data/candidatePools.json   (pool-based candidate universe)
 *   - data/orca_discovery_report.json (reject histograms, coverage)
 *
 * Usage:
 *   npm run discover:orca
 *   npx tsx src/scripts/discoverOrcaPools.ts
 *   npx tsx src/scripts/discoverOrcaPools.ts --target 200
 *   npx tsx src/scripts/discoverOrcaPools.ts --dry
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants (deterministic — spec v1)
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Target output candidate count */
const DEFAULT_TARGET_N = 200;

/** Liquidity band (research) */
const MIN_LIQ_USD = 40_000;
const MAX_LIQ_USD = 800_000;

/** Minimum 24h volume */
const MIN_VOL_24H_USD = 20_000;

/** Minimum volume / liquidity ratio */
const MIN_VOL_LIQ_RATIO = 0.03;

/** Maximum fee in basis points */
const MAX_FEE_BPS = 100;

// ══════════════════════════════════════════════════════════════
//  Reject Reason Types
// ══════════════════════════════════════════════════════════════

type RejectReason =
  | "TOO_LOW_LIQ"
  | "TOO_HIGH_LIQ"
  | "TOO_LOW_VOL"
  | "LOW_VOL_LIQ_RATIO"
  | "EXCLUDED_BASE_MINT"
  | "BAD_FEE"
  | "MISSING_FIELDS";

// ══════════════════════════════════════════════════════════════
//  Data Structures
// ══════════════════════════════════════════════════════════════

interface OrcaWhirlpool {
  address: string;
  tokenA: { mint: string; symbol: string; decimals: number };
  tokenB: { mint: string; symbol: string; decimals: number };
  tvl?: number;
  volume?: { day?: number };
  feeRate?: number;
  lpFeeRate?: number;
  protocolFeeRate?: number;
  tickSpacing?: number;
  price?: number;
}

interface CandidatePool {
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

async function loadExcludeMints(): Promise<Set<string>> {
  const mints = new Set<string>();

  // 1. data/exclude_mints.json (spec-required)
  try {
    const raw = await fs.readFile(
      path.resolve(process.cwd(), "data", "exclude_mints.json"),
      "utf-8",
    );
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (typeof m === "string") mints.add(m);
      }
    }
  } catch {
    // file not found — ok, use empty
  }

  // 2. data/telemetry/blacklistPairs.json (existing project convention)
  try {
    const raw = await fs.readFile(
      path.resolve(process.cwd(), "data", "telemetry", "blacklistPairs.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === "string") mints.add(entry);
        else if (entry?.baseMint) mints.add(entry.baseMint);
      }
    }
  } catch {
    // no blacklist file — ok
  }

  return mints;
}

// ══════════════════════════════════════════════════════════════
//  Orca API
// ══════════════════════════════════════════════════════════════

async function fetchOrcaWhirlpools(): Promise<OrcaWhirlpool[]> {
  console.log("  [Orca] Fetching whirlpool list…");

  const res = await fetchWithRetry("https://api.mainnet.orca.so/v1/whirlpool/list");
  const data = (await res.json()) as { whirlpools?: OrcaWhirlpool[] };

  const whirlpools = data.whirlpools ?? [];
  console.log(`  [Orca] ${whirlpools.length} whirlpools fetched`);
  return whirlpools;
}

// ══════════════════════════════════════════════════════════════
//  Filter + Score Engine
// ══════════════════════════════════════════════════════════════

function discoverAndFilter(
  whirlpools: OrcaWhirlpool[],
  excludeMints: Set<string>,
  targetN: number,
): {
  candidates: CandidatePool[];
  scannedPools: number;
  poolsWithUsdc: number;
  acceptedCandidates: number;
  rejectReasonsHistogram: Record<RejectReason, number>;
} {
  const rejectReasonsHistogram: Record<RejectReason, number> = {
    TOO_LOW_LIQ: 0,
    TOO_HIGH_LIQ: 0,
    TOO_LOW_VOL: 0,
    LOW_VOL_LIQ_RATIO: 0,
    EXCLUDED_BASE_MINT: 0,
    BAD_FEE: 0,
    MISSING_FIELDS: 0,
  };

  // Sort input by address for stable ordering (spec requirement)
  const sorted = [...whirlpools].sort((a, b) => a.address.localeCompare(b.address));

  // Step 1: extract USDC pools
  const usdcPools: Array<{
    wp: OrcaWhirlpool;
    baseMint: string;
    baseSymbol: string;
    baseDecimals: number;
  }> = [];

  for (const wp of sorted) {
    let baseMint: string;
    let baseSymbol: string;
    let baseDecimals: number;

    if (wp.tokenB.mint === USDC_MINT) {
      baseMint = wp.tokenA.mint;
      baseSymbol = wp.tokenA.symbol;
      baseDecimals = wp.tokenA.decimals;
    } else if (wp.tokenA.mint === USDC_MINT) {
      baseMint = wp.tokenB.mint;
      baseSymbol = wp.tokenB.symbol;
      baseDecimals = wp.tokenB.decimals;
    } else {
      continue; // not a USDC pair
    }

    usdcPools.push({ wp, baseMint, baseSymbol, baseDecimals });
  }

  console.log(`  [Filter] ${usdcPools.length} USDC pools from ${sorted.length} total`);

  // Step 2-6: apply filters
  const passed: CandidatePool[] = [];

  for (const { wp, baseMint, baseSymbol, baseDecimals } of usdcPools) {
    // 1. reject if missing tvlUsd or volume24hUsd (v1 — no approximation)
    const tvlUsd = wp.tvl;
    const vol24h = wp.volume?.day;
    if (tvlUsd === undefined || tvlUsd === null || vol24h === undefined || vol24h === null) {
      rejectReasonsHistogram.MISSING_FIELDS++;
      continue;
    }

    // 2. reject if baseMint is excluded
    if (excludeMints.has(baseMint)) {
      rejectReasonsHistogram.EXCLUDED_BASE_MINT++;
      continue;
    }

    // 3. liquidity band
    if (tvlUsd < MIN_LIQ_USD) {
      rejectReasonsHistogram.TOO_LOW_LIQ++;
      continue;
    }
    if (tvlUsd > MAX_LIQ_USD) {
      rejectReasonsHistogram.TOO_HIGH_LIQ++;
      continue;
    }
    if (vol24h < MIN_VOL_24H_USD) {
      rejectReasonsHistogram.TOO_LOW_VOL++;
      continue;
    }

    const volLiqRatio = tvlUsd > 0 ? vol24h / tvlUsd : 0;
    if (volLiqRatio < MIN_VOL_LIQ_RATIO) {
      rejectReasonsHistogram.LOW_VOL_LIQ_RATIO++;
      continue;
    }

    const feePct = wp.feeRate ?? wp.lpFeeRate ?? 0;
    const feeBps = Math.round(feePct * 10_000);
    if (feeBps > MAX_FEE_BPS) {
      rejectReasonsHistogram.BAD_FEE++;
      continue;
    }

    // Ranking score: 0.6*log10(volume24hUsd) + 0.4*log10(liquidityUsd)
    const score =
      0.6 * Math.log10(Math.max(vol24h, 1)) +
      0.4 * Math.log10(Math.max(tvlUsd, 1));

    passed.push({
      poolId: wp.address,
      baseMint,
      quoteMint: USDC_MINT,
      tokenMintA: wp.tokenA.mint,
      tokenMintB: wp.tokenB.mint,
      baseSymbol,
      baseDecimals,
      liquidityUsd: Math.round(tvlUsd),
      volume24hUsd: Math.round(vol24h),
      volumeLiquidityRatio: Number(volLiqRatio.toFixed(4)),
      feeBps,
      tickSpacing: wp.tickSpacing ?? 0,
      score: Number(score.toFixed(6)),
    });
  }

  // 6. Deduplicate by baseMint (keep highest scored pool)
  const bestByMint = new Map<string, CandidatePool>();
  for (const c of passed) {
    const existing = bestByMint.get(c.baseMint);
    if (!existing || c.score > existing.score) {
      bestByMint.set(c.baseMint, c);
    }
  }

  // Sort by score desc; stable tie-break by poolId asc
  const deduped = Array.from(bestByMint.values());
  deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.poolId.localeCompare(b.poolId);
  });

  // Take top TARGET_N
  const final = deduped.slice(0, targetN);

  return {
    candidates: final,
    scannedPools: sorted.length,
    poolsWithUsdc: usdcPools.length,
    acceptedCandidates: final.length,
    rejectReasonsHistogram,
  };
}

// ══════════════════════════════════════════════════════════════
//  CLI & Main
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

function getArgVal(name: string, defaultVal: number): number {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return Number(args[idx + 1]) || defaultVal;
  return defaultVal;
}

const dryRun = args.includes("--dry");
const TARGET_N = getArgVal("--target", DEFAULT_TARGET_N);

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Orca Pool Discovery — Route=1 Candidate Generator (v1)     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Quote mint:   USDC (${USDC_MINT.slice(0, 8)}…)`);
  console.log(`  Pool type:    whirlpool (Orca CLMM)`);
  console.log(`  Source:       orca`);
  console.log(`  Liq band:     $${MIN_LIQ_USD.toLocaleString()} – $${MAX_LIQ_USD.toLocaleString()}`);
  console.log(`  Min vol 24h:  $${MIN_VOL_24H_USD.toLocaleString()}`);
  console.log(`  Vol/Liq:      ≥ ${MIN_VOL_LIQ_RATIO}`);
  console.log(`  Max fee:      ${MAX_FEE_BPS} bps`);
  console.log(`  Target N:     ${TARGET_N}`);
  console.log(`  Dry run:      ${dryRun}\n`);

  // Load exclude mints
  const excludeMints = await loadExcludeMints();
  console.log(`  Loaded ${excludeMints.size} excluded mints\n`);

  // Fetch Orca whirlpools
  const whirlpools = await fetchOrcaWhirlpools();

  // Filter and rank
  const result = discoverAndFilter(whirlpools, excludeMints, TARGET_N);
  const { candidates, scannedPools, poolsWithUsdc, acceptedCandidates, rejectReasonsHistogram } = result;

  // ── Reject Histogram ──
  console.log(`\n─── Reject Histogram ────────────────────────────────────────\n`);
  for (const [reason, count] of Object.entries(rejectReasonsHistogram)) {
    if (count > 0) console.log(`  ${reason.padEnd(24)} ${count}`);
  }

  // ── Summary table ──
  console.log(`\n─── Top ${Math.min(candidates.length, 30)} Candidates ───────────────────────────────\n`);
  console.log(
    `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"Liq ($)".padStart(12)} ${"Vol ($)".padStart(12)} ${"Vol/Liq".padStart(8)} ${"Fee".padStart(6)} ${"Score".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(8)}`,
  );

  for (let i = 0; i < Math.min(candidates.length, 30); i++) {
    const c = candidates[i];
    console.log(
      `  ${String(i + 1).padStart(3)}  ${(c.baseSymbol ?? c.baseMint.slice(0, 10)).padEnd(14)} ${("$" + c.liquidityUsd.toLocaleString()).padStart(12)} ${("$" + c.volume24hUsd.toLocaleString()).padStart(12)} ${c.volumeLiquidityRatio.toFixed(2).padStart(8)} ${(c.feeBps + "bp").padStart(6)} ${c.score.toFixed(3).padStart(8)}`,
    );
  }

  console.log(`\n  Summary: ${scannedPools} scanned → ${poolsWithUsdc} USDC pools → ${acceptedCandidates} accepted candidates\n`);

  if (candidates.length === 0) {
    console.log(`  ⚠ No candidates found. Try relaxing filters.\n`);
    return;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Skipping file writes.\n`);
    return;
  }

  // ── Write outputs ──
  const dataDir = path.resolve(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  // 1. candidatePools.json
  const candidatePoolsOutput = {
    generatedAtMs: Date.now(),
    version: "orca_pool_v1",
    quoteMint: USDC_MINT,
    poolType: "whirlpool",
    source: "orca",
    candidates: candidates.map((c) => ({
      poolId: c.poolId,
      baseMint: c.baseMint,
      quoteMint: c.quoteMint,
      tokenMintA: c.tokenMintA,
      tokenMintB: c.tokenMintB,
      baseSymbol: c.baseSymbol,
      baseDecimals: c.baseDecimals,
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
      volumeLiquidityRatio: c.volumeLiquidityRatio,
      feeBps: c.feeBps,
      tickSpacing: c.tickSpacing,
      score: c.score,
    })),
  };

  const candidatePath = path.join(dataDir, "candidatePools.json");
  await fs.writeFile(candidatePath, JSON.stringify(candidatePoolsOutput, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Written ${candidates.length} candidates to ${candidatePath}`);

  // 2. orca_discovery_report.json
  const report = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    version: "orca_pool_v1",
    parameters: {
      USDC_MINT,
      MIN_LIQ_USD,
      MAX_LIQ_USD,
      MIN_VOL_24H_USD,
      MIN_VOL_LIQ_RATIO,
      MAX_FEE_BPS,
      TARGET_N,
    },
    scannedPools,
    poolsWithUsdc,
    acceptedCandidates,
    rejectReasonsHistogram,
    top20ByScore: candidates.slice(0, 20).map((c) => ({
      poolId: c.poolId,
      baseMint: c.baseMint,
      baseSymbol: c.baseSymbol,
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
      volumeLiquidityRatio: c.volumeLiquidityRatio,
      feeBps: c.feeBps,
      score: c.score,
    })),
  };

  const reportPath = path.join(dataDir, "orca_discovery_report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Discovery report saved to ${reportPath}\n`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
