import { promises as fs } from "fs";
import path from "path";
import { BuildSimulateResult, Telemetry, TelemetryStatus, Direction, NetProfitInfo, RealizedPnlInfo } from "./types.js";
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
  };
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
  "DRY_RUN_PROFITABLE",
  "REJECTED_LOW_PROFIT",
  "SEND_SUCCESS",
  "EMERGENCY_UNWIND_SUCCESS",
  "EMERGENCY_UNWIND_FAILED",
  "LEG2_REFRESH_FAILED",
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
