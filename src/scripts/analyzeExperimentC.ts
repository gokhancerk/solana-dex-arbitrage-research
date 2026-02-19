/**
 * EXPERIMENT MODE C — JITO_PREP Offline Latency Analysis
 *
 * logs/trades.jsonl dosyasından EXPERIMENT_JITO_PREP kayıtlarını okur,
 * Experiment B (NO_SIMULATE) ile karşılaştırarak Jito bundle prep maliyetini izole eder.
 *
 * Kullanım:
 *   npx tsx src/scripts/analyzeExperimentC.ts
 *
 * Çıktı:
 *   - Experiment B vs C karşılaştırmalı latency tablosu
 *   - jitoPrepLatencyMs doğrudan istatistikleri
 *   - detectToSendLatencyMs farkı (Jito prep'in D2S katkısı)
 *   - Sonuç yorumu: Jito prep ana maliyet mi?
 *
 * Beklenen deneysel akış (kümülatif):
 *   A — Jupiter-only (OKX izole edildi)
 *   B — Jupiter-only + no-simulate (simulate izole edildi)
 *   C — Jupiter-only + no-simulate + Jito prep (Jito prep maliyeti ölçüldü)
 *
 * Maliyet decomposition:
 *   D2S_full = quote + build + simulate + jito_prep + overhead
 *   D2S_A    = quote + build + simulate         (OKX çıkarıldı)
 *   D2S_B    = quote + build                    (simulate çıkarıldı)
 *   D2S_C    = quote + build + jito_prep        (jito prep eklendi)
 *   jito_cost = D2S_C - D2S_B  veya  doğrudan jitoPrepLatencyMs
 */

import { promises as fs } from "fs";
import path from "path";

interface JitoPrepSubTimings {
  blockhashFetchMs: number;
  tipAccountsFetchMs: number;
  bundleBuildMs: number;
}

interface LatencyMetrics {
  quoteLatencyMs: number;
  buildLatencyMs: number;
  simulationLatencyMs: number;
  jitoPrepLatencyMs?: number | null;
  jitoPrepAttempted?: boolean;
  jitoPrepSkippedReason?: string;
  jitoPrepSubTimings?: JitoPrepSubTimings;
  jitoPrepErrorMessage?: string;
  jitoPrepErrorCode?: string;
  jitoPrepErrorStage?: string;
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
  jitoPrepLatency: number[];
  blockhashFetch: number[];
  tipAccountsFetch: number[];
  bundleBuild: number[];
  d2sLatency: number[];
  q2sLatency: number[];
  jitoPrepAttemptedCount: number;
  jitoPrepSkippedCount: number;
  jitoPrepErrorCount: number;
  errorsByStage: Record<string, number>;
  errorsByCode: Record<string, number>;
  errorMessages: string[];
}

function computeStats(records: ExperimentRecord[], label: string): GroupStats {
  const withLatency = records.filter((r) => r.latencyMetrics);
  const errorRecords = withLatency.filter((r) => r.latencyMetrics!.jitoPrepSkippedReason === "ERROR");

  // Error stage breakdown
  const errorsByStage: Record<string, number> = {};
  const errorsByCode: Record<string, number> = {};
  const errorMessages: string[] = [];
  for (const r of errorRecords) {
    const lm = r.latencyMetrics!;
    const stage = lm.jitoPrepErrorStage ?? "UNKNOWN";
    errorsByStage[stage] = (errorsByStage[stage] ?? 0) + 1;
    const code = lm.jitoPrepErrorCode ?? "UNKNOWN";
    errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
    if (lm.jitoPrepErrorMessage) errorMessages.push(lm.jitoPrepErrorMessage);
  }

  return {
    label,
    count: withLatency.length,
    quoteLatency: withLatency.map((r) => r.latencyMetrics!.quoteLatencyMs),
    buildLatency: withLatency.map((r) => r.latencyMetrics!.buildLatencyMs),
    simLatency: withLatency.map((r) => r.latencyMetrics!.simulationLatencyMs),
    jitoPrepLatency: withLatency
      .map((r) => r.latencyMetrics!.jitoPrepLatencyMs)
      .filter((v): v is number => v != null && v > 0),
    blockhashFetch: withLatency
      .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.blockhashFetchMs)
      .filter((v): v is number => v != null),
    tipAccountsFetch: withLatency
      .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.tipAccountsFetchMs)
      .filter((v): v is number => v != null),
    bundleBuild: withLatency
      .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.bundleBuildMs)
      .filter((v): v is number => v != null),
    d2sLatency: withLatency.map((r) => r.latencyMetrics!.detectToSendLatencyMs),
    q2sLatency: withLatency.map((r) => r.latencyMetrics!.quoteToSendLatencyMs),
    jitoPrepAttemptedCount: withLatency.filter((r) => r.latencyMetrics!.jitoPrepAttempted === true).length,
    jitoPrepSkippedCount: withLatency.filter((r) => r.latencyMetrics!.jitoPrepAttempted === false).length,
    jitoPrepErrorCount: errorRecords.length,
    errorsByStage,
    errorsByCode,
    errorMessages,
  };
}

function printGroupRow(metric: string, b: number[], c: number[]) {
  const bM = b.length > 0 ? median(b).toFixed(0) : "n/a";
  const cM = c.length > 0 ? median(c).toFixed(0) : "n/a";
  const diff =
    b.length > 0 && c.length > 0
      ? (median(c) - median(b)).toFixed(0)
      : "n/a";
  const pct =
    b.length > 0 && c.length > 0 && median(b) > 0
      ? (((median(c) - median(b)) / median(b)) * 100).toFixed(1)
      : "n/a";
  console.log(
    `  ${metric.padEnd(24)} ${bM.padStart(8)}ms  ${cM.padStart(8)}ms  ${diff.padStart(8)}ms  ${pct.padStart(7)}%`
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

  const expB = all.filter(
    (r) =>
      r.experimentMode === "NO_SIMULATE" ||
      r.status === "EXPERIMENT_NO_SIMULATE"
  );
  const expC = all.filter(
    (r) =>
      r.experimentMode === "JITO_PREP" ||
      r.status === "EXPERIMENT_JITO_PREP"
  );

  const statsB = computeStats(expB, "B (NO_SIMULATE)");
  const statsC = computeStats(expC, "C (JITO_PREP)");

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  EXPERIMENT C — JITO_PREP Latency Isolation Analysis`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Experiment B kayıt : ${expB.length} (latency: ${statsB.count})`);
  console.log(`  Experiment C kayıt : ${expC.length} (latency: ${statsC.count})`);
  console.log(`    attempted: ${statsC.jitoPrepAttemptedCount} | skipped: ${statsC.jitoPrepSkippedCount} | error: ${statsC.jitoPrepErrorCount}`);

  // ── Error breakdown ──
  if (statsC.jitoPrepErrorCount > 0) {
    console.log(`\n  ── Jito Prep Error Breakdown ──`);
    console.log(`  Hata sayısı: ${statsC.jitoPrepErrorCount}`);
    console.log(`  Stage dağılımı:`);
    for (const [stage, count] of Object.entries(statsC.errorsByStage).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / statsC.jitoPrepErrorCount) * 100).toFixed(1);
      console.log(`    ${stage.padEnd(20)} ${String(count).padStart(5)} (%${pct})`);
    }
    console.log(`  Error code dağılımı:`);
    for (const [code, count] of Object.entries(statsC.errorsByCode).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / statsC.jitoPrepErrorCount) * 100).toFixed(1);
      console.log(`    ${code.padEnd(30)} ${String(count).padStart(5)} (%${pct})`);
    }
    // İlk 5 benzersiz hata mesajı
    const uniqueMsgs = [...new Set(statsC.errorMessages)];
    if (uniqueMsgs.length > 0) {
      console.log(`  Benzersiz hata mesajları (ilk ${Math.min(5, uniqueMsgs.length)}):`);
      for (const msg of uniqueMsgs.slice(0, 5)) {
        console.log(`    • ${msg.slice(0, 120)}${msg.length > 120 ? "…" : ""}`);
      }
    }
  }
  console.log();

  if (statsC.count === 0) {
    console.error(
      `[ERROR] EXPERIMENT_JITO_PREP kaydı bulunamadı.\n` +
        `  Deney koşmak için:\n` +
        `  DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true EXPERIMENT_NO_SIMULATE=true EXPERIMENT_JITO_PREP=true npm start`
    );
    process.exit(1);
  }

  // ── Experiment C standalone stats ──
  console.log(`  ── Experiment C Standalone (JITO_PREP) ──`);
  const printRow = (label: string, arr: number[]) => {
    if (arr.length === 0) {
      console.log(`  ${label.padEnd(24)} (veri yok)`);
      return;
    }
    console.log(
      `  ${label.padEnd(24)} ` +
        `mean=${mean(arr).toFixed(0).padStart(6)}ms  ` +
        `median=${median(arr).toFixed(0).padStart(6)}ms  ` +
        `p90=${percentile(arr, 90).toFixed(0).padStart(6)}ms  ` +
        `min=${Math.min(...arr).toFixed(0).padStart(6)}ms  ` +
        `max=${Math.max(...arr).toFixed(0).padStart(6)}ms`
    );
  };
  printRow("quoteLatencyMs", statsC.quoteLatency);
  printRow("buildLatencyMs", statsC.buildLatency);
  printRow("simulationLatencyMs", statsC.simLatency);
  printRow("jitoPrepLatencyMs", statsC.jitoPrepLatency);
  printRow("detectToSendLatencyMs", statsC.d2sLatency);
  printRow("quoteToSendLatencyMs", statsC.q2sLatency);
  console.log();

  // ── Doğrudan jitoPrepLatencyMs istatistikleri ──
  if (statsC.jitoPrepLatency.length > 0) {
    console.log(`  ── jitoPrepLatencyMs Detay (doğrudan ölçüm) ──`);
    const jp = statsC.jitoPrepLatency;
    console.log(
      `  Kayıt: ${jp.length} | ` +
        `mean=${mean(jp).toFixed(0)}ms | ` +
        `median=${median(jp).toFixed(0)}ms | ` +
        `p90=${percentile(jp, 90).toFixed(0)}ms | ` +
        `p99=${percentile(jp, 99).toFixed(0)}ms | ` +
        `min=${Math.min(...jp).toFixed(0)}ms | ` +
        `max=${Math.max(...jp).toFixed(0)}ms`
    );
    console.log(
      `  Bileşenler: getLatestBlockhash + getTipAccounts + buildTipTx + sign×3`
    );
    console.log();

    // ── Alt adım breakdown ──
    console.log(`  ── Jito Prep Sub-Timing Breakdown ──`);
    printRow("  blockhashFetchMs", statsC.blockhashFetch);
    printRow("  tipAccountsFetchMs", statsC.tipAccountsFetch);
    printRow("  bundleBuildMs", statsC.bundleBuild);

    // Alt adım toplamı vs total karşılaştırma
    if (statsC.blockhashFetch.length > 0 && statsC.tipAccountsFetch.length > 0 && statsC.bundleBuild.length > 0) {
      const subSum = median(statsC.blockhashFetch) + median(statsC.tipAccountsFetch) + median(statsC.bundleBuild);
      const totalMedian = median(jp);
      console.log(
        `\n  Alt adım toplamı (median): ${subSum.toFixed(0)}ms vs total: ${totalMedian.toFixed(0)}ms ` +
          `(fark: ${(totalMedian - subSum).toFixed(0)}ms overhead)`
      );

      // Bottleneck tespiti
      const parts = [
        { name: "blockhashFetch", val: median(statsC.blockhashFetch) },
        { name: "tipAccountsFetch", val: median(statsC.tipAccountsFetch) },
        { name: "bundleBuild", val: median(statsC.bundleBuild) },
      ].sort((a, b) => b.val - a.val);
      const topPct = totalMedian > 0 ? ((parts[0].val / totalMedian) * 100).toFixed(1) : "?";
      console.log(
        `  Bottleneck: ${parts[0].name} = ${parts[0].val.toFixed(0)}ms (${topPct}% of total)`
      );
    }
    console.log();
  }

  // ── B vs C comparison ──
  if (statsB.count > 0) {
    console.log(`  ── B vs C Karşılaştırma (median) ──`);
    console.log(
      `  ${"Metric".padEnd(24)} ${"Exp B".padStart(8)}    ${"Exp C".padStart(8)}    ${"Δ (C−B)".padStart(8)}    ${"Artış".padStart(7)}`
    );
    console.log(`  ${"─".repeat(72)}`);
    printGroupRow("quoteLatencyMs", statsB.quoteLatency, statsC.quoteLatency);
    printGroupRow("buildLatencyMs", statsB.buildLatency, statsC.buildLatency);
    printGroupRow("detectToSendLatencyMs", statsB.d2sLatency, statsC.d2sLatency);
    printGroupRow("quoteToSendLatencyMs", statsB.q2sLatency, statsC.q2sLatency);

    // jitoPrepLatencyMs sadece C'de var — doğrudan göster
    const jpMedian = statsC.jitoPrepLatency.length > 0 ? median(statsC.jitoPrepLatency) : 0;
    console.log(
      `  ${"jitoPrepLatencyMs".padEnd(24)} ${"—".padStart(8)}    ${jpMedian.toFixed(0).padStart(8)}ms  ${jpMedian.toFixed(0).padStart(8)}ms  ${"(yeni)".padStart(7)}`
    );
    console.log();

    // ── İzole edilen Jito prep maliyeti ──
    const d2sB = median(statsB.d2sLatency);
    const d2sC = median(statsC.d2sLatency);
    const jitoOverhead = d2sC - d2sB;
    console.log(
      `  ── İzole Edilen Jito Prep Maliyeti ──\n` +
        `  detectToSend farkı (C − B) = ${jitoOverhead.toFixed(0)}ms → Bu, Jito bundle prep'in D2S'ye katkısıdır.\n` +
        `  Doğrudan jitoPrepLatencyMs median = ${jpMedian.toFixed(0)}ms → Daha kesin ölçüm.\n` +
        `  Fark (D2S delta - doğrudan) = ${(jitoOverhead - jpMedian).toFixed(0)}ms → Overhead / noise.`
    );
  } else {
    console.log(`  [WARN] Experiment B verisi yok — karşılaştırma yapılamıyor.`);
    console.log(`  Önce Experiment B'yi koşun: DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true EXPERIMENT_NO_SIMULATE=true npm start`);
  }

  // ── Kümülatif Decomposition (A+B+C) ──
  const expA = all.filter(
    (r) =>
      r.experimentMode === "JUPITER_ONLY" ||
      r.status === "EXPERIMENT_JUPITER_ONLY"
  );
  const statsA = computeStats(expA, "A (JUPITER_ONLY)");

  if (statsA.count > 0 && statsB.count > 0 && statsC.count > 0) {
    const d2sA = median(statsA.d2sLatency);
    const d2sB = median(statsB.d2sLatency);
    const d2sC = median(statsC.d2sLatency);
    const simCost = d2sA - d2sB;
    const jitoCost = d2sC - d2sB;
    const jpDirect = statsC.jitoPrepLatency.length > 0 ? median(statsC.jitoPrepLatency) : 0;

    console.log();
    console.log(`  ── Kümülatif D2S Decomposition (median) ──`);
    console.log(`  A (JUP_ONLY)    D2S = ${d2sA.toFixed(0)}ms  (quote + build + simulate)`);
    console.log(`  B (NO_SIM)      D2S = ${d2sB.toFixed(0)}ms  (quote + build)`);
    console.log(`  C (JITO_PREP)   D2S = ${d2sC.toFixed(0)}ms  (quote + build + jito_prep)`);
    console.log();
    console.log(`  Simulate maliyeti (A−B)    = ${simCost.toFixed(0)}ms`);
    console.log(`  Jito prep maliyeti (C−B)   = ${jitoCost.toFixed(0)}ms`);
    console.log(`  Jito prep doğrudan ölçüm   = ${jpDirect.toFixed(0)}ms`);
    console.log(`  Kalan (quote+build base)   = ${d2sB.toFixed(0)}ms`);
    console.log();
    console.log(`  Toplam rekonstrüksiyon: ~${(d2sB + simCost + jitoCost).toFixed(0)}ms (base + sim + jito)`);
  }

  // ── Sonuç yorumu ──
  console.log();
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  SONUÇ:`);
  if (statsB.count > 0 && statsC.count > 0) {
    const d2sB = median(statsB.d2sLatency);
    const d2sC = median(statsC.d2sLatency);
    const jitoOverhead = d2sC - d2sB;
    const jpDirect = statsC.jitoPrepLatency.length > 0 ? median(statsC.jitoPrepLatency) : 0;
    const pctIncrease = d2sB > 0 ? (jitoOverhead / d2sB) * 100 : 0;

    console.log(`  detectToSendLatencyMs: B=${d2sB.toFixed(0)}ms → C=${d2sC.toFixed(0)}ms (+${pctIncrease.toFixed(1)}% artış)`);
    console.log(`  jitoPrepLatencyMs (doğrudan): median=${jpDirect.toFixed(0)}ms`);

    if (jpDirect > 200) {
      console.log(`  ✗ Jito prep YÜKSEK MALİYETLİ (${jpDirect.toFixed(0)}ms) — D2S'ye ciddi katkı.`);
      console.log(`  → Optimize hedefleri: getLatestBlockhash cache, tip account cache, paralel sign.`);
    } else if (jpDirect > 80) {
      console.log(`  ~ Jito prep ORTA MALİYETLİ (${jpDirect.toFixed(0)}ms) — göz ardı edilemez.`);
      console.log(`  → Blockhash ve tip account ön-fetch ile azaltılabilir.`);
    } else {
      console.log(`  ✓ Jito prep DÜŞÜK MALİYETLİ (${jpDirect.toFixed(0)}ms) — D2S'ye minimal katkı.`);
      console.log(`  → Jito bundle kullanımı latency açısından güvenli.`);
    }
  } else {
    console.log(`  Karşılaştırma için hem B hem C verisi gerekiyor.`);
  }
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
