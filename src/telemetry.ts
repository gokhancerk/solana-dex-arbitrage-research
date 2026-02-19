import { promises as fs } from "fs";
import path from "path";
import { BuildSimulateResult, Telemetry, TelemetryStatus, Direction, NetProfitInfo, RealizedPnlInfo, LatencyMetrics, JitoBundleTelemetry, MarketClassification } from "./types.js";
import type { TradePair, TokenSymbol } from "./config.js";

// ───── Logs directory & file path ─────
const LOGS_DIR = path.resolve(process.cwd(), "logs");
const TRADES_FILE = path.join(LOGS_DIR, "trades.jsonl");

let logsDirEnsured = false;

/** Ensure `logs/` exists (runs once). */
async function ensureLogsDir(): Promise<void> {
  if (logsDirEnsured) return;
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    logsDirEnsured = true;
  } catch (err) {
    console.error("[TELEMETRY] logs/ klasörü oluşturulamadı:", err);
  }
}

// ───── buildTelemetry ─────

export interface BuildTelemetryParams {
  build?: BuildSimulateResult;
  direction: Direction;
  /** Hangi token üzerinden arbitraj yapıldı (WIF veya JUP). Varsayılan: WIF */
  targetToken?: TokenSymbol;
  sendSignatures?: string[];
  realizedOut?: bigint;
  success: boolean;
  failReason?: string;
  status: TelemetryStatus;
  netProfit?: NetProfitInfo;
  /** On-chain gerçek bakiye deltasına dayalı kâr/zarar (Pre vs Post snapshot) */
  realizedPnl?: RealizedPnlInfo;
  /** Per-cycle latency breakdown (v1 telemetry) */
  latencyMetrics?: LatencyMetrics;
  /** Jito bundle telemetry (v1 telemetry) */
  jitoBundleTelemetry?: JitoBundleTelemetry;
  /** Market type classification at time of trade */
  marketClassification?: MarketClassification;
  /** Pre-send estimated net profit (from quote + fees) for drift analysis */
  expectedNetProfitUsdc?: number;
  /** Experiment mode identifier (e.g. "JUPITER_ONLY"). Undefined = normal operation. */
  experimentMode?: string;
}

export function buildTelemetry(params: BuildTelemetryParams): Telemetry {
  const {
    build,
    direction,
    targetToken = "WIF",
    sendSignatures = [],
    realizedOut,
    success,
    failReason,
    status,
    netProfit,
    realizedPnl,
    latencyMetrics,
    jitoBundleTelemetry,
    marketClassification,
    expectedNetProfitUsdc,
    experimentMode,
  } = params;

  const pair: TradePair = `${targetToken}/USDC` as TradePair;

  const lastLeg = build?.legs.at(-1);
  const expectedOut = lastLeg?.expectedOut ?? BigInt(0);
  const simulatedOut = lastLeg?.simulatedOut ?? expectedOut;
  const effectiveSlippageBps = lastLeg?.effectiveSlippageBps;

  const realizedStr = realizedOut ? realizedOut.toString() : undefined;
  const simulatedStr = simulatedOut.toString();

  let profitLabel: Telemetry["profitLabel"] = "flat";
  // Öncelik: Realized PnL varsa gerçek sonuç kullanılır (tahmini değil)
  if (realizedPnl) {
    if (realizedPnl.realizedNetProfitUsdc > 0.0001) profitLabel = "profit";
    else if (realizedPnl.realizedNetProfitUsdc < -0.0001) profitLabel = "loss";
  } else if (realizedOut && realizedOut > expectedOut) profitLabel = "profit";
  else if (realizedOut && realizedOut < expectedOut) profitLabel = "loss";
  else if (netProfit) {
    if (netProfit.netProfitUsdc > 0) profitLabel = "profit";
    else if (netProfit.netProfitUsdc < 0) profitLabel = "loss";
  }

  return {
    pair,
    direction,
    targetToken,
    simulatedAmountOut: simulatedStr,
    realizedAmountOut: realizedStr,
    effectiveSlippageBps,
    success,
    failReason,
    txSignatures: sendSignatures,
    timestamp: new Date().toISOString(),
    retries: sendSignatures.length > 0 ? sendSignatures.length - 1 : 0,
    profitLabel,
    // Realized PnL varsa gerçek değerleri yaz, yoksa tahmini değerleri koru
    netProfitUsdc: realizedPnl?.realizedNetProfitUsdc ?? netProfit?.netProfitUsdc ?? 0,
    grossProfitUsdc: realizedPnl?.deltaUsdc ?? netProfit?.grossProfitUsdc ?? 0,
    feeUsdc: realizedPnl?.solCostUsdc ?? netProfit?.feeUsdc ?? 0,
    status,
    realizedPnl,
    latencyMetrics,
    jitoBundleTelemetry,
    marketClassification,
    expectedNetProfitUsdc,
    profitDriftUsdc: computeProfitDrift(expectedNetProfitUsdc, realizedPnl),
    experimentMode,
  };
}

/**
 * Compute profit drift: realized - expected.
 * Negative drift = spread closed or frontrun.
 * Undefined if either value is missing.
 */
function computeProfitDrift(
  expectedNetProfitUsdc: number | undefined,
  realizedPnl: RealizedPnlInfo | undefined,
): number | undefined {
  if (expectedNetProfitUsdc === undefined || !realizedPnl) return undefined;
  return realizedPnl.realizedNetProfitUsdc - expectedNetProfitUsdc;
}

// ───── JSONL Logging ─────

/**
 * Only these statuses are persisted to trades.jsonl.
 * Other statuses (SIMULATION_FAILED, SLIPPAGE_EXCEEDED, SEND_FAILED,
 * LIMIT_BREACH, QUOTE_ERROR, UNKNOWN_ERROR) are emitted as console.warn
 * to reduce I/O and keep the log file clean with actionable entries only.
 */
const PERSISTABLE_STATUSES: ReadonlySet<TelemetryStatus> = new Set([
  "SIMULATION_SUCCESS",
  "DRY_RUN_SIM_OK",
  "DRY_RUN_PROFITABLE",
  "EXPERIMENT_JUPITER_ONLY",
  "EXPERIMENT_NO_SIMULATE",
  "EXPERIMENT_JITO_PREP",
  "EXPERIMENT_D_NO_OPP",
  "EXPERIMENT_D_READY",
  "EXPERIMENT_D_READY_REJECTED",
  "EXPERIMENT_D_READY_NO_OPP",
  "EXPERIMENT_D_READY_ERROR",
  "REJECTED_LOW_PROFIT",
  "SEND_SUCCESS",
  "EMERGENCY_UNWIND_SUCCESS",
  "EMERGENCY_UNWIND_FAILED",
  "LEG2_REFRESH_FAILED",
  "JITO_BUNDLE_LANDED",
  "JITO_BUNDLE_FAILED",
]);

/**
 * Append a telemetry record to `logs/trades.jsonl` (non-blocking).
 * Creates the `logs/` directory on first call if it doesn't exist.
 * Wrapped in try/catch so I/O errors never crash the main loop.
 *
 * Only entries with a persistable status are written to disk.
 * All others are logged to console.warn for observability without I/O cost.
 */
export async function appendTradeLog(entry: Telemetry): Promise<void> {
  if (!PERSISTABLE_STATUSES.has(entry.status)) {
    console.warn(
      `[TELEMETRY][SKIP] status=${entry.status} dosyaya yazılmadı — reason: ${entry.failReason ?? "n/a"}`
    );
    return;
  }

  try {
    await ensureLogsDir();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(TRADES_FILE, line, "utf-8");
  } catch (err) {
    console.error("[TELEMETRY] trades.jsonl yazma hatası:", err);
  }
}
