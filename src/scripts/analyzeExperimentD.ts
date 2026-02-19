/**
 * EXPERIMENT MODE D — SIMULATE_ON + JITO_PREP Offline Latency Analysis
 *
 * logs/trades.jsonl dosyasından EXPERIMENT_D kayıtlarını okur,
 * simulate + Jito prep birleşik maliyetini ve split timer ayrıştırmasını analiz eder.
 *
 * Kullanım:
 *   npx tsx src/scripts/analyzeExperimentD.ts
 *
 * Çıktı:
 *   - EXPERIMENT_D_NO_OPP vs EXPERIMENT_D_READY sayıları
 *   - Split timer istatistikleri: buildOnlyMs vs simulateOnlyMs
 *   - Jito prep sub-timing breakdown
 *   - Top 3 outlier kayıtları (D2S ile) — spike attribution
 *   - Tail spike kaynağı: simulate mi, Jito prep mi?
 *
 * Beklenen deneysel akış (kümülatif):
 *   A — Jupiter-only (OKX izole edildi)
 *   B — Jupiter-only + no-simulate (simulate izole edildi)
 *   C — Jupiter-only + no-simulate + Jito prep (Jito prep maliyeti ölçüldü)
 *   D — Jupiter-only + simulate ON + Jito prep (research-realistic)
 *
 * Mode D runtime flags:
 *   DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true EXPERIMENT_NO_SIMULATE=false EXPERIMENT_JITO_PREP=true npm start
 */

import { promises as fs } from "fs";
import path from "path";

// ── Interfaces ──

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

// ── Stats Helpers ──

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

function printRow(label: string, arr: number[]) {
  if (arr.length === 0) {
    console.log(`  ${label.padEnd(24)} (veri yok)`);
    return;
  }
  console.log(
    `  ${label.padEnd(24)} ` +
      `mean=${mean(arr).toFixed(0).padStart(6)}ms  ` +
      `median=${median(arr).toFixed(0).padStart(6)}ms  ` +
      `p90=${percentile(arr, 90).toFixed(0).padStart(6)}ms  ` +
      `p95=${percentile(arr, 95).toFixed(0).padStart(6)}ms  ` +
      `min=${Math.min(...arr).toFixed(0).padStart(6)}ms  ` +
      `max=${Math.max(...arr).toFixed(0).padStart(6)}ms`
  );
}

// ── Main ──

async function main() {
  const logsFile = path.resolve(process.cwd(), "logs", "trades.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(logsFile, "utf-8");
  } catch {
    console.error(`[ERROR] ${logsFile} okunamadı. Önce experiment D'yi çalıştırın.`);
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

  // Filter Experiment D records
  const expD = all.filter(
    (r) =>
      r.experimentMode === "EXPERIMENT_D" ||
      r.status === "EXPERIMENT_D_READY" ||
      r.status === "EXPERIMENT_D_NO_OPP"
  );

  const noOpp = expD.filter((r) => r.status === "EXPERIMENT_D_NO_OPP");
  const ready = expD.filter((r) => r.status === "EXPERIMENT_D_READY");
  const withLatency = ready.filter((r) => r.latencyMetrics);

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  EXPERIMENT D — SIMULATE_ON + JITO_PREP Latency Analysis`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Toplam kayıt       : ${expD.length}`);
  console.log(`  NO_OPP             : ${noOpp.length}`);
  console.log(`  READY              : ${ready.length}`);
  console.log(`  READY (latency var): ${withLatency.length}`);

  if (withLatency.length === 0 && noOpp.length === 0) {
    console.error(
      `\n[ERROR] EXPERIMENT_D kaydı bulunamadı.\n` +
        `  Deney koşmak için:\n` +
        `  DRY_RUN=true EXPERIMENT_JUPITER_ONLY=true EXPERIMENT_NO_SIMULATE=false EXPERIMENT_JITO_PREP=true npm start`
    );
    process.exit(1);
  }

  // ── NO_OPP cycles — quote latency only ──
  if (noOpp.length > 0) {
    const noOppQuote = noOpp
      .filter((r) => r.latencyMetrics)
      .map((r) => r.latencyMetrics!.quoteLatencyMs);
    console.log(`\n  ── NO_OPP Cycles (${noOpp.length} kayıt) ──`);
    printRow("quoteLatencyMs", noOppQuote);
  }

  if (withLatency.length === 0) {
    console.log(`\n  [WARN] EXPERIMENT_D_READY kaydı yok — detaylı analiz yapılamıyor.`);
    console.log(`═══════════════════════════════════════════════════════════════\n`);
    return;
  }

  // ── Latency extraction ──
  const quoteLatency = withLatency.map((r) => r.latencyMetrics!.quoteLatencyMs);
  const buildLatency = withLatency.map((r) => r.latencyMetrics!.buildLatencyMs);
  const simLatency = withLatency.map((r) => r.latencyMetrics!.simulationLatencyMs);
  const jitoPrepLatency = withLatency
    .map((r) => r.latencyMetrics!.jitoPrepLatencyMs)
    .filter((v): v is number => v != null && v > 0);
  const d2sLatency = withLatency.map((r) => r.latencyMetrics!.detectToSendLatencyMs);
  const q2sLatency = withLatency.map((r) => r.latencyMetrics!.quoteToSendLatencyMs);

  // Jito prep sub-timings
  const blockhashFetch = withLatency
    .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.blockhashFetchMs)
    .filter((v): v is number => v != null);
  const tipAccountsFetch = withLatency
    .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.tipAccountsFetchMs)
    .filter((v): v is number => v != null);
  const bundleBuild = withLatency
    .map((r) => r.latencyMetrics!.jitoPrepSubTimings?.bundleBuildMs)
    .filter((v): v is number => v != null);

  // Jito prep counts
  const jitoPrepAttemptedCount = withLatency.filter((r) => r.latencyMetrics!.jitoPrepAttempted === true).length;
  const jitoPrepSkippedCount = withLatency.filter((r) => r.latencyMetrics!.jitoPrepAttempted === false).length;
  const jitoPrepErrorCount = withLatency.filter((r) => r.latencyMetrics!.jitoPrepSkippedReason === "ERROR").length;

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  READY Cycles — Full Latency Stats                          ║
  // ╚══════════════════════════════════════════════════════════════╝
  console.log(`\n  ── READY Cycles Latency (${withLatency.length} kayıt) ──`);
  printRow("quoteLatencyMs", quoteLatency);
  printRow("buildLatencyMs (split)", buildLatency);
  printRow("simulationLatencyMs", simLatency);
  printRow("jitoPrepLatencyMs", jitoPrepLatency);
  printRow("detectToSendLatencyMs", d2sLatency);
  printRow("quoteToSendLatencyMs", q2sLatency);

  console.log(`\n  Jito Prep: attempted=${jitoPrepAttemptedCount} | skipped=${jitoPrepSkippedCount} | error=${jitoPrepErrorCount}`);

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Build vs Simulate Split Analysis                            ║
  // ╚══════════════════════════════════════════════════════════════╝
  console.log(`\n  ── Build vs Simulate Split Timer Analysis ──`);
  if (buildLatency.length > 0 && simLatency.length > 0) {
    const buildMedian = median(buildLatency);
    const simMedian = median(simLatency);
    const totalBuildSim = buildMedian + simMedian;
    const buildPct = totalBuildSim > 0 ? ((buildMedian / totalBuildSim) * 100).toFixed(1) : "0";
    const simPct = totalBuildSim > 0 ? ((simMedian / totalBuildSim) * 100).toFixed(1) : "0";

    console.log(
      `  buildOnlyMs   median=${buildMedian.toFixed(0)}ms  (${buildPct}% of build+sim)`
    );
    console.log(
      `  simulateOnlyMs  median=${simMedian.toFixed(0)}ms  (${simPct}% of build+sim)`
    );
    console.log(
      `  build+sim total median=${totalBuildSim.toFixed(0)}ms`
    );
  }

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Jito Prep Sub-Timing Breakdown                              ║
  // ╚══════════════════════════════════════════════════════════════╝
  if (jitoPrepLatency.length > 0) {
    console.log(`\n  ── Jito Prep Sub-Timing Breakdown ──`);
    printRow("blockhashFetchMs", blockhashFetch);
    printRow("tipAccountsFetchMs", tipAccountsFetch);
    printRow("bundleBuildMs", bundleBuild);

    if (blockhashFetch.length > 0 && tipAccountsFetch.length > 0 && bundleBuild.length > 0) {
      const subSum = median(blockhashFetch) + median(tipAccountsFetch) + median(bundleBuild);
      const jpMedian = median(jitoPrepLatency);
      console.log(
        `\n  Alt adım toplamı (median): ${subSum.toFixed(0)}ms vs total: ${jpMedian.toFixed(0)}ms ` +
          `(fark: ${(jpMedian - subSum).toFixed(0)}ms overhead)`
      );
    }
  }

  // ── Error breakdown ──
  if (jitoPrepErrorCount > 0) {
    const errorRecords = withLatency.filter((r) => r.latencyMetrics!.jitoPrepSkippedReason === "ERROR");
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

    console.log(`\n  ── Jito Prep Error Breakdown ──`);
    console.log(`  Hata sayısı: ${jitoPrepErrorCount}`);
    console.log(`  Stage dağılımı:`);
    for (const [stage, count] of Object.entries(errorsByStage).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / jitoPrepErrorCount) * 100).toFixed(1);
      console.log(`    ${stage.padEnd(20)} ${String(count).padStart(5)} (%${pct})`);
    }
    console.log(`  Error code dağılımı:`);
    for (const [code, count] of Object.entries(errorsByCode).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / jitoPrepErrorCount) * 100).toFixed(1);
      console.log(`    ${code.padEnd(30)} ${String(count).padStart(5)} (%${pct})`);
    }
    const uniqueMsgs = [...new Set(errorMessages)];
    if (uniqueMsgs.length > 0) {
      console.log(`  Benzersiz hata mesajları (ilk ${Math.min(5, uniqueMsgs.length)}):`);
      for (const msg of uniqueMsgs.slice(0, 5)) {
        console.log(`    • ${msg.slice(0, 120)}${msg.length > 120 ? "…" : ""}`);
      }
    }
  }

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Top 3 Outlier Records — Tail Spike Attribution              ║
  // ╚══════════════════════════════════════════════════════════════╝
  console.log(`\n  ── Top 3 Outlier Records (by detectToSendLatencyMs) ──`);
  const sortedByD2S = [...withLatency].sort(
    (a, b) => (b.latencyMetrics!.detectToSendLatencyMs) - (a.latencyMetrics!.detectToSendLatencyMs)
  );
  const top3 = sortedByD2S.slice(0, 3);

  for (let i = 0; i < top3.length; i++) {
    const r = top3[i];
    const lm = r.latencyMetrics!;
    const jp = lm.jitoPrepLatencyMs ?? 0;
    const components = [
      { name: "quote", val: lm.quoteLatencyMs },
      { name: "build", val: lm.buildLatencyMs },
      { name: "simulate", val: lm.simulationLatencyMs },
      { name: "jitoPrep", val: jp },
    ];
    const maxComponent = components.reduce((a, b) => b.val > a.val ? b : a);

    console.log(
      `\n  #${i + 1} — D2S=${lm.detectToSendLatencyMs}ms | ${r.timestamp}`
    );
    console.log(
      `    quote=${lm.quoteLatencyMs}ms  build=${lm.buildLatencyMs}ms  ` +
        `sim=${lm.simulationLatencyMs}ms  jitoPrep=${jp}ms`
    );
    if (lm.jitoPrepSubTimings) {
      const st = lm.jitoPrepSubTimings;
      console.log(
        `    jito-sub: blockhash=${st.blockhashFetchMs}ms  tipAccounts=${st.tipAccountsFetchMs}ms  ` +
          `bundleBuild=${st.bundleBuildMs}ms`
      );
    }
    console.log(
      `    → Spike attribution: ${maxComponent.name} (${maxComponent.val}ms, ` +
        `${lm.detectToSendLatencyMs > 0 ? ((maxComponent.val / lm.detectToSendLatencyMs) * 100).toFixed(1) : 0}% of D2S)`
    );
  }

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Tail Attribution Summary (p95+ records)                     ║
  // ╚══════════════════════════════════════════════════════════════╝
  const p95Threshold = percentile(d2sLatency, 95);
  const tailRecords = withLatency.filter(
    (r) => r.latencyMetrics!.detectToSendLatencyMs >= p95Threshold
  );

  if (tailRecords.length > 0) {
    console.log(`\n  ── Tail Attribution (D2S >= p95 = ${p95Threshold.toFixed(0)}ms, ${tailRecords.length} kayıt) ──`);
    const attribution: Record<string, number> = { quote: 0, build: 0, simulate: 0, jitoPrep: 0 };

    for (const r of tailRecords) {
      const lm = r.latencyMetrics!;
      const jp = lm.jitoPrepLatencyMs ?? 0;
      const components = [
        { name: "quote", val: lm.quoteLatencyMs },
        { name: "build", val: lm.buildLatencyMs },
        { name: "simulate", val: lm.simulationLatencyMs },
        { name: "jitoPrep", val: jp },
      ];
      const maxComponent = components.reduce((a, b) => b.val > a.val ? b : a);
      attribution[maxComponent.name] = (attribution[maxComponent.name] ?? 0) + 1;
    }

    for (const [comp, count] of Object.entries(attribution).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / tailRecords.length) * 100).toFixed(1);
      console.log(`    ${comp.padEnd(16)} ${String(count).padStart(4)} kayıt  (%${pct})`);
    }
  }

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  Cross-Experiment Comparison (A, B, C, D)                    ║
  // ╚══════════════════════════════════════════════════════════════╝
  const expA = all.filter(
    (r) => r.experimentMode === "JUPITER_ONLY" || r.status === "EXPERIMENT_JUPITER_ONLY"
  );
  const expB = all.filter(
    (r) => r.experimentMode === "NO_SIMULATE" || r.status === "EXPERIMENT_NO_SIMULATE"
  );
  const expC = all.filter(
    (r) => r.experimentMode === "JITO_PREP" || r.status === "EXPERIMENT_JITO_PREP"
  );

  const d2sA = expA.filter((r) => r.latencyMetrics).map((r) => r.latencyMetrics!.detectToSendLatencyMs);
  const d2sB = expB.filter((r) => r.latencyMetrics).map((r) => r.latencyMetrics!.detectToSendLatencyMs);
  const d2sC = expC.filter((r) => r.latencyMetrics).map((r) => r.latencyMetrics!.detectToSendLatencyMs);

  if (d2sA.length > 0 || d2sB.length > 0 || d2sC.length > 0) {
    console.log(`\n  ── Cross-Experiment D2S Comparison (median) ──`);
    console.log(`  ${"Experiment".padEnd(30)} ${"Count".padStart(6)}  ${"D2S median".padStart(12)}  ${"D2S p95".padStart(10)}`);
    console.log(`  ${"─".repeat(64)}`);

    const printExpRow = (label: string, arr: number[]) => {
      if (arr.length === 0) {
        console.log(`  ${label.padEnd(30)} ${"0".padStart(6)}  ${"n/a".padStart(12)}  ${"n/a".padStart(10)}`);
        return;
      }
      console.log(
        `  ${label.padEnd(30)} ${String(arr.length).padStart(6)}  ${(median(arr).toFixed(0) + "ms").padStart(12)}  ${(percentile(arr, 95).toFixed(0) + "ms").padStart(10)}`
      );
    };

    printExpRow("A (JUPITER_ONLY)", d2sA);
    printExpRow("B (NO_SIMULATE)", d2sB);
    printExpRow("C (JITO_PREP)", d2sC);
    printExpRow("D (SIM_ON + JITO_PREP)", d2sLatency);

    // D decomposition
    if (d2sB.length > 0) {
      const medB = median(d2sB);
      const medD = median(d2sLatency);
      const simMedian = median(simLatency);
      const jpMedian = jitoPrepLatency.length > 0 ? median(jitoPrepLatency) : 0;
      const overhead = medD - medB - simMedian - jpMedian;

      console.log(`\n  ── D Decomposition (vs B baseline) ──`);
      console.log(`  D median D2S = ${medD.toFixed(0)}ms`);
      console.log(`  B median D2S = ${medB.toFixed(0)}ms (base: quote + build)`);
      console.log(`  simulate (split timer) = ${simMedian.toFixed(0)}ms`);
      console.log(`  jitoPrep (doğrudan)    = ${jpMedian.toFixed(0)}ms`);
      console.log(`  overhead / noise       = ${overhead.toFixed(0)}ms`);
      console.log(`  rekonstrüksiyon: ${medB.toFixed(0)} + ${simMedian.toFixed(0)} + ${jpMedian.toFixed(0)} + ${overhead.toFixed(0)} ≈ ${medD.toFixed(0)}ms`);
    }
  }

  // ── Sonuç ──
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  SONUÇ:`);

  const d2sMedian = median(d2sLatency);
  const simMedianFinal = median(simLatency);
  const jpMedianFinal = jitoPrepLatency.length > 0 ? median(jitoPrepLatency) : 0;
  const buildMedianFinal = median(buildLatency);
  const quoteMedianFinal = median(quoteLatency);

  console.log(`  D2S median = ${d2sMedian.toFixed(0)}ms (p95 = ${percentile(d2sLatency, 95).toFixed(0)}ms)`);
  console.log(
    `  Bileşenler: quote=${quoteMedianFinal.toFixed(0)}ms + build=${buildMedianFinal.toFixed(0)}ms + ` +
      `simulate=${simMedianFinal.toFixed(0)}ms + jitoPrep=${jpMedianFinal.toFixed(0)}ms`
  );

  // Find dominant cost
  const costs = [
    { name: "quote", val: quoteMedianFinal },
    { name: "build", val: buildMedianFinal },
    { name: "simulate", val: simMedianFinal },
    { name: "jitoPrep", val: jpMedianFinal },
  ].sort((a, b) => b.val - a.val);

  const dominant = costs[0];
  const dominantPct = d2sMedian > 0 ? ((dominant.val / d2sMedian) * 100).toFixed(1) : "?";
  console.log(
    `  Dominant maliyet: ${dominant.name} = ${dominant.val.toFixed(0)}ms (${dominantPct}% of D2S)`
  );

  if (simMedianFinal > jpMedianFinal * 2) {
    console.log(`  → Tail spike'lar büyük olasılıkla SIMULATE kaynaklı.`);
    console.log(`  → Çözüm: Simulate atlanarak (Mode B/C) veya paralelize ederek azaltılabilir.`);
  } else if (jpMedianFinal > simMedianFinal * 2) {
    console.log(`  → Tail spike'lar büyük olasılıkla JITO_PREP kaynaklı.`);
    console.log(`  → Çözüm: Blockhash/tipAccounts cache, paralel sign.`);
  } else {
    console.log(`  → Simulate ve Jito prep maliyetleri benzer düzeyde — her ikisi de optimize edilmeli.`);
  }

  const noOppPct = expD.length > 0 ? ((noOpp.length / expD.length) * 100).toFixed(1) : "0";
  console.log(`  NO_OPP oranı: ${noOppPct}% (${noOpp.length}/${expD.length})`);

  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
