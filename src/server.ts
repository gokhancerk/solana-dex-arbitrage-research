import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";

const PORT = Number(process.env.API_PORT ?? 3001);
const TRADES_FILE = path.resolve(process.cwd(), "logs", "trades.jsonl");

const app = express();
app.use(cors());

// ─── GET /api/logs ──────────────────────────────────────────────────
// logs/trades.jsonl dosyasını okuyup her satırı parse eder, JSON dizisi döndürür.
app.get("/api/logs", async (_req, res) => {
  try {
    let content: string;
    try {
      content = await fs.readFile(TRADES_FILE, "utf-8");
    } catch {
      // Dosya yoksa boş dizi döndür
      res.json([]);
      return;
    }

    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const records: unknown[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Bozuk satırı atla
      }
    }

    res.json(records);
  } catch (err) {
    console.error("[API] /api/logs hatası:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start helper ───────────────────────────────────────────────────
export function startServer(): void {
  app.listen(PORT, () => {
    console.log(`[API] Express sunucusu http://localhost:${PORT} adresinde çalışıyor`);
  });
}

// Doğrudan çalıştırıldığında sunucuyu başlat
// (ESM: import.meta.url ile process.argv karşılaştırması)
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (isMain) {
  startServer();
}
