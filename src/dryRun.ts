import { config as loadDotenv } from "dotenv";
import { getConnection } from "./solana.js";
import { buildAndSimulate } from "./execution.js";
import { getKeypairFromEnv } from "./wallet.js";
import { Direction, NetProfitRejectedError, SimulationError, SlippageError, LimitBreachError, SendError, TelemetryStatus } from "./types.js";
import { measureAllEndpoints, printLatencyReport } from "./latency.js";
import { buildTelemetry, appendTradeLog } from "./telemetry.js";
import { startServer } from "./server.js";

function errorToStatus(err: unknown): TelemetryStatus {
  if (err instanceof NetProfitRejectedError) return "REJECTED_LOW_PROFIT";
  if (err instanceof SimulationError) return "SIMULATION_FAILED";
  if (err instanceof SlippageError) return "SLIPPAGE_EXCEEDED";
  if (err instanceof SendError) return "SEND_FAILED";
  if (err instanceof LimitBreachError) return "LIMIT_BREACH";
  return "UNKNOWN_ERROR";
}

loadDotenv();

async function main() {
  // API sunucusunu arka planda başlat
  startServer();

  const owner = getKeypairFromEnv();

  // ── 1) RPC Latency Testi ──────────────────────────────────────────
  console.log("═══ RPC Latency Ölçümü Başlıyor ═══\n");
  const reports = await measureAllEndpoints({
    rounds: 5,
    delayMs: 200,
    walletPubkey: owner.publicKey,
  });
  for (const r of reports) {
    printLatencyReport(r);
  }

  // ── 2) Build + Simulate (swap dry-run) ────────────────────────────
  const direction = (process.env.DIRECTION as Direction) ?? "JUP_TO_OKX";
  const notional = Number(process.env.NOTIONAL_USD ?? 1);

  console.log(`\n═══ Swap Dry-Run: direction=${direction} notional=${notional} ═══\n`);
  try {
    const result = await buildAndSimulate({ direction, notionalUsd: notional, owner: owner.publicKey, dryRun: true });

    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  Dry-Run Sonuçları                                      ║`);
    console.log(`╠══════════════════════════════════════════════════════════╣`);
    result.legs.forEach((leg, idx) => {
      const status = leg.simulation.error ? "⚠ SIM HATASI" : "✓ SIM OK";
      console.log(`║  Leg ${idx + 1}: ${leg.venue.padEnd(8)} ${status.padEnd(20)}          ║`);
      console.log(`║    expectedOut  = ${leg.expectedOut.toString().padEnd(20)}              ║`);
      console.log(`║    simulatedOut = ${(leg.simulatedOut?.toString() ?? "n/a").padEnd(20)}              ║`);
      console.log(`║    slippageBps  = ${(leg.effectiveSlippageBps?.toString() ?? "n/a").padEnd(20)}              ║`);
      if (leg.simulation.error) {
        console.log(`║    sim error    = ${leg.simulation.error.substring(0, 36).padEnd(20)}  ║`);
      }
      if (leg.simulation.unitsConsumed) {
        console.log(`║    CU consumed  = ${leg.simulation.unitsConsumed.toString().padEnd(20)}              ║`);
      }
    });

    // Quote meta özeti
    if (result.quoteMeta.length >= 2) {
      const inAmt = result.quoteMeta[0].inAmount;
      const finalOut = result.quoteMeta[result.quoteMeta.length - 1].expectedOut;
      const pnl = Number(finalOut) - Number(inAmt);
      const pnlLabel = pnl > 0 ? "PROFIT" : pnl < 0 ? "LOSS" : "FLAT";
      console.log(`╠──────────────────────────────────────────────────────────╣`);
      console.log(`║  Input       = ${inAmt.toString().padEnd(20)} (USDC raw)        ║`);
      console.log(`║  ExpectedOut = ${finalOut.toString().padEnd(20)} (USDC raw)        ║`);
      console.log(`║  P/L (raw)   = ${pnl.toString().padEnd(20)} [${pnlLabel}]            ║`);
    }
    console.log(`╚══════════════════════════════════════════════════════════╝`);

    // ── Telemetri kaydı (başarılı) ──
    const telemetry = buildTelemetry({
      build: result,
      direction,
      success: true,
      status: "SIMULATION_SUCCESS",
      netProfit: result.netProfit,
    });
    await appendTradeLog(telemetry);
    console.log(`[TELEMETRY] Kayıt logs/trades.jsonl'ye yazıldı.`);
  } catch (err) {
    const status = errorToStatus(err);
    const netProfit = err instanceof NetProfitRejectedError ? err.netProfit : undefined;

    // ── Telemetri kaydı (başarısız) ──
    const telemetry = buildTelemetry({
      direction,
      success: false,
      failReason: err instanceof Error ? err.message : String(err),
      status,
      netProfit,
    });
    await appendTradeLog(telemetry);
    console.log(`[TELEMETRY] Hata kaydı logs/trades.jsonl'ye yazıldı.`);

    console.error(`[ERROR] Swap dry-run başarısız:`, err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(`[ERROR] Stack trace:`, err.stack);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
