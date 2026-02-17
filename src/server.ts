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

// ─── API Router (Express 5 uyumlu) ─────────────────────────────────
const apiRouter = express.Router();

// Auth middleware — Router seviyesinde uygulanır
apiRouter.use((req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!DASHBOARD_PASSWORD) {
    return next();
  }
  if (token === DASHBOARD_PASSWORD) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
});

// GET /api/logs — trades.jsonl dosyasını okuyup JSON dizisi döndürür
apiRouter.get("/logs", async (_req, res) => {
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

// DELETE /api/logs — trades.jsonl dosyasını temizler
apiRouter.delete("/logs", async (_req, res) => {
  try {
    await fs.writeFile(TRADES_FILE, "", "utf-8");
    res.json({ success: true, message: "Tüm işlem verileri temizlendi." });
  } catch (err) {
    console.error("[API] /api/logs DELETE hatası:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Router'ı /api prefix'ine mount et
app.use("/api", apiRouter);

// ─── React Dashboard Static Files ───────────────────────────────────
app.use(express.static(DASHBOARD_DIST));

// ─── Catch-all: /api dışındaki tüm GET isteklerini React index.html'e yönlendir ──
// Express 5 middleware yaklaşımı (path-to-regexp v8 uyumlu)
app.use((req, res, next) => {
  // API isteklerini veya GET olmayan istekleri atla
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
