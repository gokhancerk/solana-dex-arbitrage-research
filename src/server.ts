import "dotenv/config";
import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";

const PORT = Number(process.env.API_PORT ?? 3001);
const TRADES_FILE = path.resolve(process.cwd(), "logs", "trades.jsonl");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";

// React build çıktısının yolu (dashboard/dist)
const DASHBOARD_DIST = path.resolve(process.cwd(), "dashboard", "dist");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth middleware (standalone) ───────────────────────────────────
function authCheck(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!DASHBOARD_PASSWORD || token === DASHBOARD_PASSWORD) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ─── API Route'ları (Router kullanmadan doğrudan app üzerinde) ──────
// Express 5 + path-to-regexp v8'de Router mount sorunu nedeniyle
// route'lar doğrudan app'e tam path ile tanımlanıyor.

// GET /api/logs — trades.jsonl dosyasını okuyup JSON dizisi döndürür
app.get("/api/logs", authCheck, async (_req, res) => {
  try {
    let content: string;
    try {
      content = await fs.readFile(TRADES_FILE, "utf-8");
    } catch {
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

// POST /api/logs/clear — trades.jsonl dosyasını temizler
app.post("/api/logs/clear", authCheck, async (_req, res) => {
  try {
    await fs.writeFile(TRADES_FILE, "", "utf-8");
    res.json({ success: true, message: "Tüm işlem verileri temizlendi." });
  } catch (err) {
    console.error("[API] /api/logs/clear hatası:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── React Dashboard Static Files ───────────────────────────────────
app.use(express.static(DASHBOARD_DIST));

// ─── Catch-all: /api dışındaki tüm GET isteklerini React index.html'e yönlendir ──
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.method !== "GET") {
    return next();
  }
  res.sendFile(path.join(DASHBOARD_DIST, "index.html"));
});

// ─── Start helper ───────────────────────────────────────────────────
export function startServer(): void {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] Express sunucusu http://0.0.0.0:${PORT} adresinde çalışıyor`);
    console.log(`[API] Dashboard: ${DASHBOARD_DIST}`);
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
