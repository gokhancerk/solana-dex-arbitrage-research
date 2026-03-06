/**
 * Stage3 — Analyze Re-Quote Samples
 *
 * Reads stage3_samples_*.jsonl files from one or more session directories
 * and computes aggregate metrics for the execution feasibility gate.
 *
 * Metrics:
 *   - retentionRate_150: fraction of positive-edge samples retained at t0+150ms
 *   - medianDecay_150: median decay in bps
 *   - p95Decay_150: 95th percentile decay in bps
 *
 * Gate decision (per ROADMAP spec):
 *   PASS:         retentionRate >= 40% AND medianDecay <= 50 bps
 *   FAIL:         retentionRate < 30% OR medianDecay > 80 bps
 *   INCONCLUSIVE: all other cases
 *
 * Usage:
 *   npx tsx src/scripts/stage3Analyze.ts --dir <session_output_dir>
 *   npx tsx src/scripts/stage3Analyze.ts --dirs <dir1,dir2,dir3>
 *   npm run stage3:analyze -- --dir <output_dir>
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface Stage3Sample {
  timestampUTC: string;
  ts: number;
  symbol: string;
  pairId: string;
  notional: number;
  direction: "O_TO_R" | "R_TO_O";
  quotedBps_0: number;
  quotedBps_150: number;
  decayBps: number;
  retained: boolean;
  orcaOutUnits_0: string;
  orcaOutUnits_150: string;
  invalidReason?: string;
}

interface SymbolMetrics {
  samples: number;
  retentionRate: number;
  medianDecay: number;
}

interface Stage3Summary {
  generatedAt: string;
  sessionsIncluded: string[];
  totalSamples: number;
  retainedSamples: number;
  retentionRate_150: number;       // 0-1
  medianDecay_150: number;         // bps
  p95Decay_150: number;            // bps
  bySymbol: Record<string, SymbolMetrics>;
  gate: "PASS" | "FAIL" | "INCONCLUSIVE";
  gateNarrative: string;
  failType?: "LATENCY_FRAGILITY" | "DECAY_MAGNITUDE";
}

// ══════════════════════════════════════════════════════════════
//  CLI Args
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

function getArgStr(name: string, def: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}

const DIR_ARG = getArgStr("--dir", "");
const DIRS_ARG = getArgStr("--dirs", "");

// ══════════════════════════════════════════════════════════════
//  Stats Helpers
// ══════════════════════════════════════════════════════════════

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ══════════════════════════════════════════════════════════════
//  Load Samples
// ══════════════════════════════════════════════════════════════

async function loadSamplesFromDir(dir: string): Promise<Stage3Sample[]> {
  const absDir = path.resolve(process.cwd(), dir);
  const entries = await fs.readdir(absDir);
  const sampleFiles = entries.filter(
    (f) => f.startsWith("stage3_samples_") && f.endsWith(".jsonl"),
  );

  if (sampleFiles.length === 0) {
    console.warn(`  ⚠ No stage3_samples_*.jsonl files found in ${absDir}`);
    return [];
  }

  const samples: Stage3Sample[] = [];
  for (const file of sampleFiles) {
    const filePath = path.join(absDir, file);
    const data = await fs.readFile(filePath, "utf-8");
    const lines = data.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        samples.push(JSON.parse(line) as Stage3Sample);
      } catch {
        // Skip malformed lines
      }
    }
  }

  console.log(
    `  📂 ${dir}: ${sampleFiles.length} file(s), ${samples.length} sample(s)`,
  );
  return samples;
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  Stage3 — Analyze Re-Quote Samples                           ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════╝\n`,
  );

  // ── Resolve directories ──
  const dirs: string[] = [];
  if (DIR_ARG) {
    dirs.push(DIR_ARG);
  } else if (DIRS_ARG) {
    dirs.push(...DIRS_ARG.split(",").map((d) => d.trim()).filter(Boolean));
  } else {
    console.error(
      "  ✗ Specify --dir <session_dir> or --dirs <dir1,dir2,...>",
    );
    process.exit(1);
  }

  console.log(`  Sessions: ${dirs.length}`);
  for (const d of dirs) {
    console.log(`    - ${d}`);
  }
  console.log();

  // ── Load all samples ──
  let allSamples: Stage3Sample[] = [];
  for (const dir of dirs) {
    const samples = await loadSamplesFromDir(dir);
    allSamples = allSamples.concat(samples);
  }

  if (allSamples.length === 0) {
    console.error("  ✗ No samples found. Nothing to analyze.");
    process.exit(1);
  }

  console.log(`\n  Total samples: ${allSamples.length}\n`);

  if (allSamples.length === 0) {
    console.error(
      "  ✗ No samples found. Stage3 inconclusive.",
    );
    process.exit(1);
  }

  // ── Compute aggregate metrics ──
  const retainedSamples = allSamples.filter((s) => s.retained).length;
  const retentionRate_150 = allSamples.length > 0
    ? retainedSamples / allSamples.length
    : 0;

  const decayValues = allSamples.map((s) => s.decayBps);
  const medianDecay_150 = Number(median(decayValues).toFixed(2));
  const p95Decay_150 = Number(percentile(decayValues, 95).toFixed(2));

  // ── Per-symbol breakdown ──
  const symbolMap = new Map<string, Stage3Sample[]>();
  for (const s of allSamples) {
    const arr = symbolMap.get(s.symbol) ?? [];
    arr.push(s);
    symbolMap.set(s.symbol, arr);
  }

  const bySymbol: Record<string, SymbolMetrics> = {};
  for (const [symbol, samples] of symbolMap) {
    const symRetained = samples.filter((s) => s.retained).length;
    const symDecays = samples.map((s) => s.decayBps);
    bySymbol[symbol] = {
      samples: samples.length,
      retentionRate: Number(
        (samples.length > 0 ? symRetained / samples.length : 0).toFixed(4),
      ),
      medianDecay: Number(median(symDecays).toFixed(2)),
    };
  }

  // ── Gate decision (ROADMAP Spec) ──
  let gate: "PASS" | "FAIL" | "INCONCLUSIVE";
  let gateNarrative: string;
  let failType: "LATENCY_FRAGILITY" | "DECAY_MAGNITUDE" | undefined;

  const retPct = (retentionRate_150 * 100).toFixed(1);

  if (retentionRate_150 >= 0.4 && medianDecay_150 <= 50) {
    gate = "PASS";
    gateNarrative = `PASS: retention ${retPct}%, medianDecay ${medianDecay_150} bps`;
  } else if (retentionRate_150 < 0.3 || medianDecay_150 > 80) {
    gate = "FAIL";
    if (retentionRate_150 < 0.3 && medianDecay_150 > 80) {
      failType = "DECAY_MAGNITUDE";
      gateNarrative = `FAIL: retention ${retPct}% (< 30%) AND medianDecay ${medianDecay_150} bps (> 80)`;
    } else if (retentionRate_150 < 0.3) {
      failType = "LATENCY_FRAGILITY";
      gateNarrative = `FAIL: retention ${retPct}% (< 30%) — latency fragility`;
    } else {
      failType = "DECAY_MAGNITUDE";
      gateNarrative = `FAIL: medianDecay ${medianDecay_150} bps (> 80) — decay magnitude`;
    }
  } else {
    gate = "INCONCLUSIVE";
    gateNarrative = `INCONCLUSIVE: retention ${retPct}%, medianDecay ${medianDecay_150} bps — collect 1-2 more sessions`;
  }

  // ── Build summary ──
  const summary: Stage3Summary = {
    generatedAt: new Date().toISOString(),
    sessionsIncluded: dirs,
    totalSamples: allSamples.length,
    retainedSamples,
    retentionRate_150: Number(retentionRate_150.toFixed(4)),
    medianDecay_150,
    p95Decay_150,
    bySymbol,
    gate,
    gateNarrative,
    ...(failType ? { failType } : {}),
  };

  // ── Print results ──
  console.log(`  ─── Stage3 Summary ───────────────────────────────────\n`);
  console.log(`  Total samples:     ${summary.totalSamples}`);
  console.log(`  Retained samples:  ${summary.retainedSamples}`);
  console.log(`  Retention rate:    ${retPct}%`);
  console.log(`  Median decay:      ${summary.medianDecay_150} bps`);
  console.log(`  P95 decay:         ${summary.p95Decay_150} bps`);
  console.log();

  console.log(`  Per-symbol:`);
  for (const [symbol, metrics] of Object.entries(summary.bySymbol)) {
    console.log(
      `    ${symbol}: samples=${metrics.samples} retention=${(metrics.retentionRate * 100).toFixed(1)}% medianDecay=${metrics.medianDecay} bps`,
    );
  }
  console.log();

  console.log(`  ─── Gate Decision ────────────────────────────────────\n`);
  const gateIcon = gate === "PASS" ? "✓" : gate === "FAIL" ? "✗" : "?";
  console.log(`  ${gateIcon} ${gateNarrative}`);
  if (failType) {
    console.log(`  failType: ${failType}`);
  }
  console.log();

  // ── Write summary JSON ──
  // Write to first session directory
  const outputDir = path.resolve(process.cwd(), dirs[0]);
  const summaryPath = path.join(outputDir, "stage3_summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  console.log(`  📝 Summary written: ${summaryPath}\n`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
