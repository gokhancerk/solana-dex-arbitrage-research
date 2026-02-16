import { promises as fs } from "fs";
import path from "path";
import { BuildSimulateResult, Telemetry, TelemetryStatus, Direction, NetProfitInfo } from "./types.js";

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
  sendSignatures?: string[];
  realizedOut?: bigint;
  success: boolean;
  failReason?: string;
  status: TelemetryStatus;
  netProfit?: NetProfitInfo;
}

export function buildTelemetry(params: BuildTelemetryParams): Telemetry {
  const {
    build,
    direction,
    sendSignatures = [],
    realizedOut,
    success,
    failReason,
    status,
    netProfit,
  } = params;

  const lastLeg = build?.legs.at(-1);
  const expectedOut = lastLeg?.expectedOut ?? BigInt(0);
  const simulatedOut = lastLeg?.simulatedOut ?? expectedOut;
  const effectiveSlippageBps = lastLeg?.effectiveSlippageBps;

  const realizedStr = realizedOut ? realizedOut.toString() : undefined;
  const simulatedStr = simulatedOut.toString();

  let profitLabel: Telemetry["profitLabel"] = "flat";
  if (realizedOut && realizedOut > expectedOut) profitLabel = "profit";
  else if (realizedOut && realizedOut < expectedOut) profitLabel = "loss";
  else if (netProfit) {
    if (netProfit.netProfitUsdc > 0) profitLabel = "profit";
    else if (netProfit.netProfitUsdc < 0) profitLabel = "loss";
  }

  return {
    pair: "SOL/USDC",
    direction,
    simulatedAmountOut: simulatedStr,
    realizedAmountOut: realizedStr,
    effectiveSlippageBps,
    success,
    failReason,
    txSignatures: sendSignatures,
    timestamp: new Date().toISOString(),
    retries: sendSignatures.length > 0 ? sendSignatures.length - 1 : 0,
    profitLabel,
    netProfitUsdc: netProfit?.netProfitUsdc ?? 0,
    grossProfitUsdc: netProfit?.grossProfitUsdc ?? 0,
    feeUsdc: netProfit?.feeUsdc ?? 0,
    status,
  };
}

// ───── JSONL Logging ─────

/**
 * Append a telemetry record to `logs/trades.jsonl` (non-blocking).
 * Creates the `logs/` directory on first call if it doesn't exist.
 * Wrapped in try/catch so I/O errors never crash the main loop.
 */
export async function appendTradeLog(entry: Telemetry): Promise<void> {
  try {
    await ensureLogsDir();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(TRADES_FILE, line, "utf-8");
  } catch (err) {
    console.error("[TELEMETRY] trades.jsonl yazma hatası:", err);
  }
}
