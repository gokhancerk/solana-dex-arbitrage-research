/**
 * Shared Quote Utilities — extracted from arbWatch.ts
 *
 * Common types, constants, and quote functions used by both
 * arbWatch (M3 measurement) and stage3Watch (re-quote pipeline).
 */

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** Safety buffer in USDC base units: 0.05 USDC = 50,000 units */
export const BUFFER_USDC_UNITS = 50_000n;

/** Jupiter API for Orca CLMM quotes */
export const JUP_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

// ══════════════════════════════════════════════════════════════
//  InvalidRule enum (per spec — deterministic classification)
// ══════════════════════════════════════════════════════════════

export type InvalidRule =
  | "QUOTE_FAIL"
  | "MINT_OR_DECIMALS_MISMATCH"
  | "SELL_INPUT_MISMATCH"
  | "ABS_BPS_INSANE";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

/** Raydium pool reserves — actual on-chain data, stored in base units */
export interface RaydiumPoolReserves {
  reserveBaseUnits: bigint;
  reserveQuoteUnits: bigint;  // USDC base units
  feeBps: number;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
}

/** DEX quote result (all amounts in base units) */
export interface DexQuoteResult {
  outAmountUnits: bigint;
  ok: boolean;
  error?: string;
}

/** Orca pool metadata (for mint/decimal cross-check) */
export interface OrcaPoolMeta {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
}

/** Pool pair input structure used across arbWatch / stage3 */
export interface PoolPairInput {
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

export interface PairsFile {
  generatedAtMs: number;
  version: string;
  pairs: PoolPairInput[];
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  maxRetries = 2,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const bustUrl = `${url}${sep}_t=${Date.now()}`;
      const res = await fetch(bustUrl, {
        ...opts,
        headers: {
          ...(opts.headers as Record<string, string> ?? {}),
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        await sleep((attempt + 1) * 2_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await sleep((attempt + 1) * 1_500);
    }
  }
  throw new Error(`fetchWithRetry exhausted: ${url}`);
}

/** Run async tasks with a concurrency limit */
export async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ══════════════════════════════════════════════════════════════
//  Raydium: Fetch actual reserves (batched, one HTTP call)
// ══════════════════════════════════════════════════════════════

/**
 * Fetch actual on-chain reserves from the Raydium pools/info/ids endpoint.
 * Returns Map<poolId, RaydiumPoolReserves> with reserves in base units (bigint).
 */
export async function fetchRaydiumReserves(
  pairs: PoolPairInput[],
): Promise<Map<string, RaydiumPoolReserves>> {
  const map = new Map<string, RaydiumPoolReserves>();
  try {
    const baseMintByPool = new Map<string, string>();
    const poolIds: string[] = [];
    for (const pair of pairs) {
      baseMintByPool.set(pair.raydiumPoolId, pair.baseMint);
      poolIds.push(pair.raydiumPoolId);
    }

    const url = `https://api-v3.raydium.io/pools/info/ids?ids=${poolIds.join(",")}`;
    const res = await fetchWithRetry(url);
    const data = (await res.json()) as {
      success: boolean;
      data?: Array<{
        id: string;
        feeRate?: number;
        config?: { tradeFeeRate?: number };
        mintA?: { address: string; decimals: number };
        mintB?: { address: string; decimals: number };
        mintAmountA?: number;
        mintAmountB?: number;
      }>;
    };

    for (const pool of data.data ?? []) {
      const baseMint = baseMintByPool.get(pool.id);
      if (!baseMint) continue;
      if (pool.mintAmountA == null || pool.mintAmountB == null) continue;
      if (!pool.mintA?.address || !pool.mintB?.address) continue;

      const feeRaw = pool.feeRate ?? pool.config?.tradeFeeRate ?? 0;
      // Raydium API may return fee as decimal (0.0025) or bps integer (25)
      const feeBps = feeRaw > 1 ? Math.round(feeRaw) : Math.round(feeRaw * 10_000);

      // Identify base and quote tokens
      const isABase = pool.mintA.address === baseMint;
      const baseToken = isABase ? pool.mintA : pool.mintB;
      const quoteToken = isABase ? pool.mintB : pool.mintA;
      const baseAmountHuman = isABase ? pool.mintAmountA : pool.mintAmountB;
      const quoteAmountHuman = isABase ? pool.mintAmountB : pool.mintAmountA;

      // Convert human amounts to base units (bigint)
      const reserveBaseUnits = BigInt(
        Math.round(baseAmountHuman * 10 ** baseToken.decimals),
      );
      const reserveQuoteUnits = BigInt(
        Math.round(quoteAmountHuman * 10 ** quoteToken.decimals),
      );

      map.set(pool.id, {
        reserveBaseUnits,
        reserveQuoteUnits,
        feeBps,
        baseMint: baseToken.address,
        quoteMint: quoteToken.address,
        baseDecimals: baseToken.decimals,
        quoteDecimals: quoteToken.decimals,
      });
    }
  } catch (err) {
    console.warn(
      `  [Raydium] Reserve fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return map;
}

// ══════════════════════════════════════════════════════════════
//  Orca: Fetch pool metadata (batched, for mint/decimals check)
// ══════════════════════════════════════════════════════════════

/**
 * Fetch Orca Whirlpool list and extract mint/decimals metadata
 * for our target pools. One HTTP call per tick.
 */
export async function fetchOrcaPoolMeta(
  pairs: PoolPairInput[],
): Promise<Map<string, OrcaPoolMeta>> {
  const map = new Map<string, OrcaPoolMeta>();
  try {
    const poolSet = new Set(pairs.map((p) => p.orcaPoolId));
    const res = await fetchWithRetry(
      "https://api.mainnet.orca.so/v1/whirlpool/list",
    );
    const data = (await res.json()) as {
      whirlpools?: Array<{
        address: string;
        tokenA?: { mint: string; decimals: number };
        tokenB?: { mint: string; decimals: number };
      }>;
    };
    for (const wp of data.whirlpools ?? []) {
      if (poolSet.has(wp.address) && wp.tokenA && wp.tokenB) {
        // Determine which token is base (non-USDC) and which is quote (USDC)
        const isAQuote = wp.tokenA.mint === USDC_MINT;
        map.set(wp.address, {
          baseMint: isAQuote ? wp.tokenB.mint : wp.tokenA.mint,
          quoteMint: isAQuote ? wp.tokenA.mint : wp.tokenB.mint,
          baseDecimals: isAQuote ? wp.tokenB.decimals : wp.tokenA.decimals,
          quoteDecimals: isAQuote ? wp.tokenA.decimals : wp.tokenB.decimals,
        });
      }
    }
  } catch (err) {
    console.warn(
      `  [Orca] Pool meta fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return map;
}

// ══════════════════════════════════════════════════════════════
//  Direct Quote Functions
// ══════════════════════════════════════════════════════════════

/**
 * Raydium CPMM exact-in quote using actual on-chain reserves.
 *
 * Formula (identical to the Raydium on-chain program):
 *   inputAfterFee = inAmount * (10000 - feeBps) / 10000
 *   outAmount = reserveOut * inputAfterFee / (reserveIn + inputAfterFee)
 *
 * All arithmetic in bigint for exact precision — no floating point.
 */
export function quoteRaydiumCpmmExactIn(
  reserves: RaydiumPoolReserves,
  inputMint: string,
  inAmountUnits: bigint,
): DexQuoteResult {
  if (reserves.reserveBaseUnits <= 0n || reserves.reserveQuoteUnits <= 0n) {
    return { outAmountUnits: 0n, ok: false, error: "Zero reserves" };
  }

  // Identify input/output reserves by mint
  const isQuoteIn =
    inputMint === reserves.quoteMint || inputMint === USDC_MINT;
  const reserveIn = isQuoteIn
    ? reserves.reserveQuoteUnits
    : reserves.reserveBaseUnits;
  const reserveOut = isQuoteIn
    ? reserves.reserveBaseUnits
    : reserves.reserveQuoteUnits;

  // CPMM formula in bigint (exact integer arithmetic)
  const feeBps = BigInt(reserves.feeBps);
  const inputAfterFee = (inAmountUnits * (10000n - feeBps)) / 10000n;
  const outAmountUnits =
    (reserveOut * inputAfterFee) / (reserveIn + inputAfterFee);

  if (outAmountUnits <= 0n) {
    return { outAmountUnits: 0n, ok: false, error: "Output is zero" };
  }

  return { outAmountUnits, ok: true };
}

/**
 * Orca Whirlpool (CLMM) exact-in quote via Jupiter API.
 *
 * Uses `dexes=Whirlpool` filter to ensure routing through only Orca
 * Whirlpool pools. `onlyDirectRoutes=true` ensures single-hop (no
 * intermediate tokens). The output is the real CLMM swap result as
 * computed by Jupiter's router against on-chain Orca pool state.
 */
export async function quoteOrcaExactIn(
  inputMint: string,
  outputMint: string,
  inAmountUnits: bigint,
  jupiterApiKey: string,
): Promise<DexQuoteResult> {
  try {
    const url = new URL(JUP_QUOTE_URL);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", inAmountUnits.toString());
    url.searchParams.set("slippageBps", "20");
    url.searchParams.set("dexes", "Whirlpool");
    url.searchParams.set("onlyDirectRoutes", "true");
    url.searchParams.set("maxAccounts", "20");

    const res = await fetchWithRetry(url.toString(), {
      headers: { "x-api-key": jupiterApiKey },
    });
    const data = (await res.json()) as {
      outAmount?: string;
      error?: string;
      routePlan?: unknown[];
    };

    if (!data.outAmount) {
      return {
        outAmountUnits: 0n,
        ok: false,
        error: data.error ?? "No outAmount in Orca/Jupiter response",
      };
    }

    return { outAmountUnits: BigInt(data.outAmount), ok: true };
  } catch (err) {
    return {
      outAmountUnits: 0n,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ══════════════════════════════════════════════════════════════
//  Pre-check: mint / decimals ONLY (no price divergence)
// ══════════════════════════════════════════════════════════════

/**
 * Validate that mints and decimals match between paired Orca/Raydium pools.
 * Returns { ok: true } if valid, { ok: false, reason } if mismatch.
 *
 * This is the ONLY structural check. NO price divergence invalidation.
 */
export function checkMintDecimals(
  pair: PoolPairInput,
  orcaMeta: OrcaPoolMeta | undefined,
  raydiumReserves: RaydiumPoolReserves | undefined,
): { ok: boolean; reason?: string } {
  if (!raydiumReserves) {
    return { ok: false, reason: "Raydium reserves not available for pool" };
  }

  // Check Raydium base mint matches pair
  if (raydiumReserves.baseMint !== pair.baseMint) {
    return {
      ok: false,
      reason: `baseMint mismatch: pair=${pair.baseMint.slice(0, 8)}… raydium=${raydiumReserves.baseMint.slice(0, 8)}…`,
    };
  }

  // Check Raydium quote mint matches pair
  if (raydiumReserves.quoteMint !== pair.quoteMint) {
    return {
      ok: false,
      reason: `quoteMint mismatch: pair=${pair.quoteMint.slice(0, 8)}… raydium=${raydiumReserves.quoteMint.slice(0, 8)}…`,
    };
  }

  // If Orca pool meta is available, cross-check mints and decimals
  if (orcaMeta) {
    if (orcaMeta.baseMint !== pair.baseMint) {
      return {
        ok: false,
        reason: `Orca baseMint mismatch: pair=${pair.baseMint.slice(0, 8)}… orca=${orcaMeta.baseMint.slice(0, 8)}…`,
      };
    }
    if (orcaMeta.quoteMint !== pair.quoteMint) {
      return {
        ok: false,
        reason: `Orca quoteMint mismatch: pair=${pair.quoteMint.slice(0, 8)}… orca=${orcaMeta.quoteMint.slice(0, 8)}…`,
      };
    }
    // Decimals cross-check between Orca and Raydium
    if (orcaMeta.baseDecimals !== raydiumReserves.baseDecimals) {
      return {
        ok: false,
        reason: `baseDecimals mismatch: orca=${orcaMeta.baseDecimals} raydium=${raydiumReserves.baseDecimals}`,
      };
    }
    if (orcaMeta.quoteDecimals !== raydiumReserves.quoteDecimals) {
      return {
        ok: false,
        reason: `quoteDecimals mismatch: orca=${orcaMeta.quoteDecimals} raydium=${raydiumReserves.quoteDecimals}`,
      };
    }
  }

  return { ok: true };
}

/** Hourly file tag: YYYY-MM-DDTHH */
export function fileTag(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
