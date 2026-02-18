import type { VersionedTransaction } from "@solana/web3.js";
import type { TradePair, TokenSymbol } from "./config.js";

export type Direction = "JUP_TO_OKX" | "OKX_TO_JUP";

/*
 * JUP_TO_OKX  = Leg1: Jupiter USDC→<token>, Leg2: OKX <token>→USDC
 * OKX_TO_JUP  = Leg1: OKX USDC→<token>,     Leg2: Jupiter <token>→USDC
 */

export interface QuoteMeta {
  venue: "JUPITER" | "OKX";
  inMint: string;
  outMint: string;
  inAmount: bigint; // raw units
  expectedOut: bigint; // raw units
  slippageBps: number;
  routeContext?: unknown; // opaque route or path data for reuse
}

export interface SimulationOutcome {
  logs: string[];
  unitsConsumed?: number;
  error?: string;
  accountsLoaded?: number;
  preBalances?: bigint[];
  postBalances?: bigint[];
  preTokenBalances?: Array<{
    mint: string;
    owner: string;
    rawAmount: string;
    uiAmount?: string;
    decimals?: number;
  }>;
  postTokenBalances?: Array<{
    mint: string;
    owner: string;
    rawAmount: string;
    uiAmount?: string;
    decimals?: number;
  }>;
}

export interface SimulatedLeg {
  venue: "JUPITER" | "OKX";
  tx: VersionedTransaction;
  outMint?: string;
  owner?: string;
  simulatedOut?: bigint;
  expectedOut: bigint;
  effectiveSlippageBps?: number;
  simulation: SimulationOutcome;
}

export interface NetProfitInfo {
  grossProfitUsdc: number;
  feeUsdc: number;
  netProfitUsdc: number;
}

/**
 * On-chain gerçek bakiye deltasına dayalı kâr/zarar bilgisi.
 * Pre-trade vs Post-trade bakiye farkından hesaplanır.
 */
export interface RealizedPnlInfo {
  /** Post_USDC - Pre_USDC (pozitif = kazanç) */
  deltaUsdc: number;
  /** Pre_SOL - Post_SOL (harcanan gas/fee, SOL cinsinden) */
  deltaSol: number;
  /** SOL maliyetinin USDC karşılığı */
  solCostUsdc: number;
  /** Net gerçek kâr: deltaUsdc - solCostUsdc */
  realizedNetProfitUsdc: number;
  /** Hesapta kullanılan SOL/USDC kuru */
  solUsdcRate: number;
  /** Pre-trade USDC bakiyesi (raw) */
  preUsdcRaw: string;
  /** Post-trade USDC bakiyesi (raw) */
  postUsdcRaw: string;
  /** Pre-trade SOL bakiyesi (lamports) */
  preSolLamports: string;
  /** Post-trade SOL bakiyesi (lamports) */
  postSolLamports: string;
}

export interface BuildSimulateResult {
  direction: Direction;
  legs: SimulatedLeg[];
  quoteMeta: QuoteMeta[];
  netProfit: NetProfitInfo;
}

export interface SendAttempt {
  signature?: string;
  error?: string;
  attempt: number;
  backoffMs: number;
  timestamp: string;
}

export interface SendResult {
  success: boolean;
  finalSignature?: string;
  attempts: SendAttempt[];
  failReason?: string;
}

export type TelemetryStatus =
  | "SIMULATION_SUCCESS"
  | "SIMULATION_FAILED"
  | "DRY_RUN_PROFITABLE"
  | "REJECTED_LOW_PROFIT"
  | "SLIPPAGE_EXCEEDED"
  | "SEND_SUCCESS"
  | "SEND_FAILED"
  | "LIMIT_BREACH"
  | "QUOTE_ERROR"
  | "UNKNOWN_ERROR"
  | "EMERGENCY_UNWIND_SUCCESS"
  | "EMERGENCY_UNWIND_FAILED"
  | "LEG2_REFRESH_FAILED";

export interface Telemetry {
  pair: TradePair;
  direction: Direction;
  targetToken?: TokenSymbol;
  simulatedAmountOut: string;
  realizedAmountOut?: string;
  effectiveSlippageBps?: number;
  success: boolean;
  failReason?: string;
  txSignatures: string[];
  timestamp: string;
  retries: number;
  profitLabel: "profit" | "loss" | "flat";
  /** Net profit/loss in USDC after estimated fees (TAHMİNİ — quote-based) */
  netProfitUsdc: number;
  /** Gross profit in USDC before fees (TAHMİNİ) */
  grossProfitUsdc: number;
  /** Estimated network fee in USDC (TAHMİNİ) */
  feeUsdc: number;
  /** Machine-readable status tag */
  status: TelemetryStatus;
  // ───── Realized PnL (gerçek bakiye deltası) ─────
  /** Gerçek on-chain bakiye farkına dayalı kâr/zarar. Sadece SEND_SUCCESS ve EMERGENCY_UNWIND_* durumlarında dolu. */
  realizedPnl?: RealizedPnlInfo;
}

export class LimitBreachError extends Error {}
export class QuoteError extends Error {}
export class SlippageError extends Error {}
export class SimulationError extends Error {}
export class SendError extends Error {}
export class NetProfitRejectedError extends Error {
  public netProfit: NetProfitInfo;
  constructor(message: string, netProfit: NetProfitInfo) {
    super(message);
    this.netProfit = netProfit;
  }
}
