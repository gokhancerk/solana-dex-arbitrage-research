/**
 * EXPERIMENT MODE A — Offline Latency Analysis
 *
 * logs/trades.jsonl dosyasından EXPERIMENT_JUPITER_ONLY kayıtlarını okur
 * ve latency metriklerini özetler.
 *
 * Kullanım:
 *   npx tsx src/scripts/analyzeExperimentA.ts
 *
 * Çıktı:
 *   - Ortalama / median quoteLatencyMs
 *   - Ortalama / median buildLatencyMs
 *   - Ortalama / median simulationLatencyMs
 *   - Ortalama / median detectToSendLatencyMs
 *   - quoteToSendLatencyMs dağılımı (p50, p90, p99)
 *   - Pair bazında en hızlı / en yavaş 5 kayıt
 */

import { promises as fs } from "fs";
import path from "path";

interface LatencyMetrics {
  quoteLatencyMs: number;
  buildLatencyMs: number;
  simulationLatencyMs: number;
  detectToSendLatencyMs: number;
  quoteReceivedTimestamp: number;
  quoteToSendLatencyMs: number;
  executionMode: string;
}

interface MarketClassification {
  type: string;
  routeMarkets: number;
}

interface ExperimentRecord {
  pair: string;
  direction: string;
  targetToken: string;
  timestamp: string;
  status: string;
  experimentMode?: string;
  latencyMetrics?: LatencyMetrics;
  marketClassification?: MarketClassification;
  netProfitUsdc: number;
  grossProfitUsdc: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  const logsFile = path.resolve(process.cwd(), "logs", "trades.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(logsFile, "utf-8");
  } catch {
    console.error(`[ERROR] ${logsFile} okunamadı. Önce experiment'ı çalıştırın.`);
    process.exit(1);
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const all: ExperimentRecord[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as ExperimentRecord;
      all.push(obj);
    } catch {
      // skip malformed lines
    }
  }

  // Filter experiment records
  const records = all.filter(
    (r) =>
      r.experimentMode === "JUPITER_ONLY" ||
      r.status === "EXPERIMENT_JUPITER_ONLY"
  );

  if (records.length === 0) {
    console.error(
      `[ERROR] EXPERIMENT_JUPITER_ONLY kaydı bulunamadı.\n` +
        `  Toplam kayıt: ${all.length}\n` +
        `  Deney koşmak için: DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true npm start`
    );
    process.exit(1);
  }

  const withLatency = records.filter((r) => r.latencyMetrics);

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  EXPERIMENT MODE A — Jupiter-only Latency Analysis`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Toplam kayıt       : ${records.length}`);
  console.log(`  Latency verili      : ${withLatency.length}`);
  console.log(`  Zaman aralığı       : ${records[0]?.timestamp ?? "?"} → ${records.at(-1)?.timestamp ?? "?"}`);
  console.log();

  if (withLatency.length === 0) {
    console.error(`[WARN] Latency verisi olan kayıt yok — analiz yapılamıyor.`);
    process.exit(0);
  }

  const quoteLatencies = withLatency.map((r) => r.latencyMetrics!.quoteLatencyMs);
  const buildLatencies = withLatency.map((r) => r.latencyMetrics!.buildLatencyMs);
  const simLatencies = withLatency.map((r) => r.latencyMetrics!.simulationLatencyMs);
  const d2sLatencies = withLatency.map((r) => r.latencyMetrics!.detectToSendLatencyMs);
  const q2sLatencies = withLatency.map((r) => r.latencyMetrics!.quoteToSendLatencyMs);

  const printRow = (label: string, arr: number[]) => {
    console.log(
      `  ${label.padEnd(22)} ` +
        `mean=${mean(arr).toFixed(0).padStart(6)}ms  ` +
        `median=${median(arr).toFixed(0).padStart(6)}ms  ` +
        `p90=${percentile(arr, 90).toFixed(0).padStart(6)}ms  ` +
        `p99=${percentile(arr, 99).toFixed(0).padStart(6)}ms  ` +
        `min=${Math.min(...arr).toFixed(0).padStart(6)}ms  ` +
        `max=${Math.max(...arr).toFixed(0).padStart(6)}ms`
    );
  };

  console.log(`  ── Latency Dağılımı ──`);
  printRow("quoteLatencyMs", quoteLatencies);
  printRow("buildLatencyMs", buildLatencies);
  printRow("simulationLatencyMs", simLatencies);
  printRow("detectToSendLatencyMs", d2sLatencies);
  printRow("quoteToSendLatencyMs", q2sLatencies);

  // ── quoteToSendLatencyMs dağılımı ──
  console.log();
  console.log(`  ── quoteToSendLatencyMs Dağılımı ──`);
  console.log(`  p10=${percentile(q2sLatencies, 10).toFixed(0)}ms`);
  console.log(`  p25=${percentile(q2sLatencies, 25).toFixed(0)}ms`);
  console.log(`  p50=${percentile(q2sLatencies, 50).toFixed(0)}ms`);
  console.log(`  p75=${percentile(q2sLatencies, 75).toFixed(0)}ms`);
  console.log(`  p90=${percentile(q2sLatencies, 90).toFixed(0)}ms`);
  console.log(`  p99=${percentile(q2sLatencies, 99).toFixed(0)}ms`);

  // ── Pair bazında en hızlı / en yavaş 5 ──
  console.log();
  console.log(`  ── Pair Bazında En Hızlı 5 (quoteLatencyMs) ──`);
  const sorted = [...withLatency].sort(
    (a, b) => a.latencyMetrics!.quoteLatencyMs - b.latencyMetrics!.quoteLatencyMs
  );
  for (const r of sorted.slice(0, 5)) {
    const m = r.latencyMetrics!;
    console.log(
      `  ${r.pair.padEnd(10)} quote=${m.quoteLatencyMs}ms  build=${m.buildLatencyMs}ms  d2s=${m.detectToSendLatencyMs}ms  ${r.timestamp}`
    );
  }

  console.log();
  console.log(`  ── Pair Bazında En Yavaş 5 (quoteLatencyMs) ──`);
  for (const r of sorted.slice(-5).reverse()) {
    const m = r.latencyMetrics!;
    console.log(
      `  ${r.pair.padEnd(10)} quote=${m.quoteLatencyMs}ms  build=${m.buildLatencyMs}ms  d2s=${m.detectToSendLatencyMs}ms  ${r.timestamp}`
    );
  }

  // ── Execution mode breakdown ──
  const modeGroups = new Map<string, number[]>();
  for (const r of withLatency) {
    const mode = r.latencyMetrics!.executionMode;
    if (!modeGroups.has(mode)) modeGroups.set(mode, []);
    modeGroups.get(mode)!.push(r.latencyMetrics!.quoteLatencyMs);
  }
  console.log();
  console.log(`  ── Execution Mode Breakdown ──`);
  for (const [mode, latencies] of modeGroups) {
    console.log(
      `  ${mode.padEnd(12)} count=${latencies.length}  median_quote=${median(latencies).toFixed(0)}ms`
    );
  }

  // ── Market classification breakdown ──
  const mcGroups = new Map<string, number>();
  for (const r of records) {
    const type = r.marketClassification?.type ?? "UNKNOWN";
    mcGroups.set(type, (mcGroups.get(type) ?? 0) + 1);
  }
  console.log();
  console.log(`  ── Market Classification Dağılımı ──`);
  for (const [type, count] of mcGroups) {
    console.log(`  Type ${type}: ${count} kayıt`);
  }

  console.log();
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  ÖNEMLİ SONUÇ:`);
  console.log(`  quoteLatencyMs (median) = ${median(quoteLatencies).toFixed(0)}ms`);
  console.log(`  simulationLatencyMs (median) = ${median(simLatencies).toFixed(0)}ms`);
  console.log(`  quoteToSendLatencyMs (median) = ${median(q2sLatencies).toFixed(0)}ms`);
  console.log();
  console.log(`  Eğer quoteLatencyMs belirgin düştüyse → OKX spacing ana katil.`);
  console.log(`  Eğer buildLatencyMs/simulationLatencyMs hâlâ yüksekse → RPC simulate hattı ana katil.`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
