/**
 * EXPERIMENT MODE B — NO_SIMULATE Offline Latency Analysis
 *
 * logs/trades.jsonl dosyasından EXPERIMENT_NO_SIMULATE kayıtlarını okur,
 * Experiment A (JUPITER_ONLY) ile karşılaştırarak simulate maliyetini izole eder.
 *
 * Kullanım:
 *   npx tsx src/scripts/analyzeExperimentB.ts
 *
 * Çıktı:
 *   - Experiment A vs B karşılaştırmalı latency tablosu
 *   - buildLatencyMs farkı (simulate maliyeti)
 *   - detectToSendLatencyMs farkı
 *   - Sonuç yorumu: simulate ana maliyet mi?
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

interface ExperimentRecord {
  pair: string;
  direction: string;
  targetToken: string;
  timestamp: string;
  status: string;
  experimentMode?: string;
  latencyMetrics?: LatencyMetrics;
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

interface GroupStats {
  label: string;
  count: number;
  quoteLatency: number[];
  buildLatency: number[];
  simLatency: number[];
  d2sLatency: number[];
  q2sLatency: number[];
}

function computeStats(records: ExperimentRecord[], label: string): GroupStats {
  const withLatency = records.filter((r) => r.latencyMetrics);
  return {
    label,
    count: withLatency.length,
    quoteLatency: withLatency.map((r) => r.latencyMetrics!.quoteLatencyMs),
    buildLatency: withLatency.map((r) => r.latencyMetrics!.buildLatencyMs),
    simLatency: withLatency.map((r) => r.latencyMetrics!.simulationLatencyMs),
    d2sLatency: withLatency.map((r) => r.latencyMetrics!.detectToSendLatencyMs),
    q2sLatency: withLatency.map((r) => r.latencyMetrics!.quoteToSendLatencyMs),
  };
}

function printGroupRow(metric: string, a: number[], b: number[]) {
  const aM = a.length > 0 ? median(a).toFixed(0) : "n/a";
  const bM = b.length > 0 ? median(b).toFixed(0) : "n/a";
  const diff =
    a.length > 0 && b.length > 0
      ? (median(a) - median(b)).toFixed(0)
      : "n/a";
  const pct =
    a.length > 0 && b.length > 0 && median(a) > 0
      ? (((median(a) - median(b)) / median(a)) * 100).toFixed(1)
      : "n/a";
  console.log(
    `  ${metric.padEnd(24)} ${aM.padStart(8)}ms  ${bM.padStart(8)}ms  ${diff.padStart(8)}ms  ${pct.padStart(7)}%`
  );
}

async function main() {
  const logsFile = path.resolve(process.cwd(), "logs", "trades.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(logsFile, "utf-8");
  } catch {
    console.error(`[ERROR] ${logsFile} okunamadı. Önce experiment'ları çalıştırın.`);
    process.exit(1);
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const all: ExperimentRecord[] = [];

  for (const line of lines) {
    try {
      all.push(JSON.parse(line) as ExperimentRecord);
    } catch {
      // skip malformed
    }
  }

  const expA = all.filter(
    (r) =>
      r.experimentMode === "JUPITER_ONLY" ||
      r.status === "EXPERIMENT_JUPITER_ONLY"
  );
  const expB = all.filter(
    (r) =>
      r.experimentMode === "NO_SIMULATE" ||
      r.status === "EXPERIMENT_NO_SIMULATE"
  );

  const statsA = computeStats(expA, "A (JUPITER_ONLY)");
  const statsB = computeStats(expB, "B (NO_SIMULATE)");

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  EXPERIMENT B — NO_SIMULATE Latency Isolation Analysis`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Experiment A kayıt : ${expA.length} (latency: ${statsA.count})`);
  console.log(`  Experiment B kayıt : ${expB.length} (latency: ${statsB.count})`);
  console.log();

  if (statsB.count === 0) {
    console.error(
      `[ERROR] EXPERIMENT_NO_SIMULATE kaydı bulunamadı.\n` +
        `  Deney koşmak için:\n` +
        `  DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true EXPERIMENT_NO_SIMULATE=true npm start`
    );
    process.exit(1);
  }

  // ── Experiment B standalone stats ──
  console.log(`  ── Experiment B Standalone (NO_SIMULATE) ──`);
  const printRow = (label: string, arr: number[]) => {
    console.log(
      `  ${label.padEnd(24)} ` +
        `mean=${mean(arr).toFixed(0).padStart(6)}ms  ` +
        `median=${median(arr).toFixed(0).padStart(6)}ms  ` +
        `p90=${percentile(arr, 90).toFixed(0).padStart(6)}ms  ` +
        `min=${Math.min(...arr).toFixed(0).padStart(6)}ms  ` +
        `max=${Math.max(...arr).toFixed(0).padStart(6)}ms`
    );
  };
  printRow("quoteLatencyMs", statsB.quoteLatency);
  printRow("buildLatencyMs", statsB.buildLatency);
  printRow("simulationLatencyMs", statsB.simLatency);
  printRow("detectToSendLatencyMs", statsB.d2sLatency);
  printRow("quoteToSendLatencyMs", statsB.q2sLatency);
  console.log();

  // ── A vs B comparison ──
  if (statsA.count > 0) {
    console.log(`  ── A vs B Karşılaştırma (median) ──`);
    console.log(
      `  ${"Metric".padEnd(24)} ${"Exp A".padStart(8)}    ${"Exp B".padStart(8)}    ${"Δ (A−B)".padStart(8)}    ${"Düşüş".padStart(7)}`
    );
    console.log(`  ${"─".repeat(72)}`);
    printGroupRow("quoteLatencyMs", statsA.quoteLatency, statsB.quoteLatency);
    printGroupRow("buildLatencyMs", statsA.buildLatency, statsB.buildLatency);
    printGroupRow("simulationLatencyMs", statsA.simLatency, statsB.simLatency);
    printGroupRow("detectToSendLatencyMs", statsA.d2sLatency, statsB.d2sLatency);
    printGroupRow("quoteToSendLatencyMs", statsA.q2sLatency, statsB.q2sLatency);
    console.log();

    // ── İzole edilen simulate maliyeti ──
    const simCostMs = median(statsA.buildLatency) - median(statsB.buildLatency);
    const d2sDrop = median(statsA.d2sLatency) - median(statsB.d2sLatency);
    console.log(
      `  ── İzole Edilen Simulate Maliyeti ──\n` +
        `  buildLatency farkı (A − B) = ${simCostMs.toFixed(0)}ms → Bu, simulate çağrısının maliyetidir.\n` +
        `  detectToSend farkı (A − B) = ${d2sDrop.toFixed(0)}ms → Bu, D2S'ye simulate'in katkısıdır.`
    );
  } else {
    console.log(`  [WARN] Experiment A verisi yok — karşılaştırma yapılamıyor.`);
    console.log(`  Önce Experiment A'yı koşun: DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true npm start`);
  }

  // ── Sonuç yorumu ──
  console.log();
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  SONUÇ:`);
  if (statsA.count > 0 && statsB.count > 0) {
    const d2sA = median(statsA.d2sLatency);
    const d2sB = median(statsB.d2sLatency);
    const dropPct = d2sA > 0 ? ((d2sA - d2sB) / d2sA) * 100 : 0;
    console.log(`  detectToSendLatencyMs: A=${d2sA.toFixed(0)}ms → B=${d2sB.toFixed(0)}ms (${dropPct.toFixed(1)}% düşüş)`);

    if (dropPct > 40) {
      console.log(`  ✓ Simulate ANA MALİYET — D2S %${dropPct.toFixed(0)} düştü.`);
      console.log(`  → Optimize edilecek hedef: RPC simulateTransaction çağrısı.`);
      console.log(`  → Seçenekler: simulate'ı atla (live slippage güvenine bağıl), daha hızlı RPC, ya da Helius priority sim.`);
    } else if (dropPct > 15) {
      console.log(`  ~ Simulate kısmen etkili — D2S %${dropPct.toFixed(0)} düştü.`);
      console.log(`  → Simulate ve quote+build birlikte optimize edilmeli.`);
    } else {
      console.log(`  ✗ Simulate ANA MALİYET DEĞİL — D2S sadece %${dropPct.toFixed(0)} düştü.`);
      console.log(`  → Ana maliyet quote fetch ve/veya TX build aşamalarındadır.`);
    }
  } else {
    console.log(`  Karşılaştırma için hem A hem B verisi gerekiyor.`);
  }
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
