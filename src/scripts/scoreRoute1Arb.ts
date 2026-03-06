/**
 * Route=1 Cross-DEX Arbitrage Scoring — M2 Step 3
 *
 * Reads matched Orca+Raydium pool pairs (route1_pool_pairs.json),
 * computes deterministic arbitrage edge for each pair × notional × direction
 * using TVL-based constant-product quote math, and outputs:
 *
 *   - data/arb_route1_scores.json    (full scored records)
 *   - data/arbSoftlist_micro.json    (near-miss research candidates)
 *   - data/arbWhitelist_micro.json   ($30–$100 micro arb candidates)
 *   - data/arbWhitelist_scale.json   ($1k–$3k scale arb candidates)
 *   - data/arb_summary.json          (histograms + dominant reject reasons)
 *
 * Usage:
 *   npm run score:arb
 *   npx tsx src/scripts/scoreRoute1Arb.ts
 *   npx tsx src/scripts/scoreRoute1Arb.ts --dry
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Constants (M2 spec — deterministic)
// ══════════════════════════════════════════════════════════════

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Trade notionals (USDC) */
const N_MICRO = [30, 100] as const;
const N_SCALE = [1_000, 3_000] as const;
const ALL_NOTIONALS = [...N_MICRO, ...N_SCALE] as const;

/** Safety buffers */
const BUFFER_MICRO_USDC = 0.05;   // absolute USDC
const BUFFER_SCALE_BPS = 5;       // bps

/** Eligibility filters */
const MIN_LIQ_USD_MICRO = 40_000;
const MIN_VOL_24H_USD_MICRO = 20_000;
const MIN_LIQ_USD_SCALE = 100_000;
const MIN_VOL_24H_USD_SCALE = 50_000;

/** Micro whitelist thresholds */
const MICRO_MIN_NET_PROFIT_USDC = 0.05;
const MICRO_MIN_NET_PROFIT_BPS = 5;

/** Scale whitelist thresholds */
const SCALE_MIN_NET_PROFIT_USDC = 0.20;
const SCALE_MIN_NET_PROFIT_BPS = 3;

/** Softlist near-miss thresholds */
const SOFTLIST_MIN_NET_PROFIT_USDC = -0.05;

/** Small epsilon for division safety */
const EPS = 1e-12;

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface PoolPairInput {
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

interface PairsFile {
  generatedAtMs: number;
  version: string;
  pairs: PoolPairInput[];
}

type Direction = "D1_BuyOrca_SellRaydium" | "D2_BuyRaydium_SellOrca";

type ArbRejectReason =
  | "NO_MATCHED_POOL"
  | "QUOTE_FAIL_ORCA_BUY"
  | "QUOTE_FAIL_RAYDIUM_BUY"
  | "QUOTE_FAIL_ORCA_SELL"
  | "QUOTE_FAIL_RAYDIUM_SELL"
  | "NET_PROFIT_NEGATIVE"
  | "IMPACT_TOO_HIGH"
  | "LOW_LIQUIDITY_MICRO"
  | "LOW_VOLUME_MICRO"
  | "LOW_LIQUIDITY_SCALE"
  | "LOW_VOLUME_SCALE";

interface LegQuote {
  dex: "orca" | "raydium";
  poolId: string;
  side: "buy" | "sell";
  inputAmount: number;
  outputAmount: number;
  effectivePrice: number;
  priceImpactPct: number;
  feeCostUsdc: number;
  tvlUsd: number;
}

interface ArbScoreRecord {
  baseMint: string;
  baseSymbol: string;
  notionalUsdc: number;
  direction: Direction;
  buyLeg: LegQuote;
  sellLeg: LegQuote;
  grossProfitUsdc: number;
  safetyBufferUsdc: number;
  netProfitUsdc: number;
  netProfitBps: number;
  rejectReasons: ArbRejectReason[];
  tier: "micro" | "scale";
  eligible: boolean;
}

interface WhitelistEntry {
  baseMint: string;
  baseSymbol: string;
  notionalUsdc: number;
  direction: Direction;
  netProfitUsdc: number;
  netProfitBps: number;
  buyDex: string;
  sellDex: string;
  buyImpactPct: number;
  sellImpactPct: number;
  buyFeeCostUsdc: number;
  sellFeeCostUsdc: number;
  orcaPoolId: string;
  raydiumPoolId: string;
}

interface SoftlistEntry extends WhitelistEntry {
  rejectReasons: ArbRejectReason[];
}

// ══════════════════════════════════════════════════════════════
//  Deterministic Quote Engine (TVL-based constant-product)
// ══════════════════════════════════════════════════════════════

/**
 * Constant-product AMM swap simulation.
 *
 * For a pool with TVL split ~50/50 between base and quote:
 *   reserveQuote ≈ TVL / 2  (USDC side)
 *   reserveBase  ≈ TVL / 2 / price  (base side, in token units)
 *
 * For BUY (USDC → BASE):
 *   amountInAfterFee = amountIn * (1 - feeRate)
 *   baseOut = reserveBase * amountInAfterFee / (reserveQuote + amountInAfterFee)
 *
 * For SELL (BASE → USDC):
 *   amountInAfterFee = baseIn * (1 - feeRate)
 *   usdcOut = reserveQuote * amountInAfterFee / (reserveBase + amountInAfterFee)
 *
 * Returns { outputAmount, effectivePrice, priceImpactPct, feeCostUsdc }
 */
function cpmmQuote(
  side: "buy" | "sell",
  inputAmount: number,
  tvlUsd: number,
  feeBps: number,
  pricePerBase: number | null,
): {
  outputAmount: number;
  effectivePrice: number;
  priceImpactPct: number;
  feeCostUsdc: number;
} | null {
  if (tvlUsd <= 0) return null;

  const feeRate = feeBps / 10_000;
  const reserveQuote = tvlUsd / 2;
  // Estimate base reserve using price; if no price, assume $1 (rough)
  const basePrice = pricePerBase && pricePerBase > 0 ? pricePerBase : 1;
  const reserveBase = reserveQuote / basePrice;

  if (reserveQuote <= 0 || reserveBase <= 0) return null;

  if (side === "buy") {
    // USDC → BASE
    const inputUsdc = inputAmount;
    const feeCostUsdc = inputUsdc * feeRate;
    const amountInAfterFee = inputUsdc * (1 - feeRate);
    const baseOut = (reserveBase * amountInAfterFee) / (reserveQuote + amountInAfterFee);

    if (baseOut <= 0) return null;

    const effectivePrice = inputUsdc / baseOut; // USDC per base
    const spotPrice = basePrice;
    const priceImpactPct = spotPrice > 0
      ? ((effectivePrice - spotPrice) / spotPrice) * 100
      : 0;

    return {
      outputAmount: baseOut,
      effectivePrice,
      priceImpactPct: Math.abs(priceImpactPct),
      feeCostUsdc,
    };
  } else {
    // BASE → USDC
    const baseIn = inputAmount;
    const feeCostBase = baseIn * feeRate;
    const amountInAfterFee = baseIn * (1 - feeRate);
    const usdcOut = (reserveQuote * amountInAfterFee) / (reserveBase + amountInAfterFee);

    if (usdcOut <= 0) return null;

    const effectivePrice = usdcOut / baseIn; // USDC per base
    const spotPrice = basePrice;
    const priceImpactPct = spotPrice > 0
      ? ((spotPrice - effectivePrice) / spotPrice) * 100
      : 0;

    const feeCostUsdc = feeCostBase * basePrice;

    return {
      outputAmount: usdcOut,
      effectivePrice,
      priceImpactPct: Math.abs(priceImpactPct),
      feeCostUsdc,
    };
  }
}

// ══════════════════════════════════════════════════════════════
//  Arb Scoring Per Pair
// ══════════════════════════════════════════════════════════════

function scoreArbForPair(
  pair: PoolPairInput,
  notionalUsdc: number,
  direction: Direction,
): ArbScoreRecord {
  const tier: "micro" | "scale" = notionalUsdc <= 100 ? "micro" : "scale";
  const rejectReasons: ArbRejectReason[] = [];

  // Determine buy/sell dex
  let buyDex: "orca" | "raydium";
  let sellDex: "orca" | "raydium";
  let buyMeta: { feeBps: number; liqUsd: number; vol24hUsd: number; poolId: string };
  let sellMeta: { feeBps: number; liqUsd: number; vol24hUsd: number; poolId: string };
  let buyPrice: number | null;
  let sellPrice: number | null;

  if (direction === "D1_BuyOrca_SellRaydium") {
    buyDex = "orca";
    sellDex = "raydium";
    buyMeta = { feeBps: pair.orcaMeta.feeBps, liqUsd: pair.orcaMeta.liqUsd, vol24hUsd: pair.orcaMeta.vol24hUsd, poolId: pair.orcaPoolId };
    sellMeta = { feeBps: pair.raydiumMeta.feeBps, liqUsd: pair.raydiumMeta.liqUsd, vol24hUsd: pair.raydiumMeta.vol24hUsd, poolId: pair.raydiumPoolId };
    buyPrice = pair.orcaMeta.price;
    sellPrice = pair.orcaMeta.price; // Use Orca price as reference for both legs
  } else {
    buyDex = "raydium";
    sellDex = "orca";
    buyMeta = { feeBps: pair.raydiumMeta.feeBps, liqUsd: pair.raydiumMeta.liqUsd, vol24hUsd: pair.raydiumMeta.vol24hUsd, poolId: pair.raydiumPoolId };
    sellMeta = { feeBps: pair.orcaMeta.feeBps, liqUsd: pair.orcaMeta.liqUsd, vol24hUsd: pair.orcaMeta.vol24hUsd, poolId: pair.orcaPoolId };
    buyPrice = pair.orcaMeta.price;
    sellPrice = pair.orcaMeta.price;
  }

  // ── Buy leg: USDC → BASE ──
  const buyQuote = cpmmQuote("buy", notionalUsdc, buyMeta.liqUsd, buyMeta.feeBps, buyPrice);
  if (!buyQuote) {
    const reason: ArbRejectReason = buyDex === "orca" ? "QUOTE_FAIL_ORCA_BUY" : "QUOTE_FAIL_RAYDIUM_BUY";
    rejectReasons.push(reason);
  }

  // ── Sell leg: BASE → USDC ──
  const baseBought = buyQuote?.outputAmount ?? 0;
  const sellQuote = baseBought > 0
    ? cpmmQuote("sell", baseBought, sellMeta.liqUsd, sellMeta.feeBps, sellPrice)
    : null;
  if (!sellQuote && buyQuote) {
    const reason: ArbRejectReason = sellDex === "orca" ? "QUOTE_FAIL_ORCA_SELL" : "QUOTE_FAIL_RAYDIUM_SELL";
    rejectReasons.push(reason);
  }

  const usdcOut = sellQuote?.outputAmount ?? 0;
  const grossProfitUsdc = usdcOut - notionalUsdc;

  // Safety buffer
  const safetyBufferUsdc = tier === "micro"
    ? BUFFER_MICRO_USDC
    : notionalUsdc * BUFFER_SCALE_BPS / 10_000;

  const netProfitUsdc = grossProfitUsdc - safetyBufferUsdc;
  const netProfitBps = notionalUsdc > 0
    ? Number(((netProfitUsdc / notionalUsdc) * 10_000).toFixed(2))
    : 0;

  // ── Eligibility checks ──

  // Liquidity / volume for micro
  if (tier === "micro") {
    if (buyMeta.liqUsd < MIN_LIQ_USD_MICRO || sellMeta.liqUsd < MIN_LIQ_USD_MICRO) {
      rejectReasons.push("LOW_LIQUIDITY_MICRO");
    }
    if (buyMeta.vol24hUsd < MIN_VOL_24H_USD_MICRO || sellMeta.vol24hUsd < MIN_VOL_24H_USD_MICRO) {
      rejectReasons.push("LOW_VOLUME_MICRO");
    }
  }

  // Liquidity / volume for scale
  if (tier === "scale") {
    if (buyMeta.liqUsd < MIN_LIQ_USD_SCALE || sellMeta.liqUsd < MIN_LIQ_USD_SCALE) {
      rejectReasons.push("LOW_LIQUIDITY_SCALE");
    }
    if (buyMeta.vol24hUsd < MIN_VOL_24H_USD_SCALE || sellMeta.vol24hUsd < MIN_VOL_24H_USD_SCALE) {
      rejectReasons.push("LOW_VOLUME_SCALE");
    }
  }

  // Impact check
  const maxImpact = tier === "micro" ? 1.5 : 2.0;
  if ((buyQuote?.priceImpactPct ?? 100) > maxImpact || (sellQuote?.priceImpactPct ?? 100) > maxImpact) {
    rejectReasons.push("IMPACT_TOO_HIGH");
  }

  // Net profit
  if (netProfitUsdc < 0) {
    rejectReasons.push("NET_PROFIT_NEGATIVE");
  }

  const buyLeg: LegQuote = {
    dex: buyDex,
    poolId: buyMeta.poolId,
    side: "buy",
    inputAmount: notionalUsdc,
    outputAmount: buyQuote?.outputAmount ?? 0,
    effectivePrice: buyQuote?.effectivePrice ?? 0,
    priceImpactPct: buyQuote?.priceImpactPct ?? 100,
    feeCostUsdc: buyQuote?.feeCostUsdc ?? 0,
    tvlUsd: buyMeta.liqUsd,
  };

  const sellLeg: LegQuote = {
    dex: sellDex,
    poolId: sellMeta.poolId,
    side: "sell",
    inputAmount: baseBought,
    outputAmount: usdcOut,
    effectivePrice: sellQuote?.effectivePrice ?? 0,
    priceImpactPct: sellQuote?.priceImpactPct ?? 100,
    feeCostUsdc: sellQuote?.feeCostUsdc ?? 0,
    tvlUsd: sellMeta.liqUsd,
  };

  const eligible = rejectReasons.length === 0 && (
    tier === "micro"
      ? netProfitUsdc >= MICRO_MIN_NET_PROFIT_USDC && netProfitBps >= MICRO_MIN_NET_PROFIT_BPS
      : netProfitUsdc >= SCALE_MIN_NET_PROFIT_USDC && netProfitBps >= SCALE_MIN_NET_PROFIT_BPS
  );

  return {
    baseMint: pair.baseMint,
    baseSymbol: pair.baseSymbol,
    notionalUsdc,
    direction,
    buyLeg,
    sellLeg,
    grossProfitUsdc: Number(grossProfitUsdc.toFixed(6)),
    safetyBufferUsdc: Number(safetyBufferUsdc.toFixed(6)),
    netProfitUsdc: Number(netProfitUsdc.toFixed(6)),
    netProfitBps,
    rejectReasons,
    tier,
    eligible,
  };
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function toWhitelistEntry(r: ArbScoreRecord, pair: PoolPairInput): WhitelistEntry {
  return {
    baseMint: r.baseMint,
    baseSymbol: r.baseSymbol,
    notionalUsdc: r.notionalUsdc,
    direction: r.direction,
    netProfitUsdc: r.netProfitUsdc,
    netProfitBps: r.netProfitBps,
    buyDex: r.buyLeg.dex,
    sellDex: r.sellLeg.dex,
    buyImpactPct: r.buyLeg.priceImpactPct,
    sellImpactPct: r.sellLeg.priceImpactPct,
    buyFeeCostUsdc: r.buyLeg.feeCostUsdc,
    sellFeeCostUsdc: r.sellLeg.feeCostUsdc,
    orcaPoolId: pair.orcaPoolId,
    raydiumPoolId: pair.raydiumPoolId,
  };
}

function buildHistogram(values: number[], buckets: number[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (let i = 0; i < buckets.length; i++) {
    const lo = i === 0 ? -Infinity : buckets[i - 1];
    const hi = buckets[i];
    const label = i === 0 ? `<${hi}` : `${lo}–${hi}`;
    hist[label] = values.filter((v) => v >= lo && v < hi).length;
  }
  const last = buckets[buckets.length - 1];
  hist[`${last}+`] = values.filter((v) => v >= last).length;
  return hist;
}

// ══════════════════════════════════════════════════════════════
//  CLI & Main
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Route=1 Cross-DEX Arb Scoring — M2 Step 3                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const dataDir = path.resolve(process.cwd(), "data");
  const pairsPath = path.join(dataDir, "route1_pool_pairs.json");

  // ── Load pairs ──
  let pairsFile: PairsFile;
  try {
    const raw = await fs.readFile(pairsPath, "utf-8");
    pairsFile = JSON.parse(raw) as PairsFile;
  } catch {
    console.error(`  ✗ Failed to read ${pairsPath}`);
    console.error(`    Run 'npm run match:route1' first.`);
    process.exit(1);
  }

  const pairs = pairsFile.pairs;
  console.log(`  Input:        ${pairs.length} matched pool pairs`);
  console.log(`  Micro Notionals: ${N_MICRO.join(", ")} USDC`);
  console.log(`  Scale Notionals: ${N_SCALE.join(", ")} USDC`);
  console.log(`  Buffers:      micro=${BUFFER_MICRO_USDC} USDC, scale=${BUFFER_SCALE_BPS} bps`);
  console.log(`  Directions:   D1 (Buy Orca → Sell Raydium), D2 (Buy Raydium → Sell Orca)`);
  console.log(`  Dry run:      ${dryRun}\n`);

  if (pairs.length === 0) {
    console.log(`  ⚠ No pairs to score. Run discovery + matching first.\n`);
    return;
  }

  // ── Score all pairs × notionals × directions ──
  const allScores: ArbScoreRecord[] = [];
  const directions: Direction[] = ["D1_BuyOrca_SellRaydium", "D2_BuyRaydium_SellOrca"];

  for (const pair of pairs) {
    for (const notional of ALL_NOTIONALS) {
      for (const dir of directions) {
        const score = scoreArbForPair(pair, notional, dir);
        allScores.push(score);
      }
    }
  }

  console.log(`  Total score records: ${allScores.length} (${pairs.length} pairs × ${ALL_NOTIONALS.length} notionals × 2 directions)\n`);

  // ── Per-record console summary ──
  console.log(`─── Per-Pair Best Edge ─────────────────────────────────────\n`);
  console.log(
    `  ${"Symbol".padEnd(12)} ${"N$".padStart(6)} ${"Dir".padEnd(8)} ${"Gross".padStart(10)} ${"Net".padStart(10)} ${"BPS".padStart(8)} ${"Rejects".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(8)}`,
  );

  // Show best record per pair (by netProfitBps)
  const pairMap = new Map<string, ArbScoreRecord>();
  for (const s of allScores) {
    const key = s.baseMint;
    const existing = pairMap.get(key);
    if (!existing || s.netProfitBps > existing.netProfitBps) {
      pairMap.set(key, s);
    }
  }
  const bestPerPair = Array.from(pairMap.values()).sort((a, b) => b.netProfitBps - a.netProfitBps);

  for (const s of bestPerPair) {
    const dirShort = s.direction === "D1_BuyOrca_SellRaydium" ? "O→R" : "R→O";
    console.log(
      `  ${s.baseSymbol.padEnd(12)} ${("$" + s.notionalUsdc).padStart(6)} ${dirShort.padEnd(8)} ${("$" + s.grossProfitUsdc.toFixed(4)).padStart(10)} ${("$" + s.netProfitUsdc.toFixed(4)).padStart(10)} ${s.netProfitBps.toFixed(1).padStart(8)} ${String(s.rejectReasons.length).padStart(8)}`,
    );
  }

  // ── Classify into whitelists ──
  const microScores = allScores.filter((s) => s.tier === "micro");
  const scaleScores = allScores.filter((s) => s.tier === "scale");

  const microWhitelist: WhitelistEntry[] = [];
  const scaleWhitelist: WhitelistEntry[] = [];
  const softlistMicro: SoftlistEntry[] = [];

  // Micro whitelist
  for (const s of microScores) {
    const pair = pairs.find((p) => p.baseMint === s.baseMint)!;
    if (s.eligible) {
      microWhitelist.push(toWhitelistEntry(s, pair));
    }
  }

  // Scale whitelist
  for (const s of scaleScores) {
    const pair = pairs.find((p) => p.baseMint === s.baseMint)!;
    if (s.eligible) {
      scaleWhitelist.push(toWhitelistEntry(s, pair));
    }
  }

  // Softlist micro: near-miss (netProfit > -0.05 but not eligible, OR positive but fails curve/impact)
  for (const s of microScores) {
    if (s.eligible) continue;
    if (s.netProfitUsdc >= SOFTLIST_MIN_NET_PROFIT_USDC) {
      const pair = pairs.find((p) => p.baseMint === s.baseMint)!;
      softlistMicro.push({ ...toWhitelistEntry(s, pair), rejectReasons: s.rejectReasons });
    }
  }

  // Sort by netProfitBps desc
  microWhitelist.sort((a, b) => b.netProfitBps - a.netProfitBps);
  scaleWhitelist.sort((a, b) => b.netProfitBps - a.netProfitBps);
  softlistMicro.sort((a, b) => b.netProfitBps - a.netProfitBps);

  // Dedupe whitelists: keep best record per baseMint+direction
  function dedupeList<T extends { baseMint: string; direction: string; netProfitBps: number }>(list: T[]): T[] {
    const seen = new Map<string, T>();
    for (const entry of list) {
      const key = `${entry.baseMint}:${entry.direction}`;
      const existing = seen.get(key);
      if (!existing || entry.netProfitBps > existing.netProfitBps) {
        seen.set(key, entry);
      }
    }
    return Array.from(seen.values()).sort((a, b) => b.netProfitBps - a.netProfitBps);
  }

  const microWLFinal = dedupeList(microWhitelist);
  const scaleWLFinal = dedupeList(scaleWhitelist);
  const softlistFinal = dedupeList(softlistMicro);

  // ── Console summary ──
  console.log(`\n─── Arb Classification Summary ─────────────────────────────\n`);
  console.log(`  Micro whitelist candidates:   ${microWLFinal.length}`);
  console.log(`  Scale whitelist candidates:   ${scaleWLFinal.length}`);
  console.log(`  Softlist (micro near-miss):   ${softlistFinal.length}`);

  // ── Reject reasons histogram ──
  const rejectCounts: Record<string, number> = {};
  for (const s of allScores) {
    for (const r of s.rejectReasons) {
      rejectCounts[r] = (rejectCounts[r] ?? 0) + 1;
    }
  }

  console.log(`\n─── Dominant Reject Reasons (all records) ──────────────────\n`);
  const sortedRejects = Object.entries(rejectCounts).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedRejects) {
    if (count > 0) console.log(`  ${reason.padEnd(28)} ${count}`);
  }

  // ── Micro whitelist table ──
  if (microWLFinal.length > 0) {
    console.log(`\n─── Micro Whitelist (top 20) ───────────────────────────────\n`);
    console.log(
      `  ${"#".padStart(3)}  ${"Symbol".padEnd(12)} ${"N$".padStart(6)} ${"Dir".padEnd(6)} ${"Net$".padStart(10)} ${"BPS".padStart(8)} ${"BuyImp%".padStart(8)} ${"SellImp%".padStart(8)}`,
    );
    for (let i = 0; i < Math.min(microWLFinal.length, 20); i++) {
      const e = microWLFinal[i];
      const dir = e.direction === "D1_BuyOrca_SellRaydium" ? "O→R" : "R→O";
      console.log(
        `  ${String(i + 1).padStart(3)}  ${e.baseSymbol.padEnd(12)} ${("$" + e.notionalUsdc).padStart(6)} ${dir.padEnd(6)} ${("$" + e.netProfitUsdc.toFixed(4)).padStart(10)} ${e.netProfitBps.toFixed(1).padStart(8)} ${e.buyImpactPct.toFixed(3).padStart(8)} ${e.sellImpactPct.toFixed(3).padStart(8)}`,
      );
    }
  }

  // ── Scale whitelist table ──
  if (scaleWLFinal.length > 0) {
    console.log(`\n─── Scale Whitelist (top 20) ───────────────────────────────\n`);
    console.log(
      `  ${"#".padStart(3)}  ${"Symbol".padEnd(12)} ${"N$".padStart(7)} ${"Dir".padEnd(6)} ${"Net$".padStart(10)} ${"BPS".padStart(8)} ${"BuyImp%".padStart(8)} ${"SellImp%".padStart(8)}`,
    );
    for (let i = 0; i < Math.min(scaleWLFinal.length, 20); i++) {
      const e = scaleWLFinal[i];
      const dir = e.direction === "D1_BuyOrca_SellRaydium" ? "O→R" : "R→O";
      console.log(
        `  ${String(i + 1).padStart(3)}  ${e.baseSymbol.padEnd(12)} ${("$" + e.notionalUsdc).padStart(7)} ${dir.padEnd(6)} ${("$" + e.netProfitUsdc.toFixed(4)).padStart(10)} ${e.netProfitBps.toFixed(1).padStart(8)} ${e.buyImpactPct.toFixed(3).padStart(8)} ${e.sellImpactPct.toFixed(3).padStart(8)}`,
      );
    }
  }

  // ── Build summary ──
  const netProfitBpsValues = allScores.map((s) => s.netProfitBps);
  const impactValues = allScores.map((s) => Math.max(s.buyLeg.priceImpactPct, s.sellLeg.priceImpactPct));

  const summary = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    version: "arb_route1_m2",
    totalPairsScored: pairs.length,
    totalRecords: allScores.length,
    quoteFail: {
      orcaBuy: allScores.filter((s) => s.rejectReasons.includes("QUOTE_FAIL_ORCA_BUY")).length,
      raydiumBuy: allScores.filter((s) => s.rejectReasons.includes("QUOTE_FAIL_RAYDIUM_BUY")).length,
      orcaSell: allScores.filter((s) => s.rejectReasons.includes("QUOTE_FAIL_ORCA_SELL")).length,
      raydiumSell: allScores.filter((s) => s.rejectReasons.includes("QUOTE_FAIL_RAYDIUM_SELL")).length,
    },
    microWhitelistCount: microWLFinal.length,
    scaleWhitelistCount: scaleWLFinal.length,
    softlistMicroCount: softlistFinal.length,
    dominantRejectReasons: Object.fromEntries(sortedRejects),
    histogram: {
      netProfitBps: buildHistogram(netProfitBpsValues, [-100, -50, -20, -10, -5, 0, 5, 10, 20, 50, 100]),
      maxImpactPct: buildHistogram(impactValues, [0.01, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0]),
    },
    top20MicroByNetProfitBps: microWLFinal.slice(0, 20),
    top20ScaleByNetProfitBps: scaleWLFinal.slice(0, 20),
  };

  if (dryRun) {
    console.log(`\n  [DRY RUN] Skipping file writes.\n`);
    return;
  }

  // ── Write outputs ──
  await fs.mkdir(dataDir, { recursive: true });

  // 1. arb_route1_scores.json (full)
  const scoresPath = path.join(dataDir, "arb_route1_scores.json");
  await fs.writeFile(
    scoresPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "arb_route1_m2",
        records: allScores,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`\n  ✓ Full scores (${allScores.length} records) written to ${scoresPath}`);

  // 2. arbSoftlist_micro.json
  const softlistPath = path.join(dataDir, "arbSoftlist_micro.json");
  await fs.writeFile(
    softlistPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "arb_route1_m2",
        description: "Micro near-miss: netProfit > -0.05 but not eligible, or positive but fails impact/liq checks",
        entries: softlistFinal,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Softlist micro (${softlistFinal.length} entries) written to ${softlistPath}`);

  // 3. arbWhitelist_micro.json
  const microPath = path.join(dataDir, "arbWhitelist_micro.json");
  await fs.writeFile(
    microPath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "arb_route1_m2",
        tier: "micro",
        thresholds: {
          minNetProfitUsdc: MICRO_MIN_NET_PROFIT_USDC,
          minNetProfitBps: MICRO_MIN_NET_PROFIT_BPS,
          minLiqUsd: MIN_LIQ_USD_MICRO,
          minVol24hUsd: MIN_VOL_24H_USD_MICRO,
          bufferUsdc: BUFFER_MICRO_USDC,
        },
        entries: microWLFinal,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Micro whitelist (${microWLFinal.length} entries) written to ${microPath}`);

  // 4. arbWhitelist_scale.json
  const scalePath = path.join(dataDir, "arbWhitelist_scale.json");
  await fs.writeFile(
    scalePath,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        version: "arb_route1_m2",
        tier: "scale",
        thresholds: {
          minNetProfitUsdc: SCALE_MIN_NET_PROFIT_USDC,
          minNetProfitBps: SCALE_MIN_NET_PROFIT_BPS,
          minLiqUsd: MIN_LIQ_USD_SCALE,
          minVol24hUsd: MIN_VOL_24H_USD_SCALE,
          bufferBps: BUFFER_SCALE_BPS,
        },
        entries: scaleWLFinal,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  ✓ Scale whitelist (${scaleWLFinal.length} entries) written to ${scalePath}`);

  // 5. arb_summary.json
  const summaryPath = path.join(dataDir, "arb_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Summary written to ${summaryPath}`);

  // ── Acceptance criteria ──
  console.log(`\n─── M2 Acceptance Criteria ─────────────────────────────────\n`);
  const hasNonEmpty = microWLFinal.length > 0 || scaleWLFinal.length > 0 || softlistFinal.length > 0;
  console.log(`  [${hasNonEmpty ? "✓" : "⚠"}] At least 1 list non-empty: micro=${microWLFinal.length}, scale=${scaleWLFinal.length}, softlist=${softlistFinal.length}`);
  console.log(`  [${sortedRejects.length > 0 ? "✓" : "✗"}] Summary shows dominant reject reasons: ${sortedRejects.length} reasons`);
  console.log(`  [✓] Deterministic results (TVL-based constant-product, no RPC/routing)`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
