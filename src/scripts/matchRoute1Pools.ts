/**
 * Route=1 Pool Matching — M2 Step 2
 *
 * Joins Orca Whirlpool candidates with Raydium CPMM candidates
 * by baseMint (both must have a USDC pool). Produces the cross-DEX
 * pair universe for route=1 arbitrage scoring.
 *
 * Strategy:
 *   1. Load filtered candidates from file outputs (orca_pool_scores.json,
 *      raydium_candidatePools.json)
 *   2. Also fetch live pool data from both DEX APIs to find ALL USDC pools
 *      (broader matching universe — filtering happens in scoring step)
 *   3. Join on baseMint where both DEXes have a USDC pool
 *   4. Keep best pool per DEX per baseMint (by TVL/score)
 *
 * Output:
 *   - data/route1_pool_pairs.json
 *
 * Usage:
 *   npm run match:route1
 *   npx tsx src/scripts/matchRoute1Pools.ts
 *   npx tsx src/scripts/matchRoute1Pools.ts --dry
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Minimum TVL for a pool to be matched (very relaxed — scoring does the real filtering) */
const MATCH_MIN_TVL = 5_000;

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface PoolRecord {
  poolId: string;
  baseMint: string;
  baseSymbol: string;
  baseDecimals: number;
  liquidityUsd: number;
  volume24hUsd: number;
  feeBps: number;
  poolType: string;
  tickSpacing?: number;
  lpFeeRate?: number;
  price?: number | null;
  score: number;
}

interface PoolPairOutput {
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  orcaPoolId: string;
  raydiumPoolId: string;
  orcaMeta: {
    poolId: string;
    feeBps: number;
    tickSpacing: number;
    liqUsd: number;
    vol24hUsd: number;
    poolType: string;
    lpFeeRate: number;
    price: number | null;
  };
  raydiumMeta: {
    poolId: string;
    feeBps: number;
    liqUsd: number;
    vol24hUsd: number;
    poolType: string;
  };
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
//  Orca Pool Loading — file + API enrichment
// ══════════════════════════════════════════════════════════════

async function loadOrcaPools(dataDir: string): Promise<Map<string, PoolRecord>> {
  const map = new Map<string, PoolRecord>();

  // 1. Load from scored file
  const scoresPath = path.join(dataDir, "orca_pool_scores.json");
  try {
    const raw = await fs.readFile(scoresPath, "utf-8");
    const data = JSON.parse(raw) as {
      pools?: Array<{
        poolId: string;
        baseMint: string;
        baseSymbol: string;
        baseDecimals: number;
        liquidityUsd: number;
        volume24hUsd: number;
        feeBps: number;
        tickSpacing: number;
        score: number;
        poolMeta?: { lpFeeRate: number; price: number | null };
      }>;
    };
    for (const p of data.pools ?? []) {
      if (!map.has(p.baseMint) || p.score > (map.get(p.baseMint)?.score ?? 0)) {
        map.set(p.baseMint, {
          poolId: p.poolId,
          baseMint: p.baseMint,
          baseSymbol: p.baseSymbol,
          baseDecimals: p.baseDecimals,
          liquidityUsd: p.liquidityUsd,
          volume24hUsd: p.volume24hUsd,
          feeBps: p.feeBps,
          poolType: "whirlpool",
          tickSpacing: p.tickSpacing,
          lpFeeRate: p.poolMeta?.lpFeeRate ?? p.feeBps / 10_000,
          price: p.poolMeta?.price ?? null,
          score: p.score,
        });
      }
    }
    console.log(`  [Orca] Loaded ${map.size} scored pools from file`);
  } catch {
    console.log(`  [Orca] No scored file found, will use API only`);
  }

  // 2. Enrich with full Orca whirlpool API for broader matching
  console.log(`  [Orca] Fetching full whirlpool list for broad matching…`);
  try {
    const res = await fetchWithRetry("https://api.mainnet.orca.so/v1/whirlpool/list");
    const data = (await res.json()) as {
      whirlpools?: Array<{
        address: string;
        tokenA: { mint: string; symbol: string; decimals: number };
        tokenB: { mint: string; symbol: string; decimals: number };
        tvl?: number;
        volume?: { day?: number };
        lpFeeRate?: number;
        feeRate?: number;
        tickSpacing?: number;
        price?: number;
      }>;
    };

    let apiAdded = 0;
    for (const wp of data.whirlpools ?? []) {
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
        continue;
      }

      const tvl = wp.tvl ?? 0;
      if (tvl < MATCH_MIN_TVL) continue;

      const vol24h = wp.volume?.day ?? 0;
      const lpFeeRate = wp.lpFeeRate ?? wp.feeRate ?? 0;
      const feeBps = Math.round(lpFeeRate * 10_000);
      const score =
        0.6 * Math.log10(Math.max(vol24h, 1)) +
        0.4 * Math.log10(Math.max(tvl, 1));

      // Only add if not already present or better
      const existing = map.get(baseMint);
      if (!existing || score > existing.score) {
        if (!existing) apiAdded++;
        map.set(baseMint, {
          poolId: wp.address,
          baseMint,
          baseSymbol,
          baseDecimals,
          liquidityUsd: Math.round(tvl),
          volume24hUsd: Math.round(vol24h),
          feeBps,
          poolType: "whirlpool",
          tickSpacing: wp.tickSpacing ?? 0,
          lpFeeRate,
          price: wp.price ?? null,
          score: Number(score.toFixed(6)),
        });
      }
    }
    console.log(`  [Orca] API enriched: ${apiAdded} new baseMints added (total: ${map.size})`);
  } catch (err) {
    console.warn(`  [Orca] API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

// ══════════════════════════════════════════════════════════════
//  Raydium Pool Loading — file + API enrichment
// ══════════════════════════════════════════════════════════════

function isRaydiumCpmm(typeStr: string): boolean {
  const t = (typeStr ?? "").toLowerCase();
  return !t.includes("concentrated") && !t.includes("clmm");
}

async function loadRaydiumPools(dataDir: string): Promise<Map<string, PoolRecord>> {
  const map = new Map<string, PoolRecord>();

  // 1. Load from file
  const filePath = path.join(dataDir, "raydium_candidatePools.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as {
      candidates?: Array<{
        poolId: string;
        baseMint: string;
        baseSymbol: string;
        baseDecimals: number;
        liquidityUsd: number;
        volume24hUsd: number;
        feeBps: number;
        poolType: string;
        score: number;
      }>;
    };
    for (const p of data.candidates ?? []) {
      if (!map.has(p.baseMint) || p.score > (map.get(p.baseMint)?.score ?? 0)) {
        map.set(p.baseMint, {
          poolId: p.poolId,
          baseMint: p.baseMint,
          baseSymbol: p.baseSymbol,
          baseDecimals: p.baseDecimals ?? 9,
          liquidityUsd: p.liquidityUsd,
          volume24hUsd: p.volume24hUsd,
          feeBps: p.feeBps,
          poolType: p.poolType ?? "cpmm",
          score: p.score,
        });
      }
    }
    console.log(`  [Raydium] Loaded ${map.size} candidate pools from file`);
  } catch {
    console.log(`  [Raydium] No candidate file found, will use API only`);
  }

  // 2. Enrich with Raydium API for broader matching
  console.log(`  [Raydium] Fetching pool list for broad matching…`);
  const PAGE_SIZE = 1_000;
  const MAX_PAGES = 10;
  let apiAdded = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const url = `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${PAGE_SIZE}&page=${page}`;
      const res = await fetchWithRetry(url);
      const data = (await res.json()) as {
        success: boolean;
        data?: {
          data?: Array<{
            id: string;
            type: string;
            mintA: { address: string; symbol: string; decimals: number };
            mintB: { address: string; symbol: string; decimals: number };
            tvl?: number;
            day?: { volume?: number; volumeQuote?: number };
            feeRate?: number;
            config?: { tradeFeeRate?: number };
          }>;
        };
      };

      const items = data.data?.data ?? [];
      if (items.length === 0) break;

      for (const pool of items) {
        if (!isRaydiumCpmm(pool.type)) continue;

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
          continue;
        }

        const tvl = pool.tvl ?? 0;
        if (tvl < MATCH_MIN_TVL) continue;

        const vol24h = pool.day?.volume ?? pool.day?.volumeQuote ?? 0;
        const feeRaw = pool.feeRate ?? pool.config?.tradeFeeRate ?? 0;
        const feeBps = feeRaw > 1 ? Math.round(feeRaw) : Math.round(feeRaw * 10_000);
        const pType = (pool.type ?? "").toLowerCase().includes("cpmm") ? "cpmm" : "standard";
        const score =
          0.6 * Math.log10(Math.max(vol24h, 1)) +
          0.4 * Math.log10(Math.max(tvl, 1));

        const existing = map.get(baseMint);
        if (!existing || score > existing.score) {
          if (!existing) apiAdded++;
          map.set(baseMint, {
            poolId: pool.id,
            baseMint,
            baseSymbol,
            baseDecimals,
            liquidityUsd: Math.round(tvl),
            volume24hUsd: Math.round(vol24h),
            feeBps,
            poolType: pType,
            score: Number(score.toFixed(6)),
          });
        }
      }

      if (items.length < PAGE_SIZE) break;
      await sleep(1_000);
    } catch (err) {
      console.warn(`  [Raydium] API page ${page} error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  console.log(`  [Raydium] API enriched: ${apiAdded} new baseMints added (total: ${map.size})`);

  return map;
}

// ══════════════════════════════════════════════════════════════
//  Matching Logic
// ══════════════════════════════════════════════════════════════

function matchPools(
  orcaPools: Map<string, PoolRecord>,
  raydiumPools: Map<string, PoolRecord>,
): PoolPairOutput[] {
  const pairs: PoolPairOutput[] = [];

  for (const [baseMint, orca] of orcaPools) {
    const raydium = raydiumPools.get(baseMint);
    if (!raydium) continue;

    pairs.push({
      baseMint,
      baseSymbol: orca.baseSymbol || raydium.baseSymbol || baseMint.slice(0, 8),
      quoteMint: USDC_MINT,
      orcaPoolId: orca.poolId,
      raydiumPoolId: raydium.poolId,
      orcaMeta: {
        poolId: orca.poolId,
        feeBps: orca.feeBps,
        tickSpacing: orca.tickSpacing ?? 0,
        liqUsd: orca.liquidityUsd,
        vol24hUsd: orca.volume24hUsd,
        poolType: "whirlpool",
        lpFeeRate: orca.lpFeeRate ?? (orca.feeBps / 10_000),
        price: (orca.price as number | null) ?? null,
      },
      raydiumMeta: {
        poolId: raydium.poolId,
        feeBps: raydium.feeBps,
        liqUsd: raydium.liquidityUsd,
        vol24hUsd: raydium.volume24hUsd,
        poolType: raydium.poolType ?? "cpmm",
      },
    });
  }

  // Sort by combined liquidity desc for deterministic ordering
  pairs.sort((a, b) => {
    const liqA = a.orcaMeta.liqUsd + a.raydiumMeta.liqUsd;
    const liqB = b.orcaMeta.liqUsd + b.raydiumMeta.liqUsd;
    if (liqB !== liqA) return liqB - liqA;
    return a.baseMint.localeCompare(b.baseMint);
  });

  return pairs;
}

// ══════════════════════════════════════════════════════════════
//  CLI & Main
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Route=1 Pool Matching — M2 Step 2                          ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const dataDir = path.resolve(process.cwd(), "data");

  // Load pools from both DEXes (file + API enrichment)
  const orcaPools = await loadOrcaPools(dataDir);
  const raydiumPools = await loadRaydiumPools(dataDir);

  console.log(`\n  Orca unique baseMints:    ${orcaPools.size}`);
  console.log(`  Raydium unique baseMints: ${raydiumPools.size}`);

  // Match
  const pairs = matchPools(orcaPools, raydiumPools);

  console.log(`  Matched pairs (both DEXes): ${pairs.length}\n`);

  if (pairs.length === 0) {
    console.log(`  ⚠ No matching pairs found.\n`);
    if (!dryRun) {
      const outPath = path.join(dataDir, "route1_pool_pairs.json");
      await fs.writeFile(
        outPath,
        JSON.stringify({ generatedAtMs: Date.now(), version: "route1_v1", matchedCount: 0, pairs: [] }, null, 2) + "\n",
        "utf-8",
      );
      console.log(`  ✓ Empty pairs file written to ${outPath}\n`);
    }
    return;
  }

  // ── Summary table ──
  console.log(`─── Matched Pairs ──────────────────────────────────────────\n`);
  console.log(
    `  ${"#".padStart(3)}  ${"Symbol".padEnd(14)} ${"Orca Liq".padStart(12)} ${"Ray Liq".padStart(12)} ${"Orca Fee".padStart(9)} ${"Ray Fee".padStart(9)} ${"Orca Vol".padStart(12)} ${"Ray Vol".padStart(12)}`,
  );
  console.log(
    `  ${"─".repeat(3)}  ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(12)} ${"─".repeat(12)}`,
  );

  for (let i = 0; i < Math.min(pairs.length, 40); i++) {
    const p = pairs[i];
    console.log(
      `  ${String(i + 1).padStart(3)}  ${p.baseSymbol.padEnd(14)} ${("$" + p.orcaMeta.liqUsd.toLocaleString()).padStart(12)} ${("$" + p.raydiumMeta.liqUsd.toLocaleString()).padStart(12)} ${(p.orcaMeta.feeBps + "bp").padStart(9)} ${(p.raydiumMeta.feeBps + "bp").padStart(9)} ${("$" + p.orcaMeta.vol24hUsd.toLocaleString()).padStart(12)} ${("$" + p.raydiumMeta.vol24hUsd.toLocaleString()).padStart(12)}`,
    );
  }
  if (pairs.length > 40) {
    console.log(`  … and ${pairs.length - 40} more pairs`);
  }

  console.log();

  if (dryRun) {
    console.log(`  [DRY RUN] Skipping file writes.\n`);
    return;
  }

  // ── Write output ──
  const outPath = path.join(dataDir, "route1_pool_pairs.json");
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "route1_v1",
        quoteMint: USDC_MINT,
        matchedCount: pairs.length,
        orcaInputCount: orcaPools.size,
        raydiumInputCount: raydiumPools.size,
        pairs,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ ${pairs.length} matched pairs written to ${outPath}\n`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
