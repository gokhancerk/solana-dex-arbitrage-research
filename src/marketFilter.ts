/**
 * Market Type Classification & Filter (Type C Detector)
 *
 * Classifies token pairs into three market types:
 *   Type A — Deep & Hyper Competitive (impact_3k < 0.2%)
 *   Type B — Shallow Liquidity (impact_3k > 1.2%)
 *   Type C — Mid Liquidity Sweet Spot (0.2% ≤ impact_3k ≤ 1.0%) ← TARGET
 *
 * Only Type C markets are eligible for live execution.
 *
 * Data sources:
 *   - Jupiter Quote API (price impact + routePlan)
 *   - Birdeye API (volume, liquidity) — optional, falls back to Jupiter data
 *
 * This module is NON-invasive: it does not modify existing execution logic.
 * It provides a pre-trade gate that can be called before committing to a trade.
 */

import { loadConfig, type TokenSymbol } from "./config.js";
import { fetchJupiterQuote, type JupiterRouteInfo } from "./jupiter.js";
import type { MarketClassification, MarketType } from "./types.js";

// ── Configuration ──────────────────────────────────────────────────

/** Impact sampling amounts in USD */
const IMPACT_SAMPLE_1K = 1_000;
const IMPACT_SAMPLE_3K = 3_000;
const IMPACT_SAMPLE_5K = 5_000;

/** Type C thresholds (strict) */
const TYPE_C_IMPACT_3K_MIN = 0.2;   // % — below this = Type A
const TYPE_C_IMPACT_3K_MAX = 1.0;   // % — above this = risky
const TYPE_B_IMPACT_3K_THRESHOLD = 1.2; // % — above this = Type B (shallow)

const MIN_VOLUME_24H = 50_000;       // USD
const MIN_VOL_LIQ_RATIO = 0.05;
const MAX_VOL_LIQ_RATIO = 1.0;
const MAX_ROUTE_MARKETS = 3;
const MAX_SLIPPAGE_CURVE_RATIO = 4;  // impact_5k / impact_1k — reject if > 4 (liquidity cliff)
const TYPE_C_SLIPPAGE_CURVE_MAX = 3; // impact_5k / impact_1k for ideal Type C

/** Type-based cache TTLs (ms) — volatile tokens refresh faster */
const CACHE_TTL_BY_TYPE: Record<string, number> = {
  A: 60_000,     // Deep & stable — 60 s
  B: 15_000,     // Shallow / volatile — 15 s
  C: 30_000,     // Mid-liquidity sweet spot — 30 s
  UNKNOWN: 10_000, // Unknown — 10 s (re-probe quickly)
};

/** Minimum absolute liquidity to be eligible ($) */
const MIN_LIQUIDITY = 100_000;

/** Birdeye API base URL */
const BIRDEYE_BASE_URL = "https://public-api.birdeye.so";

// ── Cache ──────────────────────────────────────────────────────────

interface CachedClassification {
  classification: MarketClassification;
  fetchedAt: number;
}

const _classificationCache = new Map<string, CachedClassification>();

// ── Birdeye Data Fetcher ───────────────────────────────────────────

interface BirdeyeTokenData {
  volume24h: number;
  liquidity: number;
}

/**
 * Fetch 24h volume and liquidity from Birdeye API (optional).
 * Returns null if API is unavailable or key is missing.
 */
async function fetchBirdeyeData(mint: string): Promise<BirdeyeTokenData | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `${BIRDEYE_BASE_URL}/defi/token_overview?address=${mint}`;
    const res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      success: boolean;
      data?: {
        v24hUSD?: number;
        liquidity?: number;
      };
    };

    if (!json.success || !json.data) return null;

    return {
      volume24h: json.data.v24hUSD ?? 0,
      liquidity: json.data.liquidity ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Impact Sampling ────────────────────────────────────────────────

interface ImpactSample {
  amountUsd: number;
  impactPct: number;
  routeMarkets: number;
}

/**
 * Fetch a Jupiter quote for the given amount and extract price impact + route count.
 */
async function sampleImpact(
  inputMint: string,
  outputMint: string,
  amountUsd: number,
  inputDecimals: number,
): Promise<ImpactSample> {
  const amountRaw = BigInt(Math.round(amountUsd * 10 ** inputDecimals));
  const cfg = loadConfig();

  const { route } = await fetchJupiterQuote({
    inputMint,
    outputMint,
    amount: amountRaw,
    slippageBps: cfg.slippageBps,
  });

  const impactPct = Math.abs(parseFloat(route.priceImpactPct ?? "0"));
  const routeMarkets = countRouteMarkets(route);

  return { amountUsd, impactPct, routeMarkets };
}

/**
 * Count distinct market hops in a Jupiter route.
 */
function countRouteMarkets(route: JupiterRouteInfo): number {
  if (!route.routePlan || !Array.isArray(route.routePlan)) return 1;
  return route.routePlan.length;
}

// ── Classification Logic ───────────────────────────────────────────

/**
 * Classify a token pair based on impact sampling and market data.
 * Returns a MarketClassification with type, metrics, and eligibility.
 *
 * @param targetToken  The token to classify (e.g., "SOL", "WIF", "JUP")
 * @param forceRefresh If true, bypass cache and re-fetch
 */
export async function classifyMarket(
  targetToken: TokenSymbol,
  forceRefresh = false,
): Promise<MarketClassification> {
  const cfg = loadConfig();
  const usdcMint = cfg.tokens.USDC.mint;
  const targetMint = cfg.tokens[targetToken].mint;
  const usdcDecimals = cfg.tokens.USDC.decimals;
  const cacheKey = `${targetToken}/USDC`;

  // ── Cache check (type-based TTL) ──
  if (!forceRefresh) {
    const cached = _classificationCache.get(cacheKey);
    if (cached) {
      const ttl = CACHE_TTL_BY_TYPE[cached.classification.type] ?? CACHE_TTL_BY_TYPE.UNKNOWN;
      if (Date.now() - cached.fetchedAt < ttl) {
        return cached.classification;
      }
    }
  }

  const rejectReasons: string[] = [];

  // ── Step 1: Impact sampling (USDC → targetToken at 3 notional levels) ──
  let impact1k = 0;
  let impact3k = 0;
  let impact5k = 0;
  let routeMarkets = 1;

  try {
    const [sample1k, sample3k, sample5k] = await Promise.all([
      sampleImpact(usdcMint, targetMint, IMPACT_SAMPLE_1K, usdcDecimals),
      sampleImpact(usdcMint, targetMint, IMPACT_SAMPLE_3K, usdcDecimals),
      sampleImpact(usdcMint, targetMint, IMPACT_SAMPLE_5K, usdcDecimals),
    ]);

    impact1k = sample1k.impactPct;
    impact3k = sample3k.impactPct;
    impact5k = sample5k.impactPct;
    routeMarkets = Math.max(sample1k.routeMarkets, sample3k.routeMarkets, sample5k.routeMarkets);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    rejectReasons.push(`impact_sampling_failed: ${reason}`);
    return buildResult("UNKNOWN", { impact1k, impact3k, impact5k, routeMarkets, volume24h: 0, liquidity: 0, volumeLiquidityRatio: 0, slippageCurveRatio: 0, rejectReasons, eligible: false });
  }

  // ── Step 2: Fetch market data (Birdeye or fallback) ──
  let volume24h = 0;
  let liquidity = 0;

  const birdeyeData = await fetchBirdeyeData(targetMint);
  if (birdeyeData) {
    volume24h = birdeyeData.volume24h;
    liquidity = birdeyeData.liquidity;
  } else {
    // Birdeye unavailable — use impact-based heuristic
    // If impact_3k is very low, assume high liquidity (conservative estimate)
    // This is a fallback; real Birdeye data is preferred
    if (impact3k < 0.1) {
      volume24h = 1_000_000; // assume >50k for very liquid tokens
      liquidity = 10_000_000;
    } else if (impact3k < 0.5) {
      volume24h = 100_000;
      liquidity = 500_000;
    } else {
      volume24h = 20_000;
      liquidity = 50_000;
    }
    console.log(
      `[MARKET-FILTER] Birdeye unavailable for ${targetToken} — using impact-based heuristic ` +
        `(vol=$${volume24h.toLocaleString()}, liq=$${liquidity.toLocaleString()})`
    );
  }

  const volumeLiquidityRatio = liquidity > 0 ? volume24h / liquidity : 0;
  const slippageCurveRatio = impact1k > 0 ? impact5k / impact1k : 0;

  // ── Step 3: Hard reject rules ──

  // Rule 1: impact_3k > 1.2% → reject (Type B shallow)
  if (impact3k > TYPE_B_IMPACT_3K_THRESHOLD) {
    rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% > ${TYPE_B_IMPACT_3K_THRESHOLD}% (shallow liquidity)`);
  }

  // Rule 2: volume/liquidity < 0.05
  if (volumeLiquidityRatio < MIN_VOL_LIQ_RATIO) {
    rejectReasons.push(`vol/liq=${volumeLiquidityRatio.toFixed(4)} < ${MIN_VOL_LIQ_RATIO}`);
  }

  // Rule 3: routeMarkets > 3
  if (routeMarkets > MAX_ROUTE_MARKETS) {
    rejectReasons.push(`routeMarkets=${routeMarkets} > ${MAX_ROUTE_MARKETS}`);
  }

  // Rule 4: 24h volume < 50k
  if (volume24h < MIN_VOLUME_24H) {
    rejectReasons.push(`volume24h=$${volume24h.toFixed(0)} < $${MIN_VOLUME_24H}`);
  }

  // Rule 5: liquidity cliff (impact_5k / impact_1k > 4)
  if (impact1k > 0 && slippageCurveRatio > MAX_SLIPPAGE_CURVE_RATIO) {
    rejectReasons.push(`slippage_curve=${slippageCurveRatio.toFixed(2)} > ${MAX_SLIPPAGE_CURVE_RATIO} (liquidity cliff)`);
  }

  // Rule 6: absolute liquidity < $100k
  if (liquidity < MIN_LIQUIDITY) {
    rejectReasons.push(`liquidity=$${liquidity.toFixed(0)} < $${MIN_LIQUIDITY} (insufficient depth)`);
  }

  // ── Step 4: Classify ──
  let type: MarketType;
  let eligible = false;

  if (rejectReasons.length > 0) {
    // Has hard reject — determine if A or B for diagnostics
    if (impact3k < TYPE_C_IMPACT_3K_MIN) {
      type = "A";
    } else if (impact3k > TYPE_B_IMPACT_3K_THRESHOLD) {
      type = "B";
    } else {
      type = "B"; // rejected but in mid-range → classify as B (failed other criteria)
    }
  } else if (impact3k < TYPE_C_IMPACT_3K_MIN) {
    // impact_3k < 0.2% → Type A (too competitive)
    type = "A";
    rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% < ${TYPE_C_IMPACT_3K_MIN}% (Type A — hyper competitive)`);
  } else if (impact3k >= TYPE_C_IMPACT_3K_MIN && impact3k <= TYPE_C_IMPACT_3K_MAX) {
    // 0.2% ≤ impact_3k ≤ 1.0% — Type C sweet spot
    // Additional check: slippage curve should be stable
    if (slippageCurveRatio <= TYPE_C_SLIPPAGE_CURVE_MAX) {
      type = "C";
      eligible = true;
    } else {
      type = "B";
      rejectReasons.push(`slippage_curve=${slippageCurveRatio.toFixed(2)} > ${TYPE_C_SLIPPAGE_CURVE_MAX} (unstable curve for Type C)`);
    }
  } else {
    // impact_3k > 1.0% but ≤ 1.2% — borderline, still rejected
    type = "B";
    rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% > ${TYPE_C_IMPACT_3K_MAX}% (above Type C sweet spot)`);
  }

  const classification = buildResult(type, {
    impact1k,
    impact3k,
    impact5k,
    routeMarkets,
    volume24h,
    liquidity,
    volumeLiquidityRatio,
    slippageCurveRatio,
    rejectReasons,
    eligible,
  });

  // ── Cache result ──
  _classificationCache.set(cacheKey, {
    classification,
    fetchedAt: Date.now(),
  });

  // ── Log ──
  const emoji = eligible ? "✓" : "✗";
  console.log(
    `[MARKET-FILTER] ${targetToken}/USDC → Type ${type} ${emoji} | ` +
      `impact: 1k=${impact1k.toFixed(4)}% 3k=${impact3k.toFixed(4)}% 5k=${impact5k.toFixed(4)}% | ` +
      `routes=${routeMarkets} | vol=$${volume24h.toLocaleString()} | liq=$${liquidity.toLocaleString()} | ` +
      `v/l=${volumeLiquidityRatio.toFixed(4)} | curve=${slippageCurveRatio.toFixed(2)}` +
      (rejectReasons.length > 0 ? ` | reject: [${rejectReasons.join("; ")}]` : "")
  );

  return classification;
}

function buildResult(
  type: MarketType,
  data: Omit<MarketClassification, "type">,
): MarketClassification {
  return { type, ...data };
}

// ── Convenience: Pre-trade gate ───────────────────────────────────

/**
 * Check if a token pair is eligible for live execution (Type C only).
 * Returns the classification for telemetry attachment.
 *
 * Usage in PriceTicker:
 *   const mc = await isMarketEligible("SOL");
 *   if (!mc.eligible) { skip this token; }
 */
export async function isMarketEligible(
  targetToken: TokenSymbol,
): Promise<MarketClassification> {
  return classifyMarket(targetToken);
}

// ── Batch classification ─────────────────────────────────────────

/**
 * Classify all scan tokens and return results.
 * Useful for periodic batch filtering.
 */
export async function classifyAllScanTokens(): Promise<Map<TokenSymbol, MarketClassification>> {
  const cfg = loadConfig();
  const results = new Map<TokenSymbol, MarketClassification>();

  // Run sequentially to avoid Jupiter rate-limit issues
  for (const token of cfg.scanTokens) {
    try {
      const classification = await classifyMarket(token);
      results.set(token, classification);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[MARKET-FILTER] ${token} classification failed: ${reason}`);
      results.set(token, {
        type: "UNKNOWN",
        impact1k: 0,
        impact3k: 0,
        impact5k: 0,
        routeMarkets: 0,
        volume24h: 0,
        liquidity: 0,
        volumeLiquidityRatio: 0,
        slippageCurveRatio: 0,
        rejectReasons: [`classification_failed: ${reason}`],
        eligible: false,
      });
    }
  }

  return results;
}

/**
 * Clear the classification cache (e.g., on config change or manual reset).
 */
export function clearMarketFilterCache(): void {
  _classificationCache.clear();
  console.log("[MARKET-FILTER] Cache temizlendi");
}

/**
 * Get the cached classification for a token, if available.
 * Returns undefined if not cached or expired.
 */
export function getCachedClassification(
  targetToken: TokenSymbol,
): MarketClassification | undefined {
  const cached = _classificationCache.get(`${targetToken}/USDC`);
  if (cached) {
    const ttl = CACHE_TTL_BY_TYPE[cached.classification.type] ?? CACHE_TTL_BY_TYPE.UNKNOWN;
    if (Date.now() - cached.fetchedAt < ttl) {
      return cached.classification;
    }
  }
  return undefined;
}

// ── Mint-based Classification (EXPERIMENT_D_READY) ─────────────────

/**
 * Classify a token pair by raw mint addresses (no TokenSymbol dependency).
 * Used by EXPERIMENT_D_READY for candidate pair discovery.
 *
 * @param baseMint   Base token mint address
 * @param quoteMint  Quote token mint address (typically USDC)
 * @param quoteDecimals  Quote token decimals (typically 6)
 * @param label  Optional label for logging (e.g. "SOL/USDC")
 * @param forceRefresh  Bypass cache
 */
export async function classifyMarketByMint(
  baseMint: string,
  quoteMint: string,
  quoteDecimals: number,
  label?: string,
  forceRefresh = false,
): Promise<MarketClassification> {
  const cacheKey = `${baseMint}/${quoteMint}`;
  const tag = label ?? `${baseMint.slice(0, 8)}…/${quoteMint.slice(0, 8)}…`;

  // ── Cache check ──
  if (!forceRefresh) {
    const cached = _classificationCache.get(cacheKey);
    if (cached) {
      const ttl = CACHE_TTL_BY_TYPE[cached.classification.type] ?? CACHE_TTL_BY_TYPE.UNKNOWN;
      if (Date.now() - cached.fetchedAt < ttl) {
        return cached.classification;
      }
    }
  }

  const rejectReasons: string[] = [];
  const cfg = loadConfig();

  // ── Step 1: Impact sampling ──
  let impact1k = 0;
  let impact3k = 0;
  let impact5k = 0;
  let routeMarkets = 1;

  try {
    const [sample1k, sample3k, sample5k] = await Promise.all([
      sampleImpact(quoteMint, baseMint, IMPACT_SAMPLE_1K, quoteDecimals),
      sampleImpact(quoteMint, baseMint, IMPACT_SAMPLE_3K, quoteDecimals),
      sampleImpact(quoteMint, baseMint, IMPACT_SAMPLE_5K, quoteDecimals),
    ]);

    impact1k = sample1k.impactPct;
    impact3k = sample3k.impactPct;
    impact5k = sample5k.impactPct;
    routeMarkets = Math.max(sample1k.routeMarkets, sample3k.routeMarkets, sample5k.routeMarkets);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    rejectReasons.push(`impact_sampling_failed: ${reason}`);
    return buildResult("UNKNOWN", { impact1k, impact3k, impact5k, routeMarkets, volume24h: 0, liquidity: 0, volumeLiquidityRatio: 0, slippageCurveRatio: 0, rejectReasons, eligible: false });
  }

  // ── Step 2: Market data ──
  let volume24h = 0;
  let liquidity = 0;

  const birdeyeData = await fetchBirdeyeData(baseMint);
  if (birdeyeData) {
    volume24h = birdeyeData.volume24h;
    liquidity = birdeyeData.liquidity;
  } else {
    if (impact3k < 0.1) { volume24h = 1_000_000; liquidity = 10_000_000; }
    else if (impact3k < 0.5) { volume24h = 100_000; liquidity = 500_000; }
    else { volume24h = 20_000; liquidity = 50_000; }
    console.log(`[MARKET-FILTER] Birdeye unavailable for ${tag} — using heuristic (vol=$${volume24h.toLocaleString()}, liq=$${liquidity.toLocaleString()})`);
  }

  const volumeLiquidityRatio = liquidity > 0 ? volume24h / liquidity : 0;
  const slippageCurveRatio = impact1k > 0 ? impact5k / impact1k : 0;

  // ── Step 3: Hard reject rules ──
  if (impact3k > TYPE_B_IMPACT_3K_THRESHOLD) rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% > ${TYPE_B_IMPACT_3K_THRESHOLD}% (shallow liquidity)`);
  if (volumeLiquidityRatio < MIN_VOL_LIQ_RATIO) rejectReasons.push(`vol/liq=${volumeLiquidityRatio.toFixed(4)} < ${MIN_VOL_LIQ_RATIO}`);
  if (routeMarkets > MAX_ROUTE_MARKETS) rejectReasons.push(`routeMarkets=${routeMarkets} > ${MAX_ROUTE_MARKETS}`);
  if (volume24h < MIN_VOLUME_24H) rejectReasons.push(`volume24h=$${volume24h.toFixed(0)} < $${MIN_VOLUME_24H}`);
  if (impact1k > 0 && slippageCurveRatio > MAX_SLIPPAGE_CURVE_RATIO) rejectReasons.push(`slippage_curve=${slippageCurveRatio.toFixed(2)} > ${MAX_SLIPPAGE_CURVE_RATIO} (liquidity cliff)`);
  if (liquidity < MIN_LIQUIDITY) rejectReasons.push(`liquidity=$${liquidity.toFixed(0)} < $${MIN_LIQUIDITY} (insufficient depth)`);

  // ── Step 4: Classify ──
  let type: MarketType;
  let eligible = false;

  if (rejectReasons.length > 0) {
    type = impact3k < TYPE_C_IMPACT_3K_MIN ? "A" : "B";
  } else if (impact3k < TYPE_C_IMPACT_3K_MIN) {
    type = "A";
    rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% < ${TYPE_C_IMPACT_3K_MIN}% (Type A — hyper competitive)`);
  } else if (impact3k >= TYPE_C_IMPACT_3K_MIN && impact3k <= TYPE_C_IMPACT_3K_MAX) {
    if (slippageCurveRatio <= TYPE_C_SLIPPAGE_CURVE_MAX) {
      type = "C";
      eligible = true;
    } else {
      type = "B";
      rejectReasons.push(`slippage_curve=${slippageCurveRatio.toFixed(2)} > ${TYPE_C_SLIPPAGE_CURVE_MAX} (unstable curve for Type C)`);
    }
  } else {
    type = "B";
    rejectReasons.push(`impact_3k=${impact3k.toFixed(4)}% > ${TYPE_C_IMPACT_3K_MAX}% (above Type C sweet spot)`);
  }

  const classification = buildResult(type, { impact1k, impact3k, impact5k, routeMarkets, volume24h, liquidity, volumeLiquidityRatio, slippageCurveRatio, rejectReasons, eligible });

  // ── Cache ──
  _classificationCache.set(cacheKey, { classification, fetchedAt: Date.now() });

  const emoji = eligible ? "✓" : "✗";
  console.log(
    `[MARKET-FILTER] ${tag} → Type ${type} ${emoji} | ` +
      `impact: 1k=${impact1k.toFixed(4)}% 3k=${impact3k.toFixed(4)}% 5k=${impact5k.toFixed(4)}% | ` +
      `routes=${routeMarkets} | vol=$${volume24h.toLocaleString()} | liq=$${liquidity.toLocaleString()} | ` +
      `v/l=${volumeLiquidityRatio.toFixed(4)} | curve=${slippageCurveRatio.toFixed(2)}` +
      (rejectReasons.length > 0 ? ` | reject: [${rejectReasons.join("; ")}]` : "")
  );

  return classification;
}
