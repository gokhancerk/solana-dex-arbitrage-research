/**
 * Discovery Script v2 — Pool/DEX-based "Shallow Route" Candidate Generator
 *
 * Instead of "pick tokens then ask Jupiter for routes", we:
 *   1. Enumerate pools where quoteMint == USDC from Orca, Raydium, Meteora
 *   2. Apply mid-liquidity + volume filters
 *   3. Output base mints from direct USDC pools so Jupiter can route with 1–2 hops
 *
 * Output:
 *   - data/candidatePairs.json  (v2 format with pool metadata)
 *   - data/discovery_report.json (reject histograms, dex coverage, top 20)
 *
 * Usage:
 *   npx tsx src/scripts/discoverCandidatesV2.ts
 *   npx tsx src/scripts/discoverCandidatesV2.ts --target 150
 *   npx tsx src/scripts/discoverCandidatesV2.ts --dry
 *   npx tsx src/scripts/discoverCandidatesV2.ts --dex orca
 *   npx tsx src/scripts/discoverCandidatesV2.ts --dex raydium
 *   npx tsx src/scripts/discoverCandidatesV2.ts --dex meteora
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants (deterministic — do not auto-tune in v2)
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

/** Liquidity band for mid-liq Type C pools (v2.1: lowered MIN for research breadth) */
const MIN_LIQ_USD = 40_000;
const MAX_LIQ_USD = 800_000;

/** C1 candidates — direct USDC pools that should route with ≤3 hops */
/** Lower liq floor for C1 quota candidates (research breadth) */
const MIN_LIQ_USD_C1 = 25_000;
/** Minimum number of C1 (direct USDC) candidates in the final set */
const C1_QUOTA = 50;

/** Minimum 24h volume (v2.1: lowered for broader research coverage) */
const MIN_VOL_24H_USD = 20_000;

/** Minimum volume/liquidity ratio (v2.1: relaxed) */
const MIN_VOL_LIQ_RATIO = 0.03;

/** Pool type allowlist — default: shallow-route friendly types only (v2.1) */
const DEFAULT_ALLOW_POOL_TYPES: ReadonlySet<string> = new Set(["cpmm", "whirlpool"]);
const DEFAULT_DENY_POOL_TYPES: ReadonlySet<string> = new Set(["dlmm", "clmm"]);

/** Maximum fee in basis points (reject > 100 bps) */
const MAX_FEE_BPS = 100;

/** DEX sources in fixed evaluation order */
const DEX_SOURCES = ["orca", "raydium", "meteora"] as const;
type DexSource = (typeof DEX_SOURCES)[number];

/** Excluded base mints — SOL, JUP, major stables, and known large caps */
const EXCLUDE_BASE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",    // SOL (WSOL)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
]);

// ── Also load data/telemetry/blacklistPairs.json if it exists ──
async function loadBlacklistMints(): Promise<Set<string>> {
  const extra = new Set<string>();
  try {
    const raw = await fs.readFile(
      path.resolve(process.cwd(), "data", "telemetry", "blacklistPairs.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === "string") extra.add(entry);
        else if (entry?.baseMint) extra.add(entry.baseMint);
      }
    }
  } catch {
    // no blacklist file — ok
  }
  return extra;
}

// ══════════════════════════════════════════════════════════════
//  Unified Pool Interface
// ══════════════════════════════════════════════════════════════

interface RawPool {
  baseMint: string;
  quoteMint: string;
  poolId: string;
  poolType: "cpmm" | "clmm" | "dlmm" | "whirlpool";
  sourceDex: DexSource;
  liquidityUsd: number;
  volume24hUsd: number | null;
  feeBps: number;
  tickSpacing: number | null;
  baseSymbol?: string;
  baseDecimals?: number;
}

// ══════════════════════════════════════════════════════════════
//  Pool Adapters
// ══════════════════════════════════════════════════════════════

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
        console.warn(`  [HTTP] 429 on ${url.slice(0, 80)}… retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Orca Whirlpools ───

async function listOrcaPools(): Promise<RawPool[]> {
  console.log("  [Orca] Fetching whirlpool list…");

  const res = await fetchWithRetry("https://api.mainnet.orca.so/v1/whirlpool/list");
  const data = (await res.json()) as {
    whirlpools?: Array<{
      address: string;
      tokenA: { mint: string; symbol: string; decimals: number };
      tokenB: { mint: string; symbol: string; decimals: number };
      tvl?: number;
      volume?: { day?: number };
      feeRate?: number;       // 0–1 range (e.g., 0.003 = 30 bps)
      tickSpacing?: number;
      price?: number;
      lpFeeRate?: number;
      protocolFeeRate?: number;
    }>;
  };

  const pools: RawPool[] = [];
  const whirlpools = data.whirlpools ?? [];
  console.log(`  [Orca] ${whirlpools.length} whirlpools fetched`);

  for (const wp of whirlpools) {
    // Determine which side is USDC
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

    const feePct = wp.feeRate ?? wp.lpFeeRate ?? 0;
    const feeBps = Math.round(feePct * 10_000); // e.g., 0.003 → 30

    pools.push({
      baseMint,
      quoteMint: USDC_MINT,
      poolId: wp.address,
      poolType: "whirlpool",
      sourceDex: "orca",
      liquidityUsd: wp.tvl ?? 0,
      volume24hUsd: wp.volume?.day ?? null,
      feeBps,
      tickSpacing: wp.tickSpacing ?? null,
      baseSymbol,
      baseDecimals,
    });
  }

  console.log(`  [Orca] ${pools.length} USDC pools extracted`);
  return pools;
}

// ─── Raydium ───

async function listRaydiumPools(): Promise<RawPool[]> {
  console.log("  [Raydium] Fetching pool list…");

  // Raydium v3 API — paginated, returns both CPMM and CLMM pools
  const allPools: RawPool[] = [];
  let page = 1;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${pageSize}&page=${page}`;
    try {
      const res = await fetchWithRetry(url);
      const data = (await res.json()) as {
        success: boolean;
        data?: {
          count?: number;
          data?: Array<{
            id: string;
            type: string;     // "Standard" | "Concentrated" | "Cpmm"
            mintA: { address: string; symbol: string; decimals: number };
            mintB: { address: string; symbol: string; decimals: number };
            tvl?: number;
            day?: { volume?: number; volumeQuote?: number };
            feeRate?: number; // stored as decimal or bps depending on pool type
            config?: { tradeFeeRate?: number };
          }>;
        };
      };

      const items = data.data?.data ?? [];
      if (items.length === 0) {
        hasMore = false;
        break;
      }

      for (const pool of items) {
        let baseMint: string;
        let baseSymbol: string;
        let baseDecimals: number;

        if (pool.mintB.address === USDC_MINT) {
          baseMint = pool.mintA.address;
          baseSymbol = pool.mintA.symbol;
          baseDecimals = pool.mintA.decimals;
        } else if (pool.mintA.address === USDC_MINT) {
          baseMint = pool.mintB.address;
          baseSymbol = pool.mintB.symbol;
          baseDecimals = pool.mintB.decimals;
        } else {
          continue; // not USDC pair
        }

        // Determine pool type
        const typeStr = (pool.type ?? "").toLowerCase();
        let poolType: RawPool["poolType"];
        if (typeStr.includes("concentrated") || typeStr.includes("clmm")) {
          poolType = "clmm";
        } else {
          poolType = "cpmm";
        }

        // Fee: Raydium returns feeRate as a fraction e.g. 0.0025 = 25 bps
        const feeRaw = pool.feeRate ?? pool.config?.tradeFeeRate ?? 0;
        // If feeRaw > 1, it's already in bps; otherwise convert
        const feeBps = feeRaw > 1 ? Math.round(feeRaw) : Math.round(feeRaw * 10_000);

        allPools.push({
          baseMint,
          quoteMint: USDC_MINT,
          poolId: pool.id,
          poolType,
          sourceDex: "raydium",
          liquidityUsd: pool.tvl ?? 0,
          volume24hUsd: pool.day?.volume ?? pool.day?.volumeQuote ?? null,
          feeBps,
          tickSpacing: null,
          baseSymbol,
          baseDecimals,
        });
      }

      console.log(`  [Raydium] Page ${page}: ${items.length} pools (${allPools.length} USDC pools so far)`);

      // Stop if we've exhausted pages or got fewer than pageSize
      if (items.length < pageSize) {
        hasMore = false;
      } else {
        page++;
        // Don't fetch beyond 5 pages to stay deterministic
        if (page > 5) hasMore = false;
      }

      await sleep(1_000); // rate limit
    } catch (err) {
      console.warn(`  [Raydium] Page ${page} error: ${err instanceof Error ? err.message : String(err)}`);
      hasMore = false;
    }
  }

  console.log(`  [Raydium] ${allPools.length} USDC pools extracted`);
  return allPools;
}

// ─── Meteora DLMM ───

async function listMeteoraPools(): Promise<RawPool[]> {
  console.log("  [Meteora] Fetching DLMM pair list…");

  const res = await fetchWithRetry("https://dlmm-api.meteora.ag/pair/all");
  const data = (await res.json()) as Array<{
    address: string;
    name: string;        // e.g. "TOKEN-USDC"
    mint_x: string;
    mint_y: string;
    bin_step: number;    // tick spacing equivalent
    base_fee_percentage: string;  // e.g. "0.25" for 25 bps
    liquidity: number;   // USD
    trade_volume_24h: number;
    fees_24h?: number;
    cumulative_trade_volume?: number;
    current_price?: number;
    apr?: number;
    is_blacklisted?: boolean;
  }>;

  const pools: RawPool[] = [];
  const items = Array.isArray(data) ? data : [];
  console.log(`  [Meteora] ${items.length} DLMM pairs fetched`);

  for (const pair of items) {
    if (pair.is_blacklisted) continue;

    let baseMint: string;

    if (pair.mint_y === USDC_MINT) {
      baseMint = pair.mint_x;
    } else if (pair.mint_x === USDC_MINT) {
      baseMint = pair.mint_y;
    } else {
      continue; // not USDC pair
    }

    // Fee: base_fee_percentage is a string like "0.25" meaning 0.25% = 25 bps
    const feePct = parseFloat(pair.base_fee_percentage || "0");
    const feeBps = Math.round(feePct * 100);

    // Extract symbol from name if possible
    const nameParts = (pair.name ?? "").split("-");
    const baseSymbol = nameParts.length > 0 ? nameParts[0].trim() : undefined;

    pools.push({
      baseMint,
      quoteMint: USDC_MINT,
      poolId: pair.address,
      poolType: "dlmm",
      sourceDex: "meteora",
      liquidityUsd: pair.liquidity ?? 0,
      volume24hUsd: pair.trade_volume_24h ?? null,
      feeBps,
      tickSpacing: pair.bin_step ?? null,
      baseSymbol,
    });
  }

  console.log(`  [Meteora] ${pools.length} USDC pools extracted`);
  return pools;
}

// ══════════════════════════════════════════════════════════════
//  Filter Engine
// ══════════════════════════════════════════════════════════════

type RejectReason =
  | "NOT_USDC_QUOTE"
  | "EXCLUDED_BASE_MINT"
  | "TOO_LOW_LIQ"
  | "TOO_HIGH_LIQ"
  | "TOO_LOW_VOL"
  | "LOW_VOL_LIQ_RATIO"
  | "BAD_FEE"
  | "MISSING_VOLUME"
  | "POOL_BLACKLISTED"
  | "DENIED_POOL_TYPE";

interface CandidateEntry {
  baseMint: string;
  sourceDex: DexSource;
  poolId: string;
  poolType: RawPool["poolType"];
  poolLiquidityUsd: number;
  poolVolume24hUsd: number;
  feeBps: number;
  tickSpacing: number | null;
  notes: string[];
  baseSymbol?: string;
  baseDecimals?: number;
  score: number;
  /** true when pool is a direct baseMint↔USDC pool (C1 candidate) */
  isDirectUsdcPool: boolean;
}

function filterAndRank(
  pools: RawPool[],
  excludeMints: Set<string>,
  allowPoolTypes: ReadonlySet<string>,
  minLiqUsd: number = MIN_LIQ_USD,
): {
  candidates: CandidateEntry[];
  rejectReasons: Record<RejectReason, number>;
  scannedPools: number;
} {
  const rejectReasons: Record<RejectReason, number> = {
    NOT_USDC_QUOTE: 0,
    EXCLUDED_BASE_MINT: 0,
    TOO_LOW_LIQ: 0,
    TOO_HIGH_LIQ: 0,
    TOO_LOW_VOL: 0,
    LOW_VOL_LIQ_RATIO: 0,
    BAD_FEE: 0,
    MISSING_VOLUME: 0,
    POOL_BLACKLISTED: 0,
    DENIED_POOL_TYPE: 0,
  };

  const passed: CandidateEntry[] = [];

  for (const pool of pools) {
    // 1. Must be USDC quote
    if (pool.quoteMint !== USDC_MINT) {
      rejectReasons.NOT_USDC_QUOTE++;
      continue;
    }

    // 2. Exclude blacklisted base mints
    if (EXCLUDE_BASE_MINTS.has(pool.baseMint) || excludeMints.has(pool.baseMint)) {
      rejectReasons.EXCLUDED_BASE_MINT++;
      continue;
    }

    // 2b. Pool type gate (v2.1: cpmm+whirlpool only by default)
    if (!allowPoolTypes.has(pool.poolType)) {
      rejectReasons.DENIED_POOL_TYPE++;
      continue;
    }

    // 3. Require volume data for determinism
    if (pool.volume24hUsd === null || pool.volume24hUsd === undefined) {
      rejectReasons.MISSING_VOLUME++;
      continue;
    }

    // 4. Liquidity band (uses parameterized floor for C1 rescue pass)
    if (pool.liquidityUsd < minLiqUsd) {
      rejectReasons.TOO_LOW_LIQ++;
      continue;
    }
    if (pool.liquidityUsd > MAX_LIQ_USD) {
      rejectReasons.TOO_HIGH_LIQ++;
      continue;
    }

    // 5. Volume floor
    if (pool.volume24hUsd < MIN_VOL_24H_USD) {
      rejectReasons.TOO_LOW_VOL++;
      continue;
    }

    // 6. Vol/Liq ratio
    const ratio = pool.liquidityUsd > 0 ? pool.volume24hUsd / pool.liquidityUsd : 0;
    if (ratio < MIN_VOL_LIQ_RATIO) {
      rejectReasons.LOW_VOL_LIQ_RATIO++;
      continue;
    }

    // 7. Fee cap
    if (pool.feeBps > MAX_FEE_BPS) {
      rejectReasons.BAD_FEE++;
      continue;
    }

    // ── Compute deterministic score ──
    const volScore = Math.log10(Math.max(pool.volume24hUsd, 1));
    const liqScore = Math.log10(Math.max(pool.liquidityUsd, 1));

    let bonus = 0;
    if (pool.poolType === "cpmm") bonus = 0.2;
    else if (pool.poolType === "clmm" || pool.poolType === "whirlpool") bonus = 0.1;
    // dlmm gets 0

    const score = 0.6 * volScore + 0.4 * liqScore + bonus;

    const notes: string[] = ["DIRECT_USDC_POOL"];
    if (pool.poolType === "cpmm") notes.push("SIMPLE_AMM");
    if (ratio >= 0.5) notes.push("HIGH_ACTIVITY");

    // All pools here are direct baseMint↔USDC pools (quoteMint == USDC already checked)
    passed.push({
      baseMint: pool.baseMint,
      sourceDex: pool.sourceDex,
      poolId: pool.poolId,
      poolType: pool.poolType,
      poolLiquidityUsd: Math.round(pool.liquidityUsd),
      poolVolume24hUsd: Math.round(pool.volume24hUsd),
      feeBps: pool.feeBps,
      tickSpacing: pool.tickSpacing,
      notes,
      baseSymbol: pool.baseSymbol,
      baseDecimals: pool.baseDecimals,
      score,
      isDirectUsdcPool: true,
    });
  }

  // Sort descending by score
  passed.sort((a, b) => b.score - a.score);

  return {
    candidates: passed,
    rejectReasons,
    scannedPools: pools.length,
  };
}

/**
 * Deduplicate by baseMint: keep the pool with the highest score.
 * Then take top TARGET_N with C1 quota enforcement.
 *
 * C1 quota: at least C1_QUOTA of the final set must be isDirectUsdcPool=true
 * with cpmm/whirlpool pool type (shallow-route friendly).
 */
function dedupeByBaseMint(
  candidates: CandidateEntry[],
  targetN: number,
): CandidateEntry[] {
  const seen = new Map<string, CandidateEntry>();

  for (const c of candidates) {
    const existing = seen.get(c.baseMint);
    if (!existing || c.score > existing.score) {
      seen.set(c.baseMint, c);
    }
  }

  // Re-sort by score after deduplication
  const unique = Array.from(seen.values());
  unique.sort((a, b) => b.score - a.score);

  // ── C1 quota enforcement ──
  // Separate C1 (direct USDC + shallow-route pool types) from rest
  const c1Candidates = unique.filter(
    (c) => c.isDirectUsdcPool && (c.poolType === "cpmm" || c.poolType === "whirlpool"),
  );
  const nonC1Candidates = unique.filter(
    (c) => !(c.isDirectUsdcPool && (c.poolType === "cpmm" || c.poolType === "whirlpool")),
  );

  const c1Take = Math.min(c1Candidates.length, Math.max(C1_QUOTA, 0));
  const remainingSlots = targetN - c1Take;

  // Take guaranteed C1 slots first, fill remainder from best-score overall
  const c1Set = new Set(c1Candidates.slice(0, c1Take).map((c) => c.baseMint));
  const rest = unique.filter((c) => !c1Set.has(c.baseMint)).slice(0, Math.max(remainingSlots, 0));

  const final = [
    ...c1Candidates.slice(0, c1Take),
    ...rest,
  ];
  // Re-sort combined set by score
  final.sort((a, b) => b.score - a.score);

  console.log(`  C1 quota: ${c1Take}/${C1_QUOTA} direct-USDC shallow-route candidates reserved`);
  console.log(`  Non-C1 fill: ${rest.length} (total: ${final.length})`);

  return final.slice(0, targetN);
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
function getArgStr(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1] ?? defaultVal;
  return defaultVal;
}

const dryRun = args.includes("--dry");
const TARGET_N = getArgVal("--target", 150);
const dexFilter = getArgStr("--dex", "all").toLowerCase();

// v2.1: Pool type gate — default cpmm+whirlpool only
const poolTypesArg = getArgStr("--pool-types", "");
const includeClmm = args.includes("--include-clmm");
const includeDlmm = args.includes("--include-dlmm");

function resolveAllowPoolTypes(): Set<string> {
  // Explicit --pool-types=cpmm,whirlpool,clmm overrides everything
  if (poolTypesArg) {
    return new Set(poolTypesArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  // Start from defaults, optionally add clmm/dlmm
  const allowed = new Set(DEFAULT_ALLOW_POOL_TYPES);
  if (includeClmm) allowed.add("clmm");
  if (includeDlmm) allowed.add("dlmm");
  return allowed;
}

const allowPoolTypes = resolveAllowPoolTypes();

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Discovery Script v2 — Pool/DEX-based Shallow Route Finder  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Quote mint: USDC (${USDC_MINT.slice(0, 8)}…)`);
  console.log(`  Liq band:   $${MIN_LIQ_USD.toLocaleString()} – $${MAX_LIQ_USD.toLocaleString()}`);
  console.log(`  Min vol:    $${MIN_VOL_24H_USD.toLocaleString()}`);
  console.log(`  Vol/Liq:    ≥ ${MIN_VOL_LIQ_RATIO}`);
  console.log(`  Max fee:    ${MAX_FEE_BPS} bps`);
  console.log(`  Target N:   ${TARGET_N}`);
  console.log(`  Pool types: ${[...allowPoolTypes].join(", ")}`);
  console.log(`  C1 quota:   ${C1_QUOTA} (min direct-USDC cpmm/whirlpool)`);
  console.log(`  C1 liq min: $${MIN_LIQ_USD_C1.toLocaleString()} (relaxed for C1 quota fill)`);
  console.log(`  DEX filter: ${dexFilter}`);
  console.log(`  Dry run:    ${dryRun}\n`);

  // Load additional blacklist
  const extraBlacklist = await loadBlacklistMints();
  if (extraBlacklist.size > 0) {
    console.log(`  Loaded ${extraBlacklist.size} extra blacklisted mints\n`);
  }

  // ── Fetch pools from all DEXes ──
  const allPools: RawPool[] = [];
  const dexCoverage: Record<string, number> = {};

  const activeDexes = dexFilter === "all"
    ? DEX_SOURCES
    : DEX_SOURCES.filter((d) => d === dexFilter);

  for (const dex of activeDexes) {
    try {
      let pools: RawPool[] = [];
      switch (dex) {
        case "orca":
          pools = await listOrcaPools();
          break;
        case "raydium":
          pools = await listRaydiumPools();
          break;
        case "meteora":
          pools = await listMeteoraPools();
          break;
      }
      dexCoverage[dex] = pools.length;
      allPools.push(...pools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${dex}] FAILED: ${msg}`);
      dexCoverage[dex] = -1; // signal failure
    }

    // Pause between DEX calls
    await sleep(500);
  }

  console.log(`\n  Total raw USDC pools: ${allPools.length}`);
  console.log(`  DEX coverage:`, dexCoverage);

  // ── Filter & Rank (standard thresholds) ──
  const { candidates: filtered, rejectReasons, scannedPools } = filterAndRank(
    allPools,
    extraBlacklist,
    allowPoolTypes,
    MIN_LIQ_USD,
  );

  // ── C1 rescue pass: relax liq floor to MIN_LIQ_USD_C1 for cpmm/whirlpool only ──
  // This ensures we can fill the C1 quota even if standard thresholds are too strict
  let c1RescueCount = 0;
  if (MIN_LIQ_USD_C1 < MIN_LIQ_USD) {
    const c1AllowTypes = new Set(["cpmm", "whirlpool"]);
    const { candidates: c1Extra } = filterAndRank(
      allPools,
      extraBlacklist,
      c1AllowTypes,
      MIN_LIQ_USD_C1,
    );
    // Add only those not already in filtered (by poolId)
    const existingPoolIds = new Set(filtered.map((c) => c.poolId));
    for (const c of c1Extra) {
      if (!existingPoolIds.has(c.poolId) && c.poolLiquidityUsd < MIN_LIQ_USD) {
        c.notes.push("C1_RESCUE");
        filtered.push(c);
        existingPoolIds.add(c.poolId);
        c1RescueCount++;
      }
    }
    if (c1RescueCount > 0) {
      console.log(`\n  C1 rescue: ${c1RescueCount} extra candidates from liq $${MIN_LIQ_USD_C1.toLocaleString()}-$${MIN_LIQ_USD.toLocaleString()} band (cpmm/whirlpool only)`);
    }
  }

  console.log(`\n  Pools after filters: ${filtered.length}`);

  // ── Deduplicate by baseMint ──
  const final = dedupeByBaseMint(filtered, TARGET_N);
  console.log(`  Unique baseMints (top ${TARGET_N}): ${final.length}`);

  // ── Acceptance check ──
  const inBandCount = final.filter(
    (c) =>
      c.poolLiquidityUsd >= MIN_LIQ_USD &&
      c.poolLiquidityUsd <= MAX_LIQ_USD &&
      c.poolVolume24hUsd / c.poolLiquidityUsd >= MIN_VOL_LIQ_RATIO,
  ).length;
  const inBandPct = final.length > 0 ? (inBandCount / final.length) * 100 : 0;
  const c1Count = final.filter((c) => c.isDirectUsdcPool && (c.poolType === "cpmm" || c.poolType === "whirlpool")).length;

  console.log(`\n  In-band candidates: ${inBandCount}/${final.length} (${inBandPct.toFixed(1)}%)`);
  console.log(`  C1 direct-USDC (cpmm/whirlpool): ${c1Count}/${final.length}`);
  if (inBandPct < 70) {
    console.warn(`  ⚠ Below 70% in-band threshold (${inBandPct.toFixed(1)}%). Check filters.`);
  }

  // ── Summary table ──
  console.log(`\n─── Reject Histogram ────────────────────────────────────────\n`);
  for (const [reason, count] of Object.entries(rejectReasons)) {
    if (count > 0) console.log(`  ${reason.padEnd(24)} ${count}`);
  }

  console.log(`\n─── Top ${Math.min(final.length, 30)} Candidates ───────────────────────────────\n`);
  console.log(
    `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"DEX".padEnd(10)} ${"Type".padEnd(12)} ${"Liq ($)".padStart(12)} ${"Vol ($)".padStart(12)} ${"Fee".padStart(6)} ${"Score".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(10)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(8)}`,
  );

  for (let i = 0; i < Math.min(final.length, 30); i++) {
    const c = final[i];
    console.log(
      `  ${String(i + 1).padStart(3)}  ${(c.baseSymbol ?? c.baseMint.slice(0, 10)).padEnd(14)} ${c.sourceDex.padEnd(10)} ${c.poolType.padEnd(12)} ${("$" + c.poolLiquidityUsd.toLocaleString()).padStart(12)} ${("$" + c.poolVolume24hUsd.toLocaleString()).padStart(12)} ${(c.feeBps + "bp").padStart(6)} ${c.score.toFixed(3).padStart(8)}`,
    );
  }

  if (final.length === 0) {
    console.log(`\n  ⚠ No candidates found. Try relaxing filters.\n`);
    return;
  }

  // ── Write outputs ──
  if (dryRun) {
    console.log(`\n  [DRY RUN] Skipping file writes.\n`);
    return;
  }

  // 1. candidatePairs.json (v2 format)
  const candidatePairsOutput = {
    generatedAtMs: Date.now(),
    version: "discovery_v2",
    quoteMint: USDC_MINT,
    quoteSymbol: "USDC",
    quoteDecimals: USDC_DECIMALS,
    candidates: final.map((c) => ({
      baseMint: c.baseMint,
      sourceDex: c.sourceDex,
      poolId: c.poolId,
      poolType: c.poolType,
      poolLiquidityUsd: c.poolLiquidityUsd,
      poolVolume24hUsd: c.poolVolume24hUsd,
      feeBps: c.feeBps,
      tickSpacing: c.tickSpacing,
      notes: c.notes,
      isDirectUsdcPool: c.isDirectUsdcPool,
      // Backward-compat fields for candidatePairProvider
      mint: c.baseMint,
      symbol: c.baseSymbol,
      decimals: c.baseDecimals ?? 6,
    })),
  };

  const dataDir = path.resolve(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  const candidatePath = path.join(dataDir, "candidatePairs.json");
  await fs.writeFile(candidatePath, JSON.stringify(candidatePairsOutput, null, 2) + "\n", "utf-8");
  console.log(`\n  ✓ Written ${final.length} candidates to ${candidatePath}`);

  // 2. discovery_report.json (detailed report)
  const top20 = final.slice(0, 20).map((c) => ({
    baseMint: c.baseMint,
    symbol: c.baseSymbol,
    sourceDex: c.sourceDex,
    poolType: c.poolType,
    liquidityUsd: c.poolLiquidityUsd,
    volume24hUsd: c.poolVolume24hUsd,
    feeBps: c.feeBps,
    score: Number(c.score.toFixed(4)),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    version: "discovery_v2",
    parameters: {
      MIN_LIQ_USD,
      MIN_LIQ_USD_C1,
      MAX_LIQ_USD,
      MIN_VOL_24H_USD,
      MIN_VOL_LIQ_RATIO,
      MAX_FEE_BPS,
      TARGET_N,
      C1_QUOTA,
      dexFilter,
      allowPoolTypes: [...allowPoolTypes],
    },
    c1DirectUsdcCount: c1Count,
    c1RescueCount,
    scannedPools,
    acceptedCandidates: final.length,
    inBandPercentage: Number(inBandPct.toFixed(1)),
    finalUniqueBaseMints: final.length,
    rejectReasonsHistogram: rejectReasons,
    dexCoverage,
    top20ByScore: top20,
    // Failure mode reporting
    warnings: [] as string[],
  };

  if (final.length < TARGET_N) {
    report.warnings.push(
      `Only ${final.length}/${TARGET_N} candidates found. ` +
        `Pool coverage may be insufficient or filters too strict.`,
    );
  }
  if (inBandPct < 70) {
    report.warnings.push(
      `In-band acceptance rate ${inBandPct.toFixed(1)}% < 70% threshold.`,
    );
  }
  for (const [dex, count] of Object.entries(dexCoverage)) {
    if (count === -1) {
      report.warnings.push(`DEX adapter "${dex}" failed to fetch pools.`);
    }
  }

  const reportDir = path.resolve(dataDir, "telemetry");
  await fs.mkdir(reportDir, { recursive: true });
  // Also write to data/ root per spec
  const reportPathRoot = path.join(dataDir, "discovery_report.json");
  const reportPathTelemetry = path.join(reportDir, "discovery_report.json");

  const reportJson = JSON.stringify(report, null, 2) + "\n";
  await fs.writeFile(reportPathRoot, reportJson, "utf-8");
  await fs.writeFile(reportPathTelemetry, reportJson, "utf-8");
  console.log(`  ✓ Discovery report saved to ${reportPathRoot}`);
  console.log(`  ✓ Discovery report saved to ${reportPathTelemetry}`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
