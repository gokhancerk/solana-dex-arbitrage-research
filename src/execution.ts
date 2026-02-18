import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getConnection, sendVersionedWithOpts, resolveSolBalance } from "./solana.js";
import { loadConfig, type TokenSymbol, type TradePair } from "./config.js";
import { toRaw } from "./tokens.js";
import { suggestPriorityFee } from "./fees.js";
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
import { fetchOkxQuote, buildOkxSwap, simulateOkxTx } from "./okxDex.js";
import { buildTelemetry, appendTradeLog } from "./telemetry.js";

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

  if (params.direction === "JUP_TO_OKX") {
    // ── Leg 1: Jupiter USDC → targetToken (█ HER ZAMAN TAZE QUOTE █) ──
    // Stale quote → stale otherAmountThreshold → Custom:1 sim hatasını önler
    console.log(`[FRESH] Leg 1/2 — Jupiter TAZE quote isteniyor (USDC→${targetToken})...`);
    const t0 = Date.now();
    const { route, meta } = await fetchJupiterQuote({
      inputMint: usdcMint,
      outputMint: targetMint,
      amount: amountRaw,
      slippageBps: cfg.slippageBps
    });
    console.log(`[FRESH] Jupiter quote alındı (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);
    quoteMeta.push(meta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t1 = Date.now();
    const jupTx = await buildJupiterSwap({ route, userPublicKey: params.owner, priorityFeeMicroLamports: dynFee });
    console.log(`[DEBUG] Jupiter swap TX hazır (${Date.now() - t1}ms)`);

    const jupLeg: SimulatedLeg = {
      venue: "JUPITER",
      tx: jupTx,
      outMint: targetMint,
      owner: ownerStr,
      expectedOut: meta.expectedOut,
      simulatedOut: meta.expectedOut,
      simulation: { logs: [] }
    };

    console.log("[DEBUG] Jupiter TX simüle ediliyor...");
    const t2 = Date.now();
    legs.push(await simulateLegSafe(jupLeg, "JUPITER", params.dryRun ?? false));
    console.log(`[DEBUG] Jupiter simülasyon tamamlandı (${Date.now() - t2}ms)`);

    // ── Leg 2: OKX targetToken → USDC (swap-instruction'dan meta alır — ayrı quote gereksiz) ──
    console.log(`[DEBUG] Leg 2/2 — OKX swap-instruction isteniyor (${targetToken}→USDC)...`);
    const t4 = Date.now();
    const { tx: okxTx, meta: okxMeta } = await buildOkxSwap({
      inputMint: targetMint,
      outputMint: usdcMint,
      amount: meta.expectedOut,
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

    // Leg 2 simülasyonu ATLANIR: Cüzdan henüz Leg 1'i göndermediği için
    // targetToken bakiyesi yok → simülasyon her zaman Custom:1 fırlatır.
    // On-chain slippage koruması (otherAmountThreshold) zaten aktif.
    console.log(`[SKIP-SIM] Leg 2/2 (${okxLeg.venue}) simülasyon atlandı — Leg 1 henüz zincirde değil, quote'a güveniliyor`);
    legs.push(okxLeg);
  } else {
    // ── Leg 1: OKX USDC → targetToken (swap-instruction'dan meta alır) ──
    // Cache'deki OKX miktarını kullanarak swap-instruction çağrırız.
    // swap-instruction response'u zaten taze routing + meta içerir.
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

    console.log("[DEBUG] OKX TX simüle ediliyor...");
    const t2 = Date.now();
    legs.push(await simulateLegSafe(okxLeg, "OKX", params.dryRun ?? false));
    console.log(`[DEBUG] OKX simülasyon tamamlandı (${Date.now() - t2}ms)`);

    // ── Leg 2: Jupiter targetToken → USDC (█ HER ZAMAN TAZE QUOTE █) ──
    // Stale quote → stale otherAmountThreshold → Custom:1 sim hatasını önler
    console.log(`[FRESH] Leg 2/2 — Jupiter TAZE quote isteniyor (${targetToken}→USDC)...`);
    const t3 = Date.now();
    const { route, meta: jupMeta } = await fetchJupiterQuote({
      inputMint: targetMint,
      outputMint: usdcMint,
      amount: meta.expectedOut,
      slippageBps: cfg.slippageBps
    });
    console.log(`[FRESH] Jupiter quote alındı (${Date.now() - t3}ms) — expectedOut=${jupMeta.expectedOut.toString()}`);
    quoteMeta.push(jupMeta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t4 = Date.now();
    const jupTx = await buildJupiterSwap({ route, userPublicKey: params.owner, priorityFeeMicroLamports: dynFee });
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

    // Leg 2 simülasyonu ATLANIR: Cüzdan henüz Leg 1'i göndermediği için
    // targetToken bakiyesi yok → simülasyon her zaman Custom:1 fırlatır.
    // On-chain slippage koruması (otherAmountThreshold) zaten aktif.
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
  const approved = netProfitUsdc >= cfg.minNetProfitUsdc;
  const tag = approved ? "ONAYLANDI" : "REDDEDİLDİ";
  console.log(
    `[KARAR] Brüt Kâr: ${grossProfitUsdc.toFixed(6)} USDC, ` +
    `Tahmini Fee: ${feeUsdc.toFixed(6)} USDC (${feeSol.toFixed(9)} SOL @ ${cfg.solUsdcRate}), ` +
    `Net Kâr: ${netProfitUsdc.toFixed(6)} USDC -> İşlem [${tag}]`
  );

  if (!approved) {
    const failReason = `Net kâr (${netProfitUsdc.toFixed(6)} USDC) minimum eşiğin (${cfg.minNetProfitUsdc} USDC) altında — işlem iptal edildi`;
    const tel = buildTelemetry({ build: partialResult, direction: params.direction, targetToken, success: false, failReason, status: "REJECTED_LOW_PROFIT", netProfit });
    appendTradeLog(tel);
    throw new NetProfitRejectedError(failReason, netProfit);
  }

  // ───── Onaylandı → telemetri kaydet & return ─────
  const hasSimErrors = legs.some(l => l.simulation.error);
  const finalStatus: TelemetryStatus = (hasSimErrors && params.dryRun) ? "DRY_RUN_PROFITABLE" : "SIMULATION_SUCCESS";
  const tel = buildTelemetry({ build: partialResult, direction: params.direction, targetToken, success: !hasSimErrors, status: finalStatus, netProfit,
    failReason: hasSimErrors ? legs.filter(l => l.simulation.error).map(l => `${l.venue}: ${l.simulation.error}`).join('; ') : undefined });
  appendTradeLog(tel);

  console.log(`[DEBUG] buildAndSimulate tamamlandı — ${legs.length} leg`);
  return partialResult;
}

function backoffForAttempt(attempt: number): number {
  const base = 300;
  return base * 2 ** (attempt - 1);
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
      consecutiveFailedSends += 1;
      const backoffMs = backoffForAttempt(attempt);
      attempts.push({
        signature: undefined,
        error: err instanceof Error ? err.message : String(err),
        attempt,
        backoffMs,
        timestamp: new Date().toISOString()
      });
      if (attempt === cfg.maxRetries) {
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
}

/** Emergency unwind uses Jupiter (most liquid, most reliable) to dump token → USDC */
const UNWIND_MAX_RETRIES = 5;
/** Emergency slippage: 1% — accept small loss to recover capital */
const UNWIND_SLIPPAGE_BPS = 100;

/**
 * Acil sermaye kurtarma: Leg 2 başarısız olduğunda cüzdandaki
 * takılı token'ı Jupiter üzerinden USDC'ye çevirir.
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
  }

  if (unwindAmount <= BigInt(0)) {
    const failReason = `No SOL balance found (ATA or native) to unwind`;
    console.error(`[EMERGENCY-UNWIND] ${failReason}`);
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

      // Loss hesapla (orijinal 500 USDC'den ne kadar kayıp)
      const originalInputRaw = toRaw(cfg.notionalCapUsd, usdcDecimals);
      const lossRaw = originalInputRaw - meta.expectedOut;
      const lossUsdc = Number(lossRaw) / 10 ** usdcDecimals;

      // Telemetri: başarılı unwind
      const tel = buildTelemetry({
        direction: params.direction,
        targetToken: params.targetToken,
        sendSignatures: [params.leg1Signature ?? "", signature],
        success: true,
        status: "EMERGENCY_UNWIND_SUCCESS",
        failReason: `Unwind after Leg2 failure. Loss: ${lossUsdc.toFixed(4)} USDC`,
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
