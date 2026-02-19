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
  | "DRY_RUN_SIM_OK"
  | "REJECTED_LOW_PROFIT"
  | "SLIPPAGE_EXCEEDED"
  | "SEND_SUCCESS"
  | "SEND_FAILED"
  | "LIMIT_BREACH"
  | "QUOTE_ERROR"
  | "UNKNOWN_ERROR"
  | "EMERGENCY_UNWIND_SUCCESS"
  | "EMERGENCY_UNWIND_FAILED"
  | "LEG2_REFRESH_FAILED"
  | "JITO_BUNDLE_LANDED"
  | "JITO_BUNDLE_FAILED";

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
  // ───── Latency Metrics (v1 telemetry extension) ─────
  /** Per-cycle latency breakdown: quote, build, simulation, detect-to-send */
  latencyMetrics?: LatencyMetrics;
  // ───── Jito Bundle Telemetry ─────
  /** Jito-specific metrics: send/landing slot, bundle status, inclusion delay */
  jitoBundleTelemetry?: JitoBundleTelemetry;
  // ───── Market Classification ─────
  /** Market type classification at time of trade */
  marketClassification?: MarketClassification;
  // ───── Profit Drift Analysis ─────
  /** Pre-send estimated net profit in USDC (from quote + fee estimation) */
  expectedNetProfitUsdc?: number;
  /** Profit drift: realizedPnl - expectedNetProfit. Negative = frontrun/spread close. */
  profitDriftUsdc?: number;
}

// ───── Market Type Classification ─────
export type MarketType = "A" | "B" | "C" | "UNKNOWN";

export interface MarketClassification {
  type: MarketType;
  impact1k: number;     // price impact for $1k quote (%)
  impact3k: number;     // price impact for $3k quote (%)
  impact5k: number;     // price impact for $5k quote (%)
  routeMarkets: number; // number of route segments
  volume24h: number;    // 24h volume in USD
  liquidity: number;    // total liquidity in USD
  volumeLiquidityRatio: number;
  slippageCurveRatio: number; // impact_5k / impact_1k
  rejectReasons: string[];    // empty = accepted
  eligible: boolean;          // true = Type C, can trade
}

// ───── Latency Metrics (per-cycle) ─────
export interface LatencyMetrics {
  detectSlot: number;
  detectTimestamp: number;
  quoteLatencyMs: number;
  buildLatencyMs: number;
  simulationLatencyMs: number;
  detectToSendLatencyMs: number;
  executionMode: "JITO" | "SEQUENTIAL";
  /** Epoch ms when quote results were received (for stale quote detection) */
  quoteReceivedTimestamp: number;
  /** Time between quote receipt and TX send — stale quote risk metric (ms) */
  quoteToSendLatencyMs: number;
}

// ───── Jito Bundle Telemetry ─────
export interface JitoBundleTelemetry {
  bundleSendSlot: number;
  bundleSendTimestamp: number;
  bundleLandingSlot: number | null;
  bundleStatus: "LANDED" | "FAILED" | "TIMEOUT";
  bundleLatencyMs: number;
  bundleInclusionDelaySlots: number;
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
