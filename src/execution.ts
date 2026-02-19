import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { getConnection, sendVersionedWithOpts, resolveSolBalance, deriveATA } from "./solana.js";
import { loadConfig, type TokenSymbol, type TradePair } from "./config.js";
import { toRaw } from "./tokens.js";
import { suggestPriorityFee } from "./fees.js";
import { takeBalanceSnapshot } from "./balanceSnapshot.js";
import {
  Direction,
  BuildSimulateResult,
  SimulatedLeg,
  SendResult,
  SendAttempt,
  LimitBreachError,
  SimulationError,
  SlippageError,
  SendError,
  NetProfitRejectedError,
  NetProfitInfo,
  TelemetryStatus,
  QuoteMeta
} from "./types.js";
import { fetchJupiterQuote, buildJupiterSwap, computeSlippageBps, simulateJupiterTx, type JupiterRouteInfo } from "./jupiter.js";
import { fetchOkxQuote, buildOkxSwap, simulateOkxTx, isOkxAvailable, getOkxCooldownRemaining } from "./okxDex.js";
import { buildTelemetry, appendTradeLog } from "./telemetry.js";
import {
  prepareAtomicBundle,
  sendJitoBundle,
  waitForBundleLanding,
  checkBundleTxResults,
  JitoBundleError,
  type JitoBundleResult,
  type AtomicBundleData,
} from "./jito.js";

let consecutiveFailedSends = 0;

/** Reset circuit breaker counter (called after successful unwind or manual reset) */
export function resetCircuitBreaker(): void {
  consecutiveFailedSends = 0;
}

// ───── Net Profit Helpers ─────

/**
 * Dinamik priority fee: zincirden güncel fee çeker ve config ile cap'ler.
 * Sonucu cache'ler (fees.ts 10s TTL) — her çağrıda RPC yapmaz.
 */
let _resolvedPriorityFee: number | undefined;

async function resolvePriorityFee(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.dynamicPriorityFee) {
    return cfg.rpc.priorityFeeMicrolamports ?? 50_000;
  }
  // Cache kontrolü — aynı tick içinde tekrar RPC çağrısı yapmaz
  if (_resolvedPriorityFee !== undefined) return _resolvedPriorityFee;

  const connection = getConnection();
  const suggestion = await suggestPriorityFee(connection, cfg.maxPriorityFee);
  _resolvedPriorityFee = suggestion?.priorityFeeMicrolamports ?? cfg.rpc.priorityFeeMicrolamports ?? 50_000;
  // 30 saniye sonra resetle — sonraki tick'te taze fee alınsın
  setTimeout(() => { _resolvedPriorityFee = undefined; }, 30_000);
  return _resolvedPriorityFee;
}

/** Export for PriceTicker to pre-resolve before estimate cycle */
export { resolvePriorityFee };

/**
 * Estimate total Solana network fee for a given number of transaction legs.
 * Returns fee in SOL.
 *
 * Per-tx cost = base_fee (5000 lamports per signature) + priority_fee
 *   priority_fee = (PRIORITY_FEE_MICROLAMPORTS * computeUnits) / 1e6
 * We assume ~200_000 CU per transaction (typical swap CU budget).
 */
const BASE_FEE_LAMPORTS = 5_000;       // Solana base fee per signature
const ASSUMED_CU_PER_TX  = 200_000;    // conservative CU budget

function estimateTxFeeSol(priorityFeeMicrolamports: number | undefined, legCount: number): number {
  const priorityLamports = priorityFeeMicrolamports
    ? (priorityFeeMicrolamports * ASSUMED_CU_PER_TX) / 1_000_000
    : 0;
  const perTxLamports = BASE_FEE_LAMPORTS + priorityLamports;
  return (perTxLamports * legCount) / 1e9; // lamports → SOL
}

function estimateFeeUsdc(feeSol: number, solUsdcRate: number): number {
  return feeSol * solUsdcRate;
}

export interface NetProfitDecision {
  grossProfitUsdc: number;
  estimatedFeeUsdc: number;
  netProfitUsdc: number;
  approved: boolean;
}

/**
 * Lightweight quote-only profit estimate for a given direction.
 * Used by PriceTicker to compare both directions before committing
 * to a full build+simulate cycle.
 */
export interface QuoteEstimate {
  direction: Direction;
  targetToken: TokenSymbol;
  grossProfitUsdc: number;
  estimatedFeeUsdc: number;
  netProfitUsdc: number;
  /** Whether net profit exceeds the configured minimum threshold */
  viable: boolean;
  /** Cached Jupiter route for reuse in buildAndSimulate (avoids duplicate API call) */
  _cachedJupRoute?: JupiterRouteInfo;
  /** Cached Jupiter quote meta */
  _cachedJupMeta?: QuoteMeta;
  /** Cached OKX quote meta */
  _cachedOkxMeta?: QuoteMeta;
}

/** TokenSymbol → TradePair dönüştürü */
export function pairFromToken(token: TokenSymbol): TradePair {
  return `${token}/USDC` as TradePair;
}

/**
 * Fetch quotes for both legs of a direction and estimate net profit
 * WITHOUT building transactions or simulating. This is cheap and fast,
 * suitable for parallel comparison of JUP_TO_OKX vs OKX_TO_JUP.
 *
 * OKX rate-limited ise hızlıca hata fırlatır — caller bunu yakalar ve atlar.
 */
export async function estimateDirectionProfit(params: {
  direction: Direction;
  notionalUsd: number;
  ownerStr: string;
  /** Hangi token üzerinden arbitraj yapılacak (WIF veya JUP). Varsayılan: WIF */
  targetToken?: TokenSymbol;
}): Promise<QuoteEstimate> {
  const cfg = loadConfig();
  enforceNotional(params.notionalUsd, cfg.notionalCapUsd);

  // OKX rate-limited ise bu yönü boşuna deneme — hızlı skip
  if (!isOkxAvailable()) {
    throw new Error(
      `OKX rate-limited (${getOkxCooldownRemaining()}s kaldı) — ${params.direction} atlanıyor`
    );
  }

  const targetToken: TokenSymbol = params.targetToken ?? "WIF";
  const usdcDecimals = cfg.tokens.USDC.decimals;
  const usdcMint = cfg.tokens.USDC.mint;
  const targetMint = cfg.tokens[targetToken].mint;
  const amountRaw = toRaw(params.notionalUsd, usdcDecimals);

  let finalOutRaw: bigint;
  let _cachedJupRoute: JupiterRouteInfo | undefined;
  let _cachedJupMeta: QuoteMeta | undefined;
  let _cachedOkxMeta: QuoteMeta | undefined;

  if (params.direction === "JUP_TO_OKX") {
    // Leg 1: Jupiter USDC → targetToken
    const { route, meta: jupMeta } = await fetchJupiterQuote({
      inputMint: usdcMint, outputMint: targetMint,
      amount: amountRaw, slippageBps: cfg.slippageBps,
    });
    _cachedJupRoute = route;
    _cachedJupMeta = jupMeta;
    // Leg 2: OKX targetToken → USDC
    const { meta: okxMeta } = await fetchOkxQuote({
      inputMint: targetMint, outputMint: usdcMint,
      amount: jupMeta.expectedOut, slippageBps: cfg.slippageBps,
      userPublicKey: params.ownerStr,
    });
    _cachedOkxMeta = okxMeta;
    finalOutRaw = okxMeta.expectedOut;
  } else {
    // Leg 1: OKX USDC → targetToken
    const { meta: okxMeta } = await fetchOkxQuote({
      inputMint: usdcMint, outputMint: targetMint,
      amount: amountRaw, slippageBps: cfg.slippageBps,
      userPublicKey: params.ownerStr,
    });
    _cachedOkxMeta = okxMeta;
    // Leg 2: Jupiter targetToken → USDC
    const { route, meta: jupMeta } = await fetchJupiterQuote({
      inputMint: targetMint, outputMint: usdcMint,
      amount: okxMeta.expectedOut, slippageBps: cfg.slippageBps,
    });
    _cachedJupRoute = route;
    _cachedJupMeta = jupMeta;
    finalOutRaw = jupMeta.expectedOut;
  }

  const grossProfitRaw = finalOutRaw - amountRaw;
  const grossProfitUsdc = Number(grossProfitRaw) / 10 ** usdcDecimals;
  // Dinamik priority fee kullan — sabit yerine zincirden güncel fee
  const dynamicFee = await resolvePriorityFee();
  const feeSol = estimateTxFeeSol(dynamicFee, 2);
  const estFeeUsdc = estimateFeeUsdc(feeSol, cfg.solUsdcRate);
  const netProfitUsdc = grossProfitUsdc - estFeeUsdc;

  return {
    direction: params.direction,
    targetToken,
    grossProfitUsdc,
    estimatedFeeUsdc: estFeeUsdc,
    netProfitUsdc,
    viable: netProfitUsdc >= cfg.minNetProfitUsdc,
    _cachedJupRoute,
    _cachedJupMeta,
    _cachedOkxMeta,
  };
}

interface BuildParams {
  direction: Direction;
  notionalUsd: number; // USDC notionals
  owner: PublicKey;
  /** Hangi token üzerinden arbitraj: WIF veya JUP. Varsayılan: WIF */
  targetToken?: TokenSymbol;
  /** When true, simulation errors are logged as warnings instead of throwing */
  dryRun?: boolean;
  /** Pre-fetched estimate — skips redundant quote API calls in buildAndSimulate */
  cachedEstimate?: QuoteEstimate;
}

function enforceNotional(notional: number, cap: number) {
  if (notional > cap) {
    throw new LimitBreachError(`Notional ${notional} exceeds cap ${cap}`);
  }
  if (notional <= 0) {
    throw new LimitBreachError("Notional must be positive");
  }
}

/**
 * Simülasyon sonrasından NET token değişimini (delta) hesaplar.
 * postBalance - preBalance farkını alarak takastan elde edilen gerçek miktarı döndürür.
 * Eğer preTokenBalances yoksa (eski RPC), sadece postBalance kullanılır (fallback).
 */
function extractSimulatedOut(sim: SimulatedLeg["simulation"], mint?: string, owner?: string): bigint | undefined {
  if (!mint || !owner) return undefined;

  const postEntry = sim.postTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
  if (!postEntry) return undefined;

  const postRaw = postEntry.rawAmount
    ? BigInt(postEntry.rawAmount)
    : postEntry.uiAmount && typeof postEntry.decimals === "number"
      ? BigInt(Math.round(Number(postEntry.uiAmount) * 10 ** postEntry.decimals))
      : undefined;
  if (postRaw === undefined) return undefined;

  // preTokenBalances'tan aynı mint+owner kaydını bul
  const preEntry = sim.preTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
  const preRaw = preEntry?.rawAmount
    ? BigInt(preEntry.rawAmount)
    : preEntry?.uiAmount && typeof preEntry.decimals === "number"
      ? BigInt(Math.round(Number(preEntry.uiAmount) * 10 ** preEntry.decimals))
      : BigInt(0); // Hesap yoksa swap öncesi bakiye 0 kabul edilir

  const delta = postRaw - preRaw;

  // Delta negatifse (input token), 0 döndür — bu çıkış token'ı değil
  if (delta < BigInt(0)) return undefined;

  console.log(
    `[DEBUG] extractSimulatedOut mint=${mint.slice(0, 8)}… ` +
    `pre=${preRaw.toString()} post=${postRaw.toString()} delta=${delta.toString()}`
  );

  return delta;
}

async function simulateLeg(leg: SimulatedLeg, venue: "JUPITER" | "OKX") {
  const connection = getConnection();
  const sim = await (venue === "JUPITER" ? simulateJupiterTx(connection, leg.tx) : simulateOkxTx(connection, leg.tx));
  const simulatedOut = extractSimulatedOut(sim, leg.outMint, leg.owner) ?? leg.simulatedOut;
  const effectiveSlippageBps = computeSlippageBps(leg.expectedOut, simulatedOut);
  return { ...leg, simulation: sim, simulatedOut, effectiveSlippageBps };
}

/**
 * Dry-run-safe wrapper: catches simulation RPC errors (e.g. AccountNotFound)
 * and records them as leg.simulation.error instead of throwing.
 * This allows the net profit calculation to proceed with quote-based estimates.
 */
async function simulateLegSafe(leg: SimulatedLeg, venue: "JUPITER" | "OKX", dryRun: boolean): Promise<SimulatedLeg> {
  try {
    return await simulateLeg(leg, venue);
  } catch (err) {
    if (dryRun) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[WARN] ${venue} simülasyonu hata fırlattı: ${errorMsg} — dry-run devam ediyor`);
      leg.simulation = { ...leg.simulation, error: errorMsg };
      return leg;
    }
    throw err;
  }
}

export async function buildAndSimulate(params: BuildParams): Promise<BuildSimulateResult> {
  const cfg = loadConfig();
  const targetToken: TokenSymbol = params.targetToken ?? "WIF";
  console.log(`[DEBUG] buildAndSimulate başladı — direction=${params.direction}, targetToken=${targetToken}, notional=${params.notionalUsd}`);
  enforceNotional(params.notionalUsd, cfg.notionalCapUsd);

  const usdcDecimals = cfg.tokens.USDC.decimals;
  const usdcMint = cfg.tokens.USDC.mint;
  const targetMint = cfg.tokens[targetToken].mint;

  const amountRaw = toRaw(params.notionalUsd, usdcDecimals);
  const ownerStr = params.owner.toBase58();
  console.log(`[DEBUG] amountRaw=${amountRaw.toString()}, owner=${ownerStr}`);

  const legs: SimulatedLeg[] = [];
  const quoteMeta = [] as BuildSimulateResult["quoteMeta"];
  // Dinamik fee — swap TX'lere iletilecek
  const dynFee = await resolvePriorityFee();

  // ── CACHED ESTIMATE KONTROLÜ ──
  // estimateDirectionProfit'ten gelen cache'li Jupiter route + OKX meta varsa
  // AYNI fiyatları kullanarak TX oluştur — re-quote YAPMA.
  // Bu, tahmini kâr ile gönderim kârının AYNI olmasını garanti eder.
  const cached = params.cachedEstimate;
  const hasJupCache = !!(cached?._cachedJupRoute && cached?._cachedJupMeta);
  const hasOkxCache = !!(cached?._cachedOkxMeta);

  if (hasJupCache) {
    console.log(`[CACHE-HIT] Jupiter route cache'den kullanılacak — re-quote atlanıyor (stale fiyat riski önlendi)`);
  }

  if (params.direction === "JUP_TO_OKX") {
    // ── Leg 1: Jupiter USDC → targetToken ──
    let jupRoute: JupiterRouteInfo;
    let jupMeta: QuoteMeta;

    if (hasJupCache) {
      // ★ CACHE: estimateDirectionProfit'ten gelen aynı route'u kullan
      jupRoute = cached!._cachedJupRoute!;
      jupMeta = cached!._cachedJupMeta!;
      console.log(`[CACHE] Leg 1/2 — Cached Jupiter route (expectedOut=${jupMeta.expectedOut.toString()})`);
    } else {
      // Fresh quote (cache yoksa)
      console.log(`[FRESH] Leg 1/2 — Jupiter TAZE quote isteniyor (USDC→${targetToken})...`);
      const t0 = Date.now();
      const result = await fetchJupiterQuote({
        inputMint: usdcMint, outputMint: targetMint,
        amount: amountRaw, slippageBps: cfg.slippageBps
      });
      jupRoute = result.route;
      jupMeta = result.meta;
      console.log(`[FRESH] Jupiter quote alındı (${Date.now() - t0}ms) — expectedOut=${jupMeta.expectedOut.toString()}`);
    }
    quoteMeta.push(jupMeta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t1 = Date.now();
    const jupTx = await buildJupiterSwap({ route: jupRoute, userPublicKey: params.owner, priorityFeeMicroLamports: dynFee });
    console.log(`[DEBUG] Jupiter swap TX hazır (${Date.now() - t1}ms)`);

    const jupLeg: SimulatedLeg = {
      venue: "JUPITER",
      tx: jupTx,
      outMint: targetMint,
      owner: ownerStr,
      expectedOut: jupMeta.expectedOut,
      simulatedOut: jupMeta.expectedOut,
      simulation: { logs: [] }
    };

    // ★ Leg 1 simülasyonu ATLANIR (live mode) — hız optimizasyonu.
    // On-chain slippage koruması (otherAmountThreshold) zaten aktif.
    // Sadece dryRun modunda simüle et.
    if (params.dryRun) {
      console.log("[DEBUG] Jupiter TX simüle ediliyor (dry-run)...");
      const t2 = Date.now();
      legs.push(await simulateLegSafe(jupLeg, "JUPITER", true));
      console.log(`[DEBUG] Jupiter simülasyon tamamlandı (${Date.now() - t2}ms)`);
    } else {
      console.log(`[SKIP-SIM] Leg 1/2 (JUPITER) simülasyon atlandı — hız optimizasyonu, otherAmountThreshold aktif`);
      legs.push(jupLeg);
    }

    // ── Leg 2: OKX targetToken → USDC ──
    console.log(`[DEBUG] Leg 2/2 — OKX swap-instruction isteniyor (${targetToken}→USDC)...`);
    const t4 = Date.now();
    const { tx: okxTx, meta: okxMeta } = await buildOkxSwap({
      inputMint: targetMint,
      outputMint: usdcMint,
      amount: jupMeta.expectedOut,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr,
      priorityFeeMicroLamports: dynFee,
    });
    console.log(`[DEBUG] OKX swap TX + meta hazır (${Date.now() - t4}ms) — expectedOut=${okxMeta.expectedOut.toString()}`);
    quoteMeta.push(okxMeta);

    const okxLeg: SimulatedLeg = {
      venue: "OKX",
      tx: okxTx,
      outMint: usdcMint,
      owner: ownerStr,
      expectedOut: okxMeta.expectedOut,
      simulatedOut: okxMeta.expectedOut,
      simulation: { logs: [] }
    };

    console.log(`[SKIP-SIM] Leg 2/2 (${okxLeg.venue}) simülasyon atlandı — Leg 1 henüz zincirde değil, quote'a güveniliyor`);
    legs.push(okxLeg);
  } else {
    // ── Leg 1: OKX USDC → targetToken ──
    // OKX buildOkxSwap her zaman çağrılmalı (TX gerekli).
    console.log(`[DEBUG] Leg 1/2 — OKX swap-instruction isteniyor (USDC→${targetToken})...`);
    const t0 = Date.now();
    const { tx: okxTx, meta } = await buildOkxSwap({
      inputMint: usdcMint,
      outputMint: targetMint,
      amount: amountRaw,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr,
      priorityFeeMicroLamports: dynFee,
    });
    console.log(`[DEBUG] OKX swap TX + meta hazır (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);
    quoteMeta.push(meta);

    const okxLeg: SimulatedLeg = {
      venue: "OKX",
      tx: okxTx,
      outMint: targetMint,
      owner: ownerStr,
      expectedOut: meta.expectedOut,
      simulatedOut: meta.expectedOut,
      simulation: { logs: [] }
    };

    // ★ Leg 1 simülasyonu ATLANIR (live mode)
    if (params.dryRun) {
      console.log("[DEBUG] OKX TX simüle ediliyor (dry-run)...");
      const t2 = Date.now();
      legs.push(await simulateLegSafe(okxLeg, "OKX", true));
      console.log(`[DEBUG] OKX simülasyon tamamlandı (${Date.now() - t2}ms)`);
    } else {
      console.log(`[SKIP-SIM] Leg 1/2 (OKX) simülasyon atlandı — hız optimizasyonu, otherAmountThreshold aktif`);
      legs.push(okxLeg);
    }

    // ── Leg 2: Jupiter targetToken → USDC ──
    let jupRoute: JupiterRouteInfo;
    let jupMeta: QuoteMeta;

    // Cache kontrolü: OKX output cache'deki ile uyuşuyor mu?
    // Eğer OKX'ten gelen expectedOut, cache'deki ile %2'den az farklıysa
    // cache'li Jupiter route'u kullan — re-quote YAPMA.
    const okxOutDeviation = hasOkxCache
      ? Math.abs(Number(meta.expectedOut - cached!._cachedOkxMeta!.expectedOut)) / Number(cached!._cachedOkxMeta!.expectedOut)
      : Infinity;
    const canReuseJupCache = hasJupCache && okxOutDeviation < 0.02;

    if (canReuseJupCache) {
      jupRoute = cached!._cachedJupRoute!;
      jupMeta = cached!._cachedJupMeta!;
      console.log(
        `[CACHE] Leg 2/2 — Cached Jupiter route (OKX sapma: ${(okxOutDeviation * 100).toFixed(2)}% < 2%) — ` +
        `expectedOut=${jupMeta.expectedOut.toString()}`
      );
    } else {
      console.log(`[FRESH] Leg 2/2 — Jupiter TAZE quote isteniyor (${targetToken}→USDC)...`);
      if (hasOkxCache) {
        console.log(`[FRESH] OKX sapma: ${(okxOutDeviation * 100).toFixed(2)}% > 2% — cache geçersiz`);
      }
      const t3 = Date.now();
      const result = await fetchJupiterQuote({
        inputMint: targetMint,
        outputMint: usdcMint,
        amount: meta.expectedOut,
        slippageBps: cfg.slippageBps
      });
      jupRoute = result.route;
      jupMeta = result.meta;
      console.log(`[FRESH] Jupiter quote alındı (${Date.now() - t3}ms) — expectedOut=${jupMeta.expectedOut.toString()}`);
    }
    quoteMeta.push(jupMeta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t4 = Date.now();
    const jupTx = await buildJupiterSwap({ route: jupRoute, userPublicKey: params.owner, priorityFeeMicroLamports: dynFee });
    console.log(`[DEBUG] Jupiter swap TX hazır (${Date.now() - t4}ms)`);

    const jupLeg: SimulatedLeg = {
      venue: "JUPITER",
      tx: jupTx,
      outMint: usdcMint,
      owner: ownerStr,
      expectedOut: jupMeta.expectedOut,
      simulatedOut: jupMeta.expectedOut,
      simulation: { logs: [] }
    };

    console.log(`[SKIP-SIM] Leg 2/2 (${jupLeg.venue}) simülasyon atlandı — Leg 1 henüz zincirde değil, quote'a güveniliyor`);
    legs.push(jupLeg);
  }

  // ───── Net Profit hesabı (tüm kod yollarında telemetri için ÖNCE hesapla) ─────
  const leg2 = legs[legs.length - 1];
  const leg2ExpectedOut = leg2.expectedOut;       // bigint — quote'tan gelen raw USDC
  const inputRaw = amountRaw;                     // bigint — başlangıç raw USDC

  console.log(
    `[DEBUG] Net Profit hesabı — leg2.expectedOut=${leg2ExpectedOut.toString()}, ` +
    `leg2.simulatedOut=${leg2.simulatedOut?.toString() ?? "undefined"}, ` +
    `inputRaw=${inputRaw.toString()}`
  );

  const grossProfitRaw = leg2ExpectedOut - inputRaw;
  const grossProfitUsdc = Number(grossProfitRaw) / 10 ** usdcDecimals;
  // Dinamik priority fee kullan
  const dynamicFee = await resolvePriorityFee();
  const feeSol = estimateTxFeeSol(dynamicFee, legs.length);
  const feeUsdc = estimateFeeUsdc(feeSol, cfg.solUsdcRate);
  const netProfitUsdc = grossProfitUsdc - feeUsdc;
  const netProfit: NetProfitInfo = { grossProfitUsdc, feeUsdc, netProfitUsdc };

  // Telemetri için partial result — her yolda kullanılacak
  const partialResult: BuildSimulateResult = { direction: params.direction, legs, quoteMeta, netProfit };

  // ───── Slippage & Simulation kontrolleri ─────
  for (const [idx, leg] of legs.entries()) {
    if (cfg.slippageBps && leg.effectiveSlippageBps && leg.effectiveSlippageBps > cfg.slippageBps) {
      if (params.dryRun) {
        console.warn(`[WARN] Leg ${idx + 1} (${leg.venue}): Effective slippage ${leg.effectiveSlippageBps}bps exceeds cap ${cfg.slippageBps}bps`);
      } else {
        const failReason = `Effective slippage ${leg.effectiveSlippageBps}bps exceeds cap ${cfg.slippageBps}`;
        console.warn(`[TELEMETRY][SKIP] SLIPPAGE_EXCEEDED dosyaya yazılmadı — ${failReason}`);
        throw new SlippageError(failReason);
      }
    }
    if (leg.simulation.error) {
      if (params.dryRun) {
        console.warn(`[WARN] Leg ${idx + 1} (${leg.venue}): Simulation error: ${leg.simulation.error} — dry-run devam ediyor`);
      } else {
        const failReason = `Simulation failed: ${leg.simulation.error}`;
        console.warn(`[TELEMETRY][SKIP] SIMULATION_FAILED dosyaya yazılmadı — ${failReason}`);
        throw new SimulationError(failReason);
      }
    }
  }

  // ───── Net Profit Gate ─────
  // Live modda spread buffer uygulanır: tahmini kâr > min * 1.5 olmalı
  // Böylece on-chain slippage ve gas maliyeti karşısında marjinal trade'ler engellenir
  const PROFIT_GATE_BUFFER = params.dryRun ? 1.0 : 1.5;
  const effectiveMinProfit = cfg.minNetProfitUsdc * PROFIT_GATE_BUFFER;
  const approved = netProfitUsdc >= effectiveMinProfit;
  const tag = approved ? "ONAYLANDI" : "REDDEDİLDİ";
  console.log(
    `[KARAR] Brüt Kâr: ${grossProfitUsdc.toFixed(6)} USDC, ` +
    `Tahmini Fee: ${feeUsdc.toFixed(6)} USDC (${feeSol.toFixed(9)} SOL @ ${cfg.solUsdcRate}), ` +
    `Net Kâr: ${netProfitUsdc.toFixed(6)} USDC (min: ${effectiveMinProfit.toFixed(4)}, buffer: ${PROFIT_GATE_BUFFER}x) -> İşlem [${tag}]`
  );

  if (!approved) {
    const failReason = `Net kâr (${netProfitUsdc.toFixed(6)} USDC) minimum eşiğin (${effectiveMinProfit.toFixed(4)} USDC, ${PROFIT_GATE_BUFFER}x buffer) altında — işlem iptal edildi`;
    const tel = buildTelemetry({ build: partialResult, direction: params.direction, targetToken, success: false, failReason, status: "REJECTED_LOW_PROFIT", netProfit });
    appendTradeLog(tel);
    throw new NetProfitRejectedError(failReason, netProfit);
  }

  // ───── Onaylandı ─────
  // Live modda SIMULATION_SUCCESS telemetrisi YAZILMAZ — execution path kendi telemetrisini yazar.
  // Böylece phantom "Onay Bekliyor" kayıtları önlenir.
  const hasSimErrors = legs.some(l => l.simulation.error);
  if (params.dryRun) {
    const finalStatus: TelemetryStatus = hasSimErrors ? "DRY_RUN_PROFITABLE" : "SIMULATION_SUCCESS";
    const tel = buildTelemetry({ build: partialResult, direction: params.direction, targetToken, success: !hasSimErrors, status: finalStatus, netProfit,
      failReason: hasSimErrors ? legs.filter(l => l.simulation.error).map(l => `${l.venue}: ${l.simulation.error}`).join('; ') : undefined });
    appendTradeLog(tel);
  } else {
    console.log(`[TELEMETRY] Live mod — SIMULATION_SUCCESS yazılmadı (execution path telemetriyi yönetecek)`);
  }

  console.log(`[DEBUG] buildAndSimulate tamamlandı — ${legs.length} leg`);
  return partialResult;
}

function backoffForAttempt(attempt: number): number {
  const base = 300;
  return base * 2 ** (attempt - 1);
}

/**
 * Signed TX'ten base58 signature string'i çıkarır.
 * sendTransaction() başarısız olsa bile imzayı biliyoruz — zincirde kontrol edebiliriz.
 */
function extractSignatureFromTx(tx: VersionedTransaction): string | undefined {
  try {
    const sigBytes = tx.signatures[0];
    if (!sigBytes || sigBytes.every(b => b === 0)) return undefined;
    return bs58.encode(sigBytes);
  } catch { return undefined; }
}

/**
 * TX'in zincirde gerçekten confirm olup olmadığını kontrol eder.
 * RPC error dönse bile TX zincirde başarılı olmuş olabilir (timeout, ağ hatası).
 * Bu fonksiyon emergency unwind'den önce MUTLAKA çağrılmalıdır.
 */
async function verifyTxOnChain(
  signature: string,
  timeoutMs: number = 8_000
): Promise<{ confirmed: boolean; err?: string }> {
  try {
    const connection = getConnection();
    const t0 = Date.now();
    // Kısa bir bekleme — TX propagation süresi
    await new Promise(r => setTimeout(r, 2_000));

    while (Date.now() - t0 < timeoutMs) {
      const resp = await connection.getSignatureStatuses([signature]);
      const status = resp.value?.[0];
      if (status) {
        const level = status.confirmationStatus;
        if (level === "confirmed" || level === "finalized") {
          if (status.err) {
            return { confirmed: true, err: JSON.stringify(status.err) };
          }
          return { confirmed: true };
        }
        // "processed" — henüz confirm değil, biraz daha bekle
      }
      await new Promise(r => setTimeout(r, 1_500));
    }
    return { confirmed: false };
  } catch {
    return { confirmed: false };
  }
}

export async function sendWithRetry(
  tx: VersionedTransaction,
  signer: Keypair,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<SendResult> {
  const cfg = loadConfig();
  const connection = getConnection();
  const attempts: SendAttempt[] = [];

  for (let attempt = 1; attempt <= cfg.maxRetries; attempt += 1) {
    try {
      tx.sign([signer]);
      const signature = await sendVersionedWithOpts(connection, tx, {
        skipPreflight: false,
        preflightCommitment: commitment,
        maxRetries: cfg.maxRetries,
        minContextSlot: undefined
      });
      consecutiveFailedSends = 0;
      attempts.push({ signature, attempt, backoffMs: 0, timestamp: new Date().toISOString() });
      return { success: true, finalSignature: signature, attempts };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      consecutiveFailedSends += 1;

      // ── On-chain doğrulama: RPC error dönse bile TX zincirde olabilir ──
      const knownSig = extractSignatureFromTx(tx);
      if (knownSig) {
        console.log(
          `[SEND-VERIFY] RPC error sonrası TX zincirde kontrol ediliyor: ${knownSig.slice(0, 16)}…`
        );
        const check = await verifyTxOnChain(knownSig, 6_000);
        if (check.confirmed && !check.err) {
          console.log(
            `[SEND-VERIFY] ✓ TX zincirde BAŞARILI CONFIRM! sig=${knownSig.slice(0, 16)}… — RPC error yanlış alarm.`
          );
          consecutiveFailedSends = Math.max(0, consecutiveFailedSends - 1);
          attempts.push({ signature: knownSig, attempt, backoffMs: 0, timestamp: new Date().toISOString() });
          return { success: true, finalSignature: knownSig, attempts };
        }
        if (check.confirmed && check.err) {
          console.warn(
            `[SEND-VERIFY] TX zincirde confirm AMA on-chain hata: ${check.err}`
          );
          // TX on-chain error ile confirm oldu — artık retry etmenin anlamı yok
          break;
        }
        console.log(`[SEND-VERIFY] TX henüz zincirde bulunamadı — retry devam ediyor`);
      }

      const backoffMs = backoffForAttempt(attempt);
      attempts.push({
        signature: knownSig,
        error: errorMsg,
        attempt,
        backoffMs,
        timestamp: new Date().toISOString()
      });
      if (attempt === cfg.maxRetries) {
        // ── Son deneme sonrası bir kez daha on-chain kontrol ──
        if (knownSig) {
          console.log(`[SEND-VERIFY] Son retry de başarısız — son bir on-chain kontrol yapılıyor…`);
          const finalCheck = await verifyTxOnChain(knownSig, 10_000);
          if (finalCheck.confirmed && !finalCheck.err) {
            console.log(
              `[SEND-VERIFY] ✓ TX son kontrolde zincirde bulundu! sig=${knownSig.slice(0, 16)}…`
            );
            consecutiveFailedSends = Math.max(0, consecutiveFailedSends - 1);
            attempts.push({ signature: knownSig, attempt: attempt + 1, backoffMs: 0, timestamp: new Date().toISOString() });
            return { success: true, finalSignature: knownSig, attempts };
          }
        }
        const failReason = `Send failed after ${cfg.maxRetries} attempts`;
        if (consecutiveFailedSends >= cfg.circuitBreakerThreshold) {
          throw new SendError(`${failReason}; circuit breaker tripped`);
        }
        throw new SendError(failReason);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw new SendError("Unexpected send loop exit");
}

// ═══════════════════════════════════════════════════════════════════════
// ║  BUILD FRESH LEG 2 — Leg 1 onaylandıktan sonra taze TX oluşturur  ║
// ═══════════════════════════════════════════════════════════════════════

export interface BuildFreshLeg2Params {
  /** Original direction of the arb trade */
  direction: Direction;
  /** Token being traded */
  targetToken: TokenSymbol;
  /** Amount of target token received from Leg 1 (raw units) */
  leg1ReceivedAmount: bigint;
  /** Wallet public key */
  owner: PublicKey;
}

export interface FreshLeg2Result {
  tx: VersionedTransaction;
  meta: QuoteMeta;
  venue: "JUPITER" | "OKX";
}

/**
 * Jito bundle başarısız olduğunda Leg1 TX'inin blockhash'ini tazeler ve yeniden imzalar.
 * Bu, tam bir buildAndSimulate rebuild'den ÇOK DAHA HIZLI (~200ms vs ~3-5s).
 *
 * Jito prepareAtomicBundle TX'leri in-place değiştirir (blockhash + imza).
 * Sequential fallback için sadece taze blockhash + yeni imza yeterlidir —
 * TX instruction'ları aynı kalır, quote de aynı kalır.
 */
export async function refreshLeg1ForSequential(
  leg1Tx: VersionedTransaction,
  signer: Keypair,
): Promise<void> {
  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Blockhash'i değiştir — eski imzalar geçersiz olur
  leg1Tx.message.recentBlockhash = blockhash;
  for (let i = 0; i < leg1Tx.signatures.length; i++) {
    leg1Tx.signatures[i] = new Uint8Array(64);
  }

  // Yeniden imzala
  leg1Tx.sign([signer]);
  console.log(`[REFRESH-LEG1] Blockhash tazelendi: ${blockhash.slice(0, 16)}… — TX yeniden imzalandı`);
}

/**
 * Leg 1 on-chain confirm olduktan sonra Leg 2'yi tamamen yeniden oluşturur:
 *  - Taze quote (yeni fiyat)
 *  - Taze blockhash (expire etmez)
 *  - Leg 1'den gelen GERÇEK miktar kullanılır (tahmini değil)
 *
 * JUP_TO_OKX → Leg 2 = OKX (targetToken → USDC)
 * OKX_TO_JUP → Leg 2 = Jupiter (targetToken → USDC)
 */
export async function buildFreshLeg2(params: BuildFreshLeg2Params): Promise<FreshLeg2Result> {
  const cfg = loadConfig();
  const ownerStr = params.owner.toBase58();
  const usdcMint = cfg.tokens.USDC.mint;
  const targetMint = cfg.tokens[params.targetToken].mint;

  if (params.direction === "JUP_TO_OKX") {
    // Leg 2 = OKX targetToken → USDC
    // OKX 429 alınırsa Jupiter fallback ile Leg2 dene (unwind'i engelle!)
    try {
      console.log(
        `[FRESH-LEG2] OKX swap-instruction isteniyor (${params.targetToken}→USDC), ` +
        `amount=${params.leg1ReceivedAmount.toString()}…`
      );
      const t0 = Date.now();
      const { tx, meta } = await buildOkxSwap({
        inputMint: targetMint,
        outputMint: usdcMint,
        amount: params.leg1ReceivedAmount,
        slippageBps: cfg.slippageBps,
        userPublicKey: ownerStr,
      });
      console.log(`[FRESH-LEG2] OKX TX hazır (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);
      return { tx, meta, venue: "OKX" };
    } catch (okxErr) {
      const reason = okxErr instanceof Error ? okxErr.message : String(okxErr);
      const is429 = reason.includes("429") || reason.includes("Too Many Requests") || reason.includes("rate-limited");
      if (!is429) throw okxErr; // 429 değilse orijinal hatayı fırlat

      // ── OKX 429 FALLBACK: Jupiter ile Leg2 dene ──
      // Kâr azalabilir ama emergency unwind'den ÇOKHH daha iyi.
      console.warn(
        `[FRESH-LEG2] OKX 429 rate-limited! Jupiter fallback ile Leg2 deneniyor ` +
        `(${params.targetToken}→USDC)…`
      );
      const t0 = Date.now();

      // SOL ise bakiye kontrolü gerekli
      const isNativeSol = params.targetToken === "SOL";
      let swapAmount = params.leg1ReceivedAmount;
      let wrapAndUnwrapSol = !isNativeSol;

      if (isNativeSol) {
        const solInfo = await resolveSolBalance(
          params.owner,
          new PublicKey(targetMint),
          params.leg1ReceivedAmount
        );
        swapAmount = solInfo.swapAmount;
        wrapAndUnwrapSol = solInfo.wrapAndUnwrapSol;
      }

      const { route, meta } = await fetchJupiterQuote({
        inputMint: targetMint,
        outputMint: usdcMint,
        amount: swapAmount,
        slippageBps: cfg.slippageBps,
      });
      console.log(`[FRESH-LEG2] Jupiter fallback quote alındı (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);

      const tx = await buildJupiterSwap({
        route,
        userPublicKey: params.owner,
        wrapAndUnwrapSol,
      });
      console.log(`[FRESH-LEG2] ✓ Jupiter fallback TX hazır — OKX 429 atlatıldı`);
      return { tx, meta, venue: "JUPITER" };
    }
  } else {
    // Leg 2 = Jupiter targetToken → USDC
    const isNativeSol = params.targetToken === "SOL";
    let swapAmount = params.leg1ReceivedAmount;
    let wrapAndUnwrapSol = !isNativeSol;  // default: diğer tokenlar true, SOL false

    // SOL ise on-chain bakiyeyi kontrol et — OKX unwrap etmiş olabilir
    if (isNativeSol) {
      const solInfo = await resolveSolBalance(
        params.owner,
        new PublicKey(targetMint),
        params.leg1ReceivedAmount
      );
      swapAmount = solInfo.swapAmount;
      wrapAndUnwrapSol = solInfo.wrapAndUnwrapSol;
      console.log(
        `[FRESH-LEG2] SOL bakiye tespiti: useAta=${solInfo.useAta}, ` +
        `swapAmount=${swapAmount.toString()}, wrapAndUnwrapSol=${wrapAndUnwrapSol}`
      );
    }

    console.log(
      `[FRESH-LEG2] Jupiter TAZE quote isteniyor (${params.targetToken}→USDC), ` +
      `amount=${swapAmount.toString()}…`
    );
    const t0 = Date.now();
    const { route, meta } = await fetchJupiterQuote({
      inputMint: targetMint,
      outputMint: usdcMint,
      amount: swapAmount,
      slippageBps: cfg.slippageBps,
    });
    console.log(`[FRESH-LEG2] Jupiter quote alındı (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);

    const t1 = Date.now();
    const tx = await buildJupiterSwap({
      route,
      userPublicKey: params.owner,
      wrapAndUnwrapSol: wrapAndUnwrapSol,
    });
    console.log(`[FRESH-LEG2] Jupiter TX hazır (${Date.now() - t1}ms) wrapAndUnwrapSol=${wrapAndUnwrapSol}`);
    return { tx, meta, venue: "JUPITER" };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ║  EMERGENCY UNWIND — Leg 2 başarısız olduğunda sermayeyi kurtarır   ║
// ═══════════════════════════════════════════════════════════════════════

export interface EmergencyUnwindParams {
  /** Token stuck in wallet after Leg 1 succeeded but Leg 2 failed */
  targetToken: TokenSymbol;
  /** Approximate amount of stuck token (raw units). Uses on-chain balance if available. */
  stuckAmountRaw: bigint;
  /** Wallet keypair for signing */
  signer: Keypair;
  /** Original direction that failed */
  direction: Direction;
  /** Leg 1 signature for telemetry cross-reference */
  leg1Signature?: string;
  /** Gerçek trade miktarı (USDC) — loss hesabı için notionalCapUsd yerine kullanılır */
  actualTradeAmountUsdc?: number;
}

export interface EmergencyUnwindResult {
  success: boolean;
  /** TX signature if unwind succeeded */
  signature?: string;
  /** USDC recovered (raw units) */
  recoveredUsdcRaw?: bigint;
  /** Loss compared to original input (can be negative = worse) */
  lossUsdc?: number;
  /** Reason for failure */
  failReason?: string;
  /** Number of attempts made */
  attempts: number;
  /** True if we detected Leg 2 already succeeded (no unwind needed) */
  leg2AlreadySucceeded?: boolean;
}

/** Emergency unwind uses Jupiter (most liquid, most reliable) to dump token → USDC */
const UNWIND_MAX_RETRIES = 5;
/** Emergency slippage: 1% — accept small loss to recover capital */
const UNWIND_SLIPPAGE_BPS = 100;
/** Token balance'ın beklenenin %5'inden azsa Leg 2 muhtemelen başarılı olmuştur */
const LEG2_SUCCESS_THRESHOLD_PCT = 5;

/**
 * Leg 2'nin zincirde başarılı olup olmadığını kontrol eder.
 * Token balance beklenenin çok altındaysa (<%5), Leg 2 muhtemelen çoktan çalışmıştır.
 * Bu durumda USDC bakiyesini kontrol ederek doğrulama yapar.
 */
async function checkLeg2AlreadySucceeded(
  owner: PublicKey,
  targetToken: TokenSymbol,
  expectedTokenRaw: bigint,
  preTradeUsdcRaw?: bigint,
): Promise<{ likely: boolean; currentTokenBalance: bigint; currentUsdcRaw: bigint }> {
  const cfg = loadConfig();
  const connection = getConnection();
  const targetMint = cfg.tokens[targetToken].mint;
  const usdcMint = new PublicKey(cfg.tokens.USDC.mint);
  const usdcAta = deriveATA(owner, usdcMint);
  const isNativeSol = targetToken === "SOL";

  let tokenBalance = BigInt(0);
  if (isNativeSol) {
    // SOL: ATA + native kontrol
    const wsolMint = new PublicKey(targetMint);
    const solInfo = await resolveSolBalance(owner, wsolMint, expectedTokenRaw);
    tokenBalance = solInfo.swapAmount;
  } else {
    // SPL token ATA bakiyesi
    const ata = deriveATA(owner, new PublicKey(targetMint));
    const info = await connection.getTokenAccountBalance(ata).catch(() => null);
    tokenBalance = info ? BigInt(info.value.amount) : BigInt(0);
  }

  // USDC bakiyesini oku
  const usdcInfo = await connection.getTokenAccountBalance(usdcAta).catch(() => null);
  const currentUsdcRaw = usdcInfo ? BigInt(usdcInfo.value.amount) : BigInt(0);

  // Token balance beklenenin %5'inden az mı?
  const threshold = (expectedTokenRaw * BigInt(LEG2_SUCCESS_THRESHOLD_PCT)) / BigInt(100);
  const tokenAlmostGone = tokenBalance < threshold;

  // USDC artış kontrolü (eğer pre-trade USDC bilgisi varsa)
  let usdcIncreased = false;
  if (preTradeUsdcRaw !== undefined) {
    // Leg 2 ~500 USDC geri getirmeli, minimum %80'ini aramak
    const usdcDelta = currentUsdcRaw - preTradeUsdcRaw;
    const usdcDecimals = cfg.tokens.USDC.decimals;
    const expectedUsdcReturn = BigInt(Math.round(200 * 10 ** usdcDecimals)); // minimum 200 USDC dönüşü bekle
    usdcIncreased = usdcDelta > expectedUsdcReturn;
  }

  const likely = tokenAlmostGone && (usdcIncreased || preTradeUsdcRaw === undefined);

  console.log(
    `[LEG2-CHECK] Token balance: ${tokenBalance.toString()} / expected: ${expectedTokenRaw.toString()} ` +
    `(${((Number(tokenBalance) / Number(expectedTokenRaw)) * 100).toFixed(1)}%) | ` +
    `USDC: ${currentUsdcRaw.toString()} | ` +
    `Leg2 zaten başarılı mı? ${likely ? "EVET ✓" : "HAYIR — unwind gerekli"}`
  );

  return { likely, currentTokenBalance: tokenBalance, currentUsdcRaw };
}

/**
 * Acil sermaye kurtarma: Leg 2 başarısız olduğunda cüzdandaki
 * takılı token'ı Jupiter üzerinden USDC'ye çevirir.
 *
 * ÖNCELİKLİ KONTROL: Token bakiyesi beklenenin %5'inden azsa ve
 * USDC bakiyesi artmışsa → Leg 2 zaten başarılı olmuştur, unwind ATLANIR.
 *
 * - Jupiter kullanır (en likit, en güvenilir)
 * - Daha yüksek slippage (1%) kabul eder — amaç sermaye kurtarma, kâr değil
 * - 5 retry, agresif backoff
 * - Telemetri kaydı yapılır (EMERGENCY_UNWIND_SUCCESS/FAILED)
 * - Circuit breaker'ı resetler (başarılı ise)
 */
export async function emergencyUnwind(params: EmergencyUnwindParams): Promise<EmergencyUnwindResult> {
  const cfg = loadConfig();
  const connection = getConnection();
  const ownerStr = params.signer.publicKey.toBase58();
  const usdcMint = cfg.tokens.USDC.mint;
  const targetMint = cfg.tokens[params.targetToken].mint;
  const usdcDecimals = cfg.tokens.USDC.decimals;
  const pair = pairFromToken(params.targetToken);

  console.warn(
    `\n[EMERGENCY-UNWIND] ★★★ BAŞLATILIYOR ★★★\n` +
    `  Token: ${params.targetToken}\n` +
    `  Stuck Amount: ${params.stuckAmountRaw.toString()} raw\n` +
    `  Yön: ${params.direction}\n` +
    `  Leg1 Sig: ${params.leg1Signature ?? "n/a"}\n` +
    `  Max Retry: ${UNWIND_MAX_RETRIES}, Slippage: ${UNWIND_SLIPPAGE_BPS} BPS (${UNWIND_SLIPPAGE_BPS / 100}%)\n`
  );

  // ── PRE-CHECK: Leg 2 zaten başarılı mı? ──
  // RPC error dönse bile TX zincirde çalışmış olabilir.
  // Token bakiyesi neredeyse 0 ise → Leg 2 muhtemelen başarı ile tamamlanmıştır.
  console.log(`[EMERGENCY-UNWIND] On-chain pre-check: Leg 2 zaten çalışmış olabilir mi?`);
  // Kısa bir bekleme — Leg 2 TX'inin zincire yerleşmesi için
  await new Promise(r => setTimeout(r, 3_000));
  const leg2Check = await checkLeg2AlreadySucceeded(
    params.signer.publicKey,
    params.targetToken,
    params.stuckAmountRaw,
  );

  if (leg2Check.likely) {
    console.warn(
      `[EMERGENCY-UNWIND] ★ Leg 2 ZATEN BAŞARILI OLMUŞ! Token balance neredeyse 0 ` +
      `(${leg2Check.currentTokenBalance.toString()}). ` +
      `USDC bakiye: ${leg2Check.currentUsdcRaw.toString()} raw. ` +
      `Emergency unwind GEREKSİZ — atlanıyor.`
    );

    // Circuit breaker reset — aslında her şey OK
    resetCircuitBreaker();

    const tel = buildTelemetry({
      direction: params.direction,
      targetToken: params.targetToken,
      sendSignatures: [params.leg1Signature ?? ""],
      success: true,
      status: "EMERGENCY_UNWIND_SUCCESS",
      failReason: "Leg 2 already succeeded on-chain — unwind skipped (false alarm)",
      netProfit: { grossProfitUsdc: 0, feeUsdc: 0, netProfitUsdc: 0 },
    });
    appendTradeLog(tel);

    return {
      success: true,
      failReason: "Leg 2 already succeeded — no unwind needed",
      attempts: 0,
      leg2AlreadySucceeded: true,
    };
  }

  // SOL ise on-chain bakiyeyi kontrol et — OKX unwrap etmiş olabilir
  const isNativeSol = params.targetToken === "SOL";
  let unwindAmount = params.stuckAmountRaw;
  let wrapAndUnwrapSol = !isNativeSol;  // default: diğer tokenlar true, SOL false

  if (isNativeSol) {
    const solInfo = await resolveSolBalance(
      params.signer.publicKey,
      new PublicKey(targetMint),
      params.stuckAmountRaw
    );
    unwindAmount = solInfo.swapAmount;
    wrapAndUnwrapSol = solInfo.wrapAndUnwrapSol;
    console.log(
      `[EMERGENCY-UNWIND] SOL bakiye tespiti: useAta=${solInfo.useAta}, ` +
      `ataBalance=${solInfo.wsolAtaBalance.toString()}, ` +
      `nativeUsable=${solInfo.usableNativeLamports.toString()}, ` +
      `swapAmount=${unwindAmount.toString()}, wrapAndUnwrapSol=${wrapAndUnwrapSol}`
    );

    // ── UYARI: Çok düşük swap miktarı kontrolü ──
    // Swap amount beklenenin %10'undan azsa, büyük ihtimalle Leg 2 çalışmış
    // ama checkLeg2AlreadySucceeded tespit edememiştir. SOL'un native vs wSOL
    // farklı yerlerde olması karışıklığa neden olabilir.
    const lowThreshold = (params.stuckAmountRaw * BigInt(10)) / BigInt(100);
    if (unwindAmount > BigInt(0) && unwindAmount < lowThreshold) {
      console.warn(
        `[EMERGENCY-UNWIND] ⚠ SWAP AMOUNT ÇOK DÜŞÜK: ` +
        `${unwindAmount.toString()} / beklenen ${params.stuckAmountRaw.toString()} ` +
        `(${((Number(unwindAmount) / Number(params.stuckAmountRaw)) * 100).toFixed(1)}%). ` +
        `Leg 2 zaten başarılı olmuş olabilir — yine de tüm SOL'u kurtarmaya çalışıyoruz.`
      );

      // Tüm native SOL'u kullan — rent reserve'den sonra ne varsa
      const solBalance = await getConnection().getBalance(params.signer.publicKey);
      const totalUsable = BigInt(solBalance) - BigInt(10_000_000); // rent reserve
      if (totalUsable > unwindAmount) {
        console.log(
          `[EMERGENCY-UNWIND] Native SOL balance güncellendi: ` +
          `${unwindAmount.toString()} → ${totalUsable.toString()}`
        );
        unwindAmount = totalUsable;
        wrapAndUnwrapSol = true;
      }
    }
  } else {
    // SPL token: ATA'dan balance oku
    const ata = deriveATA(params.signer.publicKey, new PublicKey(targetMint));
    const ataInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
    if (ataInfo) {
      const ataBalance = BigInt(ataInfo.value.amount);
      if (ataBalance > BigInt(0) && ataBalance !== unwindAmount) {
        console.log(
          `[EMERGENCY-UNWIND] SPL token ATA bakiyesi güncellendi: ` +
          `${unwindAmount.toString()} → ${ataBalance.toString()}`
        );
        unwindAmount = ataBalance;
      }
    }
  }

  if (unwindAmount <= BigInt(0)) {
    const failReason = `No ${params.targetToken} balance found to unwind — Leg 2 might have already succeeded`;
    console.error(`[EMERGENCY-UNWIND] ${failReason}`);

    // Leg 2 başarılı olmuş olabilir — circuit breaker'ı sıfırla
    resetCircuitBreaker();

    const tel = buildTelemetry({
      direction: params.direction,
      targetToken: params.targetToken,
      sendSignatures: [params.leg1Signature ?? ""],
      success: false,
      status: "EMERGENCY_UNWIND_FAILED",
      failReason,
      netProfit: { grossProfitUsdc: 0, feeUsdc: 0, netProfitUsdc: 0 },
    });
    appendTradeLog(tel);
    return { success: false, failReason, attempts: 0 };
  }

  // Gerçek trade miktarı — loss hesabı için
  const actualTradeUsdc = params.actualTradeAmountUsdc ?? cfg.notionalCapUsd;
  const originalInputRaw = toRaw(actualTradeUsdc, usdcDecimals);

  for (let attempt = 1; attempt <= UNWIND_MAX_RETRIES; attempt++) {
    try {
      // 1. Taze Jupiter quote: targetToken → USDC
      console.log(`[EMERGENCY-UNWIND] Attempt ${attempt}/${UNWIND_MAX_RETRIES} — Jupiter quote isteniyor (amount=${unwindAmount.toString()})…`);
      const t0 = Date.now();
      const { route, meta } = await fetchJupiterQuote({
        inputMint: targetMint,
        outputMint: usdcMint,
        amount: unwindAmount,
        slippageBps: UNWIND_SLIPPAGE_BPS,
      });
      console.log(
        `[EMERGENCY-UNWIND] Quote alındı (${Date.now() - t0}ms) — ` +
        `expectedOut=${meta.expectedOut.toString()} raw USDC`
      );

      // 2. TX oluştur (taze blockhash)
      const tx = await buildJupiterSwap({
        route,
        userPublicKey: params.signer.publicKey,
        wrapAndUnwrapSol: wrapAndUnwrapSol,
      });
      console.log(
        `[EMERGENCY-UNWIND] wrapAndUnwrapSol=${wrapAndUnwrapSol} — ` +
        (wrapAndUnwrapSol ? 'native SOL wrap edilecek' : 'mevcut wSOL ATA kullanılacak')
      );

      // 3. Sign & send
      tx.sign([params.signer]);
      const signature = await sendVersionedWithOpts(connection, tx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });

      console.log(
        `[EMERGENCY-UNWIND] ✓ BAŞARILI — sig=${signature}, ` +
        `recovered≈${meta.expectedOut.toString()} raw USDC`
      );

      // Loss hesapla (gerçek trade miktarından kaybı hesapla)
      const lossRaw = originalInputRaw - meta.expectedOut;
      const lossUsdc = Number(lossRaw) / 10 ** usdcDecimals;

      // Telemetri: başarılı unwind
      const tel = buildTelemetry({
        direction: params.direction,
        targetToken: params.targetToken,
        sendSignatures: [params.leg1Signature ?? "", signature],
        success: true,
        status: "EMERGENCY_UNWIND_SUCCESS",
        failReason: `Unwind after Leg2 failure. Trade: ${actualTradeUsdc} USDC, Recovered: ${(Number(meta.expectedOut) / 10 ** usdcDecimals).toFixed(4)} USDC, Loss: ${lossUsdc.toFixed(4)} USDC`,
        netProfit: { grossProfitUsdc: -lossUsdc, feeUsdc: 0, netProfitUsdc: -lossUsdc },
      });
      appendTradeLog(tel);

      // Circuit breaker reset — bot tekrar trade yapabilir
      resetCircuitBreaker();

      return {
        success: true,
        signature,
        recoveredUsdcRaw: meta.expectedOut,
        lossUsdc,
        attempts: attempt,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[EMERGENCY-UNWIND] Attempt ${attempt}/${UNWIND_MAX_RETRIES} BAŞARISIZ: ${reason}`
      );

      if (attempt < UNWIND_MAX_RETRIES) {
        // Agresif backoff: 500ms, 1s, 2s, 4s
        const backoffMs = 500 * 2 ** (attempt - 1);
        console.log(`[EMERGENCY-UNWIND] ${backoffMs}ms backoff bekleniyor…`);
        await new Promise((r) => setTimeout(r, backoffMs));

        // Her retry arasında bakiye tekrar kontrol et
        // Leg 2 sonradan confirm olmuş olabilir
        if (isNativeSol) {
          const recheck = await checkLeg2AlreadySucceeded(
            params.signer.publicKey,
            params.targetToken,
            params.stuckAmountRaw,
          );
          if (recheck.likely) {
            console.warn(
              `[EMERGENCY-UNWIND] ★ Retry ${attempt} sonrası Leg 2 artık ON-CHAIN! ` +
              `Token balance: ${recheck.currentTokenBalance.toString()}. Unwind durduruluyor.`
            );
            resetCircuitBreaker();
            return {
              success: true,
              failReason: "Leg 2 confirmed during unwind retry — no unwind needed",
              attempts: attempt,
              leg2AlreadySucceeded: true,
            };
          }
        }
      }
    }
  }

  // Tüm retry'lar başarısız
  const failReason = `Emergency unwind FAILED after ${UNWIND_MAX_RETRIES} attempts — MANUAL INTERVENTION REQUIRED`;
  console.error(`\n[EMERGENCY-UNWIND] ★★★ ${failReason} ★★★\n`);

  // Telemetri: başarısız unwind
  const tel = buildTelemetry({
    direction: params.direction,
    targetToken: params.targetToken,
    sendSignatures: [params.leg1Signature ?? ""],
    success: false,
    status: "EMERGENCY_UNWIND_FAILED",
    failReason,
    netProfit: { grossProfitUsdc: 0, feeUsdc: 0, netProfitUsdc: 0 },
  });
  appendTradeLog(tel);

  return {
    success: false,
    failReason,
    attempts: UNWIND_MAX_RETRIES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ║  JITO ATOMIC ARBITRAGE — Her iki bacağı tek bundle'da gönderir      ║
// ║  Leg1 + Leg2 + Tip TX → aynı blokta atomik olarak çalışır          ║
// ═══════════════════════════════════════════════════════════════════════

export interface AtomicArbitrageParams {
  /** buildAndSimulate sonucu — her iki bacağın TX'leri */
  buildResult: BuildSimulateResult;
  /** Cüzdan keypair */
  signer: Keypair;
  /** İşlem yapılan target token */
  targetToken: TokenSymbol;
}

export interface AtomicArbitrageResult {
  /** Bundle başarılı şekilde land etti mi */
  success: boolean;
  /** Jito bundle UUID */
  bundleId?: string;
  /** TX imzaları (Leg1, Leg2, Tip) */
  signatures: string[];
  /** Bundle'ın land ettiği slot */
  landedSlot?: number;
  /** Hata nedeni */
  failReason?: string;
  /** Toplam deneme sayısı */
  attempts: number;
  /** Bundle hazırlama verisi */
  bundleData?: AtomicBundleData;
  /**
   * Bundle land etmedi/hata verdi ama Leg1 on-chain ise true.
   * priceTicker bu durumda emergency unwind tetikler.
   */
  leg1OnChainButLeg2Failed?: boolean;
  /** Leg1 on-chain signature (emergency unwind referansı) */
  leg1Signature?: string;
}

/** Jito bundle max retry sayısı */
const MAX_BUNDLE_ATTEMPTS = 3;

/**
 * Atomik 2-leg arbitraj: Jito bundle ile her iki bacağı tek blokta çalıştırır.
 *
 * Akış:
 * 1. buildAndSimulate sonucundan Leg1 + Leg2 TX'lerini al
 * 2. Ortak blockhash + tip TX ile bundle hazırla
 * 3. Bundle'ı Jito Block Engine'e gönder
 * 4. Landing durumunu takip et
 * 5. Başarısızlıkta: on-chain doğrulama yap
 *    - Hiçbiri land etmediyse → temiz başarısızlık (kayıp yok)
 *    - Sadece Leg1 land ettiyse → emergency unwind gerekli
 *    - İkisi de land ettiyse → başarı (Jito status gecikmeli)
 *
 * ⚠️ NOT: Bu fonksiyon buildResult'taki TX'leri IN-PLACE değiştirir.
 */
export async function executeAtomicArbitrage(
  params: AtomicArbitrageParams
): Promise<AtomicArbitrageResult> {
  const cfg = loadConfig();
  const { buildResult, signer, targetToken } = params;
  const pair = pairFromToken(targetToken);

  console.log(
    `\n[JITO-ATOMIC] ═══════════════════════════════════════════\n` +
      `  Pair: ${pair} | Direction: ${buildResult.direction}\n` +
      `  Net Profit (estimate): ${buildResult.netProfit.netProfitUsdc.toFixed(6)} USDC\n` +
      `  Tip: ${cfg.jitoTipLamports} lamports\n` +
      `═══════════════════════════════════════════════════════\n`
  );

  // ── 1. Bundle hazırla ──
  const leg1Tx = buildResult.legs[0].tx;
  const leg2Tx = buildResult.legs[1].tx;

  let bundleData: AtomicBundleData;
  try {
    bundleData = await prepareAtomicBundle({
      leg1Tx,
      leg2Tx,
      signer,
      tipLamports: cfg.jitoTipLamports,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[JITO-ATOMIC] Bundle hazırlama hatası: ${reason}`);
    return {
      success: false,
      signatures: [],
      failReason: `Bundle prepare failed: ${reason}`,
      attempts: 0,
    };
  }

  // ── 2. Bundle'ı gönder (retry mekanizmalı) ──
  for (let attempt = 1; attempt <= MAX_BUNDLE_ATTEMPTS; attempt++) {
    try {
      const bundleId = await sendJitoBundle(bundleData.signedTxs);

      // ── 3. Landing bekle ──
      const landing = await waitForBundleLanding(bundleId, 30_000);

      if (landing.success) {
        // ✓ Bundle land etti — tüm TX'ler aynı blokta başarılı
        console.log(
          `[JITO-ATOMIC] ✓ BAŞARILI! Bundle=${bundleId.slice(0, 16)}… ` +
            `slot=${landing.landedSlot}`
        );
        consecutiveFailedSends = 0;
        return {
          success: true,
          bundleId,
          signatures: landing.signatures.length > 0
            ? landing.signatures
            : bundleData.txSignatures,
          landedSlot: landing.landedSlot,
          attempts: attempt,
          bundleData,
        };
      }

      // ── Bundle land etmedi — sebebi kontrol et ──
      if (landing.status === "Invalid") {
        // Format hatası — retry anlamsız
        return {
          success: false,
          bundleId,
          signatures: bundleData.txSignatures,
          failReason: landing.failReason ?? "Invalid bundle format",
          attempts: attempt,
          bundleData,
        };
      }

      if (landing.status === "Failed") {
        // Simülasyon hatası — TX'ler zincire gönderilmedi
        // On-chain kontrol yap (güvenlik)
        console.log(
          `[JITO-ATOMIC] Bundle Failed — on-chain doğrulama yapılıyor…`
        );
        const verify = await checkBundleTxResults(
          bundleData.txSignatures[0],
          bundleData.txSignatures[1]
        );

        if (verify.outcome === "bothSucceeded") {
          // Jito status gecikmeli olabilir
          console.log(
            `[JITO-ATOMIC] ★ Jito Failed dedi AMA her iki TX de on-chain!`
          );
          consecutiveFailedSends = 0;
          return {
            success: true,
            bundleId,
            signatures: bundleData.txSignatures,
            attempts: attempt,
            bundleData,
          };
        }

        if (verify.outcome === "leg1Only") {
          // Leg1 on-chain, Leg2 yok → priceTicker emergency unwind tetikler
          return {
            success: false,
            bundleId,
            signatures: bundleData.txSignatures,
            failReason:
              "Bundle failed: Leg1 on-chain but Leg2 missing — unwind needed",
            attempts: attempt,
            bundleData,
            leg1OnChainButLeg2Failed: true,
            leg1Signature: bundleData.txSignatures[0],
          };
        }

        // Hiçbiri on-chain değil — temiz başarısızlık
        if (attempt < MAX_BUNDLE_ATTEMPTS) {
          console.log(
            `[JITO-ATOMIC] Attempt ${attempt} failed — retry…`
          );
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        return {
          success: false,
          bundleId,
          signatures: bundleData.txSignatures,
          failReason: landing.failReason ?? "Bundle simulation failed",
          attempts: attempt,
          bundleData,
        };
      }

      // Timeout — TX'ler hâlâ pending olabilir
      if (landing.status === "Timeout") {
        console.log(
          `[JITO-ATOMIC] Bundle Timeout — on-chain doğrulama yapılıyor…`
        );
        const verify = await checkBundleTxResults(
          bundleData.txSignatures[0],
          bundleData.txSignatures[1]
        );

        if (verify.outcome === "bothSucceeded") {
          consecutiveFailedSends = 0;
          return {
            success: true,
            bundleId,
            signatures: bundleData.txSignatures,
            attempts: attempt,
            bundleData,
          };
        }

        if (verify.outcome === "leg1Only") {
          return {
            success: false,
            bundleId,
            signatures: bundleData.txSignatures,
            failReason:
              "Bundle timeout: Leg1 on-chain but Leg2 missing — unwind needed",
            attempts: attempt,
            bundleData,
            leg1OnChainButLeg2Failed: true,
            leg1Signature: bundleData.txSignatures[0],
          };
        }

        // Hiçbiri on-chain — retry veya başarısızlık
        if (attempt < MAX_BUNDLE_ATTEMPTS) {
          console.log(
            `[JITO-ATOMIC] Timeout, TX'ler on-chain değil — retry…`
          );
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        return {
          success: false,
          bundleId,
          signatures: bundleData.txSignatures,
          failReason: landing.failReason ?? "Bundle landing timeout",
          attempts: attempt,
          bundleData,
        };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[JITO-ATOMIC] Attempt ${attempt} error: ${reason}`
      );

      if (err instanceof JitoBundleError && attempt < MAX_BUNDLE_ATTEMPTS) {
        console.log(`[JITO-ATOMIC] Retry after Jito error…`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      return {
        success: false,
        signatures: bundleData.txSignatures,
        failReason: `Jito bundle error: ${reason}`,
        attempts: attempt,
        bundleData,
      };
    }
  }

  return {
    success: false,
    signatures: bundleData?.txSignatures ?? [],
    failReason: `Bundle failed after ${MAX_BUNDLE_ATTEMPTS} attempts`,
    attempts: MAX_BUNDLE_ATTEMPTS,
    bundleData,
  };
}
