import { config as loadDotenv } from "dotenv";
loadDotenv();

import { Direction } from "./types.js";
import { startServer } from "./server.js";
import { PriceTicker } from "./stream/priceTicker.js";

// ─── Ana başlatıcı ──────────────────────────────────────────────────
// Express API sunucusu (dashboard için) + PriceTicker (event-driven sim döngüsü)
// birlikte çalıştırılır. Gerçek işlem gönderimi YAPILMAZ, sadece simülasyon yapılır.

async function main() {
  // 1) Express API sunucusu
  startServer();

  // 2) PriceTicker — WebSocket slot stream üzerinden simülasyon döngüsü
  const direction = (process.env.DIRECTION as Direction) ?? "JUP_TO_OKX";
  const slotsPerCheck = Number(process.env.SLOTS_PER_CHECK ?? 4);

  const ticker = new PriceTicker({ direction, slotsPerCheck });
  ticker.start();

  const tradeAmount = process.env.TRADE_AMOUNT_USDC ?? "1";
  console.log(
    `[START] PriceTicker başlatıldı — direction=${direction}, ` +
    `TRADE_AMOUNT_USDC=${tradeAmount}, slotsPerCheck=${slotsPerCheck}`
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[START] Kapatılıyor...");
    ticker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[START] Kritik hata:", err);
  process.exit(1);
});
