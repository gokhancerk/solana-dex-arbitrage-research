/**
 * Raydium CPMM USDC Pool Discovery — M2 Step 1
 *
 * Fetches Raydium pool registry, filters to CPMM-only USDC pools,
 * applies deterministic filtering (liquidity, volume, vol/liq, fee,
 * excluded mints), scores, deduplicates by baseMint, and outputs:
 *
 *   - data/raydium_candidatePools.json
 *   - data/raydium_discovery_report.json
 *
 * Usage:
 *   npm run discover:raydium
 *   npx tsx src/scripts/discoverRaydiumCpmmPools.ts
 *   npx tsx src/scripts/discoverRaydiumCpmmPools.ts --target 200
 *   npx tsx src/scripts/discoverRaydiumCpmmPools.ts --dry
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants (deterministic — M2 spec)
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DEFAULT_TARGET_N = 200;

const MIN_LIQ_USD = 40_000;
const MAX_LIQ_USD = 800_000;
const MIN_VOL_24H_USD = 20_000;
const MIN_VOL_LIQ_RATIO = 0.03;
const MAX_FEE_BPS = 100;

/** Max pages to paginate Raydium API (deterministic cap) */
const MAX_PAGES = 10;
const PAGE_SIZE = 1_000;

// ══════════════════════════════════════════════════════════════
//  Reject Reason Types
// ══════════════════════════════════════════════════════════════

type RejectReason =
  | "MISSING_FIELDS"
  | "EXCLUDED_BASE_MINT"
  | "NOT_CPMM"
  | "NOT_USDC_QUOTE"
  | "TOO_LOW_LIQ"
  | "TOO_HIGH_LIQ"
  | "TOO_LOW_VOL"
  | "LOW_VOL_LIQ_RATIO"
  | "BAD_FEE";

// ══════════════════════════════════════════════════════════════
//  Data Structures
// ══════════════════════════════════════════════════════════════

interface RaydiumApiPool {
  id: string;
  type: string; // "Standard" | "Concentrated" | "Cpmm"
  mintA: { address: string; symbol: string; decimals: number };
  mintB: { address: string; symbol: string; decimals: number };
  tvl?: number;
  day?: { volume?: number; volumeQuote?: number };
  feeRate?: number;
  config?: { tradeFeeRate?: number };
}

interface CandidatePool {
  poolId: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  baseDecimals: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volumeLiquidityRatio: number;
  feeBps: number;
  poolType: string;
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
    // file not found — ok
  }

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
//  Raydium v3 API — Paginated Fetch
// ══════════════════════════════════════════════════════════════

/**
 * Returns true if the pool type string represents a CPMM pool
 * (constant-product market maker). Includes "Standard" (legacy AMM v4)
 * and "Cpmm" (new Raydium CPMM program). Excludes "Concentrated"/CLMM.
 */
function isCpmmType(typeStr: string): boolean {
  const t = typeStr.toLowerCase();
  if (t.includes("concentrated") || t.includes("clmm")) return false;
  return true; // "standard", "cpmm", or empty
}

async function fetchRaydiumPools(): Promise<{
  allPools: RaydiumApiPool[];
  totalFetched: number;
}> {
  console.log("  [Raydium] Fetching pool list (paginated)…");
  const allPools: RaydiumApiPool[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_PAGES) {
    const url = `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${PAGE_SIZE}&page=${page}`;

    try {
      const res = await fetchWithRetry(url);
      const data = (await res.json()) as {
        success: boolean;
        data?: {
          count?: number;
          data?: RaydiumApiPool[];
        };
      };

      const items = data.data?.data ?? [];
      if (items.length === 0) {
        hasMore = false;
        break;
      }

      allPools.push(...items);
      console.log(`  [Raydium] Page ${page}: ${items.length} pools (${allPools.length} total so far)`);

      if (items.length < PAGE_SIZE) {
        hasMore = false;
      } else {
        page++;
      }

      await sleep(1_000); // rate limit
    } catch (err) {
      console.warn(`  [Raydium] Page ${page} error: ${err instanceof Error ? err.message : String(err)}`);
      hasMore = false;
    }
  }

  console.log(`  [Raydium] ${allPools.length} total pools fetched`);
  return { allPools, totalFetched: allPools.length };
}

// ══════════════════════════════════════════════════════════════
//  Filter + Score Engine
// ══════════════════════════════════════════════════════════════

function discoverAndFilter(
  rawPools: RaydiumApiPool[],
  excludeMints: Set<string>,
  targetN: number,
): {
  candidates: CandidatePool[];
  scannedPools: number;
  cpmmUsdcPools: number;
  acceptedCandidates: number;
  rejectReasonsHistogram: Record<RejectReason, number>;
} {
  const hist: Record<RejectReason, number> = {
    MISSING_FIELDS: 0,
    EXCLUDED_BASE_MINT: 0,
    NOT_CPMM: 0,
    NOT_USDC_QUOTE: 0,
    TOO_LOW_LIQ: 0,
    TOO_HIGH_LIQ: 0,
    TOO_LOW_VOL: 0,
    LOW_VOL_LIQ_RATIO: 0,
    BAD_FEE: 0,
  };

  // Sort by pool id for stable ordering
  const sorted = [...rawPools].sort((a, b) => a.id.localeCompare(b.id));

  // Step 1: Filter CPMM + USDC pools
  const cpmmUsdcPools: Array<{
    pool: RaydiumApiPool;
    baseMint: string;
    baseSymbol: string;
    baseDecimals: number;
    poolTypeStr: string;
  }> = [];

  for (const pool of sorted) {
    // 1. NOT_CPMM check
    if (!isCpmmType(pool.type ?? "")) {
      hist.NOT_CPMM++;
      continue;
    }

    // 2. NOT_USDC_QUOTE check
    let baseMint: string;
    let baseSymbol: string;
    let baseDecimals: number;

    if (pool.mintB?.address === USDC_MINT) {
      baseMint = pool.mintA.address;
      baseSymbol = pool.mintA.symbol;
      baseDecimals = pool.mintA.decimals;
    } else if (pool.mintA?.address === USDC_MINT) {
      baseMint = pool.mintB.address;
      baseSymbol = pool.mintB.symbol;
      baseDecimals = pool.mintB.decimals;
    } else {
      hist.NOT_USDC_QUOTE++;
      continue;
    }

    cpmmUsdcPools.push({
      pool,
      baseMint,
      baseSymbol,
      baseDecimals,
      poolTypeStr: (pool.type ?? "standard").toLowerCase(),
    });
  }

  console.log(`  [Filter] ${cpmmUsdcPools.length} CPMM USDC pools from ${sorted.length} total`);

  // Step 2: Apply research filters
  const passed: CandidatePool[] = [];

  for (const { pool, baseMint, baseSymbol, baseDecimals, poolTypeStr } of cpmmUsdcPools) {
    // MISSING_FIELDS
    const tvlUsd = pool.tvl;
    const vol24h = pool.day?.volume ?? pool.day?.volumeQuote ?? null;
    if (tvlUsd === undefined || tvlUsd === null || vol24h === undefined || vol24h === null) {
      hist.MISSING_FIELDS++;
      continue;
    }

    // EXCLUDED_BASE_MINT
    if (excludeMints.has(baseMint)) {
      hist.EXCLUDED_BASE_MINT++;
      continue;
    }

    // Liquidity band
    if (tvlUsd < MIN_LIQ_USD) {
      hist.TOO_LOW_LIQ++;
      continue;
    }
    if (tvlUsd > MAX_LIQ_USD) {
      hist.TOO_HIGH_LIQ++;
      continue;
    }

    // Volume
    if (vol24h < MIN_VOL_24H_USD) {
      hist.TOO_LOW_VOL++;
      continue;
    }

    // Vol/Liq ratio
    const volLiqRatio = tvlUsd > 0 ? vol24h / tvlUsd : 0;
    if (volLiqRatio < MIN_VOL_LIQ_RATIO) {
      hist.LOW_VOL_LIQ_RATIO++;
      continue;
    }

    // Fee
    const feeRaw = pool.feeRate ?? pool.config?.tradeFeeRate ?? 0;
    const feeBps = feeRaw > 1 ? Math.round(feeRaw) : Math.round(feeRaw * 10_000);
    if (feeBps > MAX_FEE_BPS) {
      hist.BAD_FEE++;
      continue;
    }

    // Score: 0.6*log10(volume24hUsd) + 0.4*log10(liquidityUsd)
    const score =
      0.6 * Math.log10(Math.max(vol24h, 1)) +
      0.4 * Math.log10(Math.max(tvlUsd, 1));

    passed.push({
      poolId: pool.id,
      baseMint,
      quoteMint: USDC_MINT,
      baseSymbol,
      baseDecimals,
      liquidityUsd: Math.round(tvlUsd),
      volume24hUsd: Math.round(vol24h),
      volumeLiquidityRatio: Number(volLiqRatio.toFixed(4)),
      feeBps,
      poolType: poolTypeStr.includes("cpmm") ? "cpmm" : "standard",
      score: Number(score.toFixed(6)),
    });
  }

  // Deduplicate by baseMint (keep highest scored pool)
  const bestByMint = new Map<string, CandidatePool>();
  for (const c of passed) {
    const existing = bestByMint.get(c.baseMint);
    if (!existing || c.score > existing.score) {
      bestByMint.set(c.baseMint, c);
    }
  }

  // Sort by score desc; tie-break by poolId asc
  const deduped = Array.from(bestByMint.values());
  deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.poolId.localeCompare(b.poolId);
  });

  const final = deduped.slice(0, targetN);

  return {
    candidates: final,
    scannedPools: sorted.length,
    cpmmUsdcPools: cpmmUsdcPools.length,
    acceptedCandidates: final.length,
    rejectReasonsHistogram: hist,
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
  console.log(`║  Raydium CPMM Discovery — M2 Step 1                         ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Quote mint:   USDC (${USDC_MINT.slice(0, 8)}…)`);
  console.log(`  Pool type:    CPMM only (exclude CLMM/Concentrated)`);
  console.log(`  Source:       raydium v3 API`);
  console.log(`  Liq band:     $${MIN_LIQ_USD.toLocaleString()} – $${MAX_LIQ_USD.toLocaleString()}`);
  console.log(`  Min vol 24h:  $${MIN_VOL_24H_USD.toLocaleString()}`);
  console.log(`  Vol/Liq:      ≥ ${MIN_VOL_LIQ_RATIO}`);
  console.log(`  Max fee:      ${MAX_FEE_BPS} bps`);
  console.log(`  Target N:     ${TARGET_N}`);
  console.log(`  Dry run:      ${dryRun}\n`);

  const excludeMints = await loadExcludeMints();
  console.log(`  Loaded ${excludeMints.size} excluded mints\n`);

  const { allPools } = await fetchRaydiumPools();

  const result = discoverAndFilter(allPools, excludeMints, TARGET_N);
  const { candidates, scannedPools, cpmmUsdcPools, acceptedCandidates, rejectReasonsHistogram } = result;

  // ── Reject Histogram ──
  console.log(`\n─── Reject Histogram ────────────────────────────────────────\n`);
  for (const [reason, count] of Object.entries(rejectReasonsHistogram)) {
    if (count > 0) console.log(`  ${reason.padEnd(24)} ${count}`);
  }

  // ── Summary table ──
  const showN = Math.min(candidates.length, 30);
  console.log(`\n─── Top ${showN} Candidates ───────────────────────────────\n`);
  console.log(
    `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"Type".padEnd(10)} ${"Liq ($)".padStart(12)} ${"Vol ($)".padStart(12)} ${"Vol/Liq".padStart(8)} ${"Fee".padStart(6)} ${"Score".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(10)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(8)}`,
  );

  for (let i = 0; i < showN; i++) {
    const c = candidates[i];
    console.log(
      `  ${String(i + 1).padStart(3)}  ${(c.baseSymbol ?? c.baseMint.slice(0, 10)).padEnd(14)} ${c.poolType.padEnd(10)} ${("$" + c.liquidityUsd.toLocaleString()).padStart(12)} ${("$" + c.volume24hUsd.toLocaleString()).padStart(12)} ${c.volumeLiquidityRatio.toFixed(2).padStart(8)} ${(c.feeBps + "bp").padStart(6)} ${c.score.toFixed(3).padStart(8)}`,
    );
  }

  console.log(`\n  Summary: ${scannedPools} scanned → ${cpmmUsdcPools} CPMM USDC pools → ${acceptedCandidates} accepted candidates\n`);

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

  // 1. raydium_candidatePools.json
  const candidatePoolsOutput = {
    generatedAtMs: Date.now(),
    version: "raydium_cpmm_v1",
    quoteMint: USDC_MINT,
    poolType: "cpmm",
    source: "raydium",
    candidates: candidates.map((c) => ({
      poolId: c.poolId,
      baseMint: c.baseMint,
      quoteMint: c.quoteMint,
      baseSymbol: c.baseSymbol,
      baseDecimals: c.baseDecimals,
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
      volumeLiquidityRatio: c.volumeLiquidityRatio,
      feeBps: c.feeBps,
      poolType: c.poolType,
      score: c.score,
    })),
  };

  const candidatePath = path.join(dataDir, "raydium_candidatePools.json");
  await fs.writeFile(candidatePath, JSON.stringify(candidatePoolsOutput, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Written ${candidates.length} candidates to ${candidatePath}`);

  // 2. raydium_discovery_report.json
  const report = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    version: "raydium_cpmm_v1",
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
    cpmmUsdcPools,
    acceptedCandidates,
    rejectReasonsHistogram,
    top30ByScore: candidates.slice(0, 30).map((c) => ({
      poolId: c.poolId,
      baseMint: c.baseMint,
      baseSymbol: c.baseSymbol,
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
      volumeLiquidityRatio: c.volumeLiquidityRatio,
      feeBps: c.feeBps,
      poolType: c.poolType,
      score: c.score,
    })),
  };

  const reportPath = path.join(dataDir, "raydium_discovery_report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Discovery report saved to ${reportPath}\n`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
