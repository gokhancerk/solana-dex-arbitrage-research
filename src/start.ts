import { config as loadDotenv } from "dotenv";
loadDotenv();

import { startServer } from "./server.js";
import { PriceTicker } from "./stream/priceTicker.js";
import { loadConfig } from "./config.js";
import { runExperimentDReady } from "./experimentDReady.js";

// ─── Ana başlatıcı ──────────────────────────────────────────────────
// Express API sunucusu (dashboard için) + PriceTicker (bi-directional event-driven döngüsü)
// birlikte çalıştırılır.

const MAX_TICKER_RETRIES = 5;
const TICKER_RETRY_BASE_MS = 3_000;

let activeTicker: PriceTicker | undefined;

/** PriceTicker'ı başlat; hata olursa exponential backoff ile yeniden dene. */
async function launchPriceTicker(attempt = 1): Promise<void> {
  const slotsPerCheck = Number(process.env.SLOTS_PER_CHECK ?? 4);
  const tradeAmount = process.env.TRADE_AMOUNT_USDC ?? "1";

  try {
    console.log(
      `[START] PriceTicker başlatılıyor (deneme ${attempt}/${MAX_TICKER_RETRIES}) — ` +
      `mode=BI-DIRECTIONAL (JUP↔OKX), TRADE_AMOUNT_USDC=${tradeAmount}, slotsPerCheck=${slotsPerCheck}`
    );

    const ticker = new PriceTicker({ slotsPerCheck });
    ticker.start();
    activeTicker = ticker;

    console.log(`[START] PriceTicker başarıyla başlatıldı ✓ (çift yönlü tarama aktif)`);
  } catch (err) {
    console.error(`[START] PriceTicker başlatılamadı (deneme ${attempt}):`, err);

    if (attempt >= MAX_TICKER_RETRIES) {
      console.error(
        `[START] PriceTicker ${MAX_TICKER_RETRIES} denemeden sonra başlatılamadı. ` +
        `Express API çalışmaya devam ediyor; PriceTicker devre dışı.`
      );
      return;
    }

    const delayMs = TICKER_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
    console.log(`[START] ${Math.round(delayMs)}ms sonra yeniden denenecek...`);
    await new Promise((r) => setTimeout(r, delayMs));
    return launchPriceTicker(attempt + 1);
  }
}

async function main() {
  // Gerekli env değişkenlerini kontrol et — erken uyarı
  const criticalEnvs = ["WALLET_KEYPATH", "USDC_MINT"];
  const missing = criticalEnvs.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(
      `[START] ⚠ Eksik env değişkenleri: ${missing.join(", ")} — ` +
      `PriceTicker başlatılamayabilir. Express API yine de çalışacak.`
    );
  }

  // 1) Express API sunucusu — her durumda ayağa kalksın
  startServer();

  // ── EXPERIMENT_D_READY modu kontrolü ──
  const mode = process.env.MODE;
  if (mode === "EXPERIMENT_D_READY") {
    console.log(`[START] MODE=EXPERIMENT_D_READY algılandı — pair discovery scanner başlatılıyor`);
    const maxCycles = process.env.MAX_CYCLES ? Number(process.env.MAX_CYCLES) : 0;
    const cycleSleep = process.env.CYCLE_SLEEP_SEC ? Number(process.env.CYCLE_SLEEP_SEC) : 30;
    const pairDelay = process.env.PAIR_DELAY_MS ? Number(process.env.PAIR_DELAY_MS) : 1500;
    await runExperimentDReady({ maxCycles, cycleSleepSec: cycleSleep, pairDelayMs: pairDelay });
    console.log(`[START] EXPERIMENT_D_READY tamamlandı — çıkılıyor.`);
    process.exit(0);
    return;
  }

  // Dry-run modu bilgilendirmesi
  const cfg = loadConfig();
  if (cfg.dryRun) {
    console.log(
      `\n╔══════════════════════════════════════════════════════════╗\n` +
      `║  ★ DRY-RUN MODU AKTİF — Mainnet TX gönderimi KAPALI   ║\n` +
      `║  Sadece quote + simulate yapılır, zincire TX gitmez.   ║\n` +
      `║  Canlıya geçmek için: DRY_RUN=false                    ║\n` +
      `╚══════════════════════════════════════════════════════════╝\n`
    );
  }

  // 2) PriceTicker — hata olursa retry ile başlat, Express'i çökertme
  await launchPriceTicker();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[START] Kapatılıyor...");
    activeTicker?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[START] Kritik hata:", err);
  // Express zaten dinliyordur; process'i öldürme — sadece logla
});
