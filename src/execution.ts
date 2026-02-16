import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getConnection, sendVersionedWithOpts } from "./solana.js";
import { loadConfig } from "./config.js";
import { toRaw } from "./tokens.js";
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
  NetProfitInfo
} from "./types.js";
import { fetchJupiterQuote, buildJupiterSwap, computeSlippageBps, simulateJupiterTx } from "./jupiter.js";
import { fetchOkxQuote, buildOkxSwap, simulateOkxTx } from "./okxDex.js";
import { buildTelemetry, appendTradeLog } from "./telemetry.js";

let consecutiveFailedSends = 0;

// ───── Net Profit Helpers ─────

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

interface BuildParams {
  direction: Direction;
  notionalUsd: number; // USDC notionals
  owner: PublicKey;
  /** When true, simulation errors are logged as warnings instead of throwing */
  dryRun?: boolean;
}

function enforceNotional(notional: number, cap: number) {
  if (notional > cap) {
    throw new LimitBreachError(`Notional ${notional} exceeds cap ${cap}`);
  }
  if (notional <= 0) {
    throw new LimitBreachError("Notional must be positive");
  }
}

function extractSimulatedOut(sim: SimulatedLeg["simulation"], mint?: string, owner?: string): bigint | undefined {
  if (!mint || !owner) return undefined;
  const balance = sim.postTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
  if (!balance) return undefined;
  if (balance.rawAmount) return BigInt(balance.rawAmount);
  if (balance.uiAmount && typeof balance.decimals === "number") {
    return BigInt(Math.round(Number(balance.uiAmount) * 10 ** balance.decimals));
  }
  return undefined;
}

async function simulateLeg(leg: SimulatedLeg, venue: "JUPITER" | "OKX") {
  const connection = getConnection();
  const sim = await (venue === "JUPITER" ? simulateJupiterTx(connection, leg.tx) : simulateOkxTx(connection, leg.tx));
  const simulatedOut = extractSimulatedOut(sim, leg.outMint, leg.owner) ?? leg.simulatedOut;
  const effectiveSlippageBps = computeSlippageBps(leg.expectedOut, simulatedOut);
  return { ...leg, simulation: sim, simulatedOut, effectiveSlippageBps };
}

export async function buildAndSimulate(params: BuildParams): Promise<BuildSimulateResult> {
  const cfg = loadConfig();
  console.log(`[DEBUG] buildAndSimulate başladı — direction=${params.direction}, notional=${params.notionalUsd}`);
  enforceNotional(params.notionalUsd, cfg.notionalCapUsd);

  const usdcDecimals = cfg.tokens.USDC.decimals;
  const usdcMint = cfg.tokens.USDC.mint;
  const solMint = cfg.tokens.SOL.mint;

  const amountRaw = toRaw(params.notionalUsd, usdcDecimals);
  const ownerStr = params.owner.toBase58();
  console.log(`[DEBUG] amountRaw=${amountRaw.toString()}, owner=${ownerStr}`);

  const legs: SimulatedLeg[] = [];
  const quoteMeta = [] as BuildSimulateResult["quoteMeta"];

  if (params.direction === "JUP_TO_OKX") {
    console.log("[DEBUG] Leg 1/2 — Jupiter quote isteniyor...");
    const t0 = Date.now();
    const { route, meta } = await fetchJupiterQuote({
      inputMint: usdcMint,
      outputMint: solMint,
      amount: amountRaw,
      slippageBps: cfg.slippageBps
    });
    console.log(`[DEBUG] Jupiter quote alındı (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);
    quoteMeta.push(meta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t1 = Date.now();
    const jupTx = await buildJupiterSwap({ route, userPublicKey: params.owner });
    console.log(`[DEBUG] Jupiter swap TX hazır (${Date.now() - t1}ms)`);

    const jupLeg: SimulatedLeg = {
      venue: "JUPITER",
      tx: jupTx,
      outMint: solMint,
      owner: ownerStr,
      expectedOut: meta.expectedOut,
      simulatedOut: meta.expectedOut,
      simulation: { logs: [] }
    };

    console.log("[DEBUG] Jupiter TX simüle ediliyor...");
    const t2 = Date.now();
    legs.push(await simulateLeg(jupLeg, "JUPITER"));
    console.log(`[DEBUG] Jupiter simülasyon tamamlandı (${Date.now() - t2}ms)`);

    console.log("[DEBUG] Leg 2/2 — OKX quote isteniyor...");
    const t3 = Date.now();
    const { ctx, meta: okxMeta } = await fetchOkxQuote({
      inputMint: solMint,
      outputMint: usdcMint,
      amount: meta.expectedOut,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr
    });
    console.log(`[DEBUG] OKX quote alındı (${Date.now() - t3}ms) — expectedOut=${okxMeta.expectedOut.toString()}`);
    quoteMeta.push(okxMeta);

    console.log("[DEBUG] OKX swap TX oluşturuluyor...");
    const t4 = Date.now();
    const okxTx = await buildOkxSwap({
      inputMint: solMint,
      outputMint: usdcMint,
      amount: meta.expectedOut,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr,
    });
    console.log(`[DEBUG] OKX swap TX hazır (${Date.now() - t4}ms)`);

    const okxLeg: SimulatedLeg = {
      venue: "OKX",
      tx: okxTx,
      outMint: usdcMint,
      owner: ownerStr,
      expectedOut: okxMeta.expectedOut,
      simulatedOut: okxMeta.expectedOut,
      simulation: { logs: [] }
    };

    console.log("[DEBUG] OKX TX simüle ediliyor...");
    const t5 = Date.now();
    legs.push(await simulateLeg(okxLeg, "OKX"));
    console.log(`[DEBUG] OKX simülasyon tamamlandı (${Date.now() - t5}ms)`);
  } else {
    console.log("[DEBUG] Leg 1/2 — OKX quote isteniyor...");
    const t0 = Date.now();
    const { ctx, meta } = await fetchOkxQuote({
      inputMint: usdcMint,
      outputMint: solMint,
      amount: amountRaw,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr
    });
    console.log(`[DEBUG] OKX quote alındı (${Date.now() - t0}ms) — expectedOut=${meta.expectedOut.toString()}`);
    quoteMeta.push(meta);

    console.log("[DEBUG] OKX swap TX oluşturuluyor...");
    const t1 = Date.now();
    const okxTx = await buildOkxSwap({
      inputMint: usdcMint,
      outputMint: solMint,
      amount: amountRaw,
      slippageBps: cfg.slippageBps,
      userPublicKey: ownerStr,
    });
    console.log(`[DEBUG] OKX swap TX hazır (${Date.now() - t1}ms)`);

    const okxLeg: SimulatedLeg = {
      venue: "OKX",
      tx: okxTx,
      outMint: solMint,
      owner: ownerStr,
      expectedOut: meta.expectedOut,
      simulatedOut: meta.expectedOut,
      simulation: { logs: [] }
    };

    console.log("[DEBUG] OKX TX simüle ediliyor...");
    const t2 = Date.now();
    legs.push(await simulateLeg(okxLeg, "OKX"));
    console.log(`[DEBUG] OKX simülasyon tamamlandı (${Date.now() - t2}ms)`);

    console.log("[DEBUG] Leg 2/2 — Jupiter quote isteniyor...");
    const t3 = Date.now();
    const { route, meta: jupMeta } = await fetchJupiterQuote({
      inputMint: solMint,
      outputMint: usdcMint,
      amount: meta.expectedOut,
      slippageBps: cfg.slippageBps
    });
    console.log(`[DEBUG] Jupiter quote alındı (${Date.now() - t3}ms) — expectedOut=${jupMeta.expectedOut.toString()}`);
    quoteMeta.push(jupMeta);

    console.log("[DEBUG] Jupiter swap TX oluşturuluyor...");
    const t4 = Date.now();
    const jupTx = await buildJupiterSwap({ route, userPublicKey: params.owner });
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

    console.log("[DEBUG] Jupiter TX simüle ediliyor...");
    const t5 = Date.now();
    legs.push(await simulateLeg(jupLeg, "JUPITER"));
    console.log(`[DEBUG] Jupiter simülasyon tamamlandı (${Date.now() - t5}ms)`);
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
  const feeSol = estimateTxFeeSol(cfg.rpc.priorityFeeMicrolamports, legs.length);
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
        const tel = buildTelemetry({ build: partialResult, direction: params.direction, success: false, failReason, status: "SLIPPAGE_EXCEEDED", netProfit });
        appendTradeLog(tel);
        throw new SlippageError(failReason);
      }
    }
    if (leg.simulation.error) {
      if (params.dryRun) {
        console.warn(`[WARN] Leg ${idx + 1} (${leg.venue}): Simulation error: ${leg.simulation.error} — dry-run devam ediyor`);
      } else {
        const failReason = `Simulation failed: ${leg.simulation.error}`;
        const tel = buildTelemetry({ build: partialResult, direction: params.direction, success: false, failReason, status: "SIMULATION_FAILED", netProfit });
        appendTradeLog(tel);
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
    const tel = buildTelemetry({ build: partialResult, direction: params.direction, success: false, failReason, status: "REJECTED_LOW_PROFIT", netProfit });
    appendTradeLog(tel);
    throw new NetProfitRejectedError(failReason, netProfit);
  }

  // ───── Onaylandı → telemetri kaydet & return ─────
  const tel = buildTelemetry({ build: partialResult, direction: params.direction, success: true, status: "SIMULATION_SUCCESS", netProfit });
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
