/**
 * Stage 2 — Focused 12h Micro-Run Analyzer
 *
 * Analyzes quote-only watch data with deterministic window split (6h/6h)
 * to determine if edge is "structural" (consistent) vs "transient" (spike).
 *
 * Input:
 *   --input <dir>    Stage2 output directory containing:
 *                    - arb_watch_*.jsonl (hourly rotated)
 *                    - arb_watch_invalid_*.jsonl
 *                    - arb_events.jsonl
 *                    - stage2_config.json
 *
 * Output:
 *   stage2_summary.json in input dir
 *
 * Window Split:
 *   - Window A: [t0, t0+6h)
 *   - Window B: [t0+6h, tEnd)
 *
 * PASS criteria (edge is structural):
 *   1. Health: validRate_topN >= 40%
 *   2. Core: events_T2_total >= 10
 *   3. No severe decay: D2 >= 0.5 × D1
 *      - D1 = eventsPerHour_T2(Window A)
 *      - D2 = eventsPerHour_T2(Window B)
 *   4. Top3 quality drift check:
 *      - p95PeakBps(Window B) >= 0.7 × p95PeakBps(Window A)
 *      - medianDurationMs(Window B) >= 3000ms
 *
 * Usage:
 *   npx tsx src/scripts/stage2Analyze.ts --input data/m3_stage2_12h/<timestamp>/
 *   npm run stage2:analyze -- --input data/m3_stage2_12h/<timestamp>/
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface Stage2Config {
  runId: string;
  durationHours: number;
  surfaceSymbols: string[];
  thresholds: {
    T1_bps: number;
    T2_bps: number;
  };
  excludeSymbols: string[];
  mode: "quote_only";
  outputDir: string;
}

interface ArbEvent {
  eventId: string;
  pairId: string;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  peakBps: number;
  peakUsdc: number;
  peakTs: number;
  sampleCount: number;
  validSamples: number;
}

interface ValidSample {
  ts: number;
  tickId: number;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  netProfitBps: number;
  netProfitUsdc: number;
  buyDex: string;
  sellDex: string;
  buyOutUnits: string;
  sellOutUnits: string;
}

interface InvalidSample {
  ts: number;
  tickId: number;
  pairId: string;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  invalidReason: string;
  invalidRule: string;
}

interface WindowMetrics {
  windowId: "A" | "B";
  startTs: number;
  endTs: number;
  durationHours: number;
  events_T1_count: number;
  events_T2_count: number;          // From arb_events (peakBps >= T1)
  samples_T2_count: number;         // NEW: From raw samples (netProfitBps >= T2)
  eventsPerHour_T1: number;
  eventsPerHour_T2: number;         // Based on samples_T2_count (reconstructed)
  totalValidSamples: number;
  totalInvalidSamples: number;
  validRate: number;                // Top3 subset only
  top3_p95PeakBps: number;
  top3_medianDurationMs: number;
  quoteFailRate: number;
  pairBreakdown: PairWindowStats[];
}

interface PairWindowStats {
  baseSymbol: string;
  baseMint: string;
  events_T1: number;
  events_T2: number;
  p95PeakBps: number;
  medianDurationMs: number;
  validRate: number;
}

interface Stage2Summary {
  runId: string;
  generatedAt: string;
  verdict: "PASS" | "FAIL";
  verdictReason: string;
  runStartTs: number;
  runEndTs: number;
  totalDurationHours: number;
  splitTs: number;  // t0 + 6h
  windowA: WindowMetrics;
  windowB: WindowMetrics;
  combined: {
    events_T1_total: number;
    events_T2_total: number;
    validRate_total: number;
    top3_p95PeakBps: number;
    top3_medianDurationMs: number;
  };
  decayAnalysis: {
    D1: number;  // eventsPerHour_T2 Window A
    D2: number;  // eventsPerHour_T2 Window B
    decayRatio: number;  // D2 / D1
    severeDecay: boolean;  // D2 < 0.5 * D1
  };
  qualityDrift: {
    p95RatioBA: number;
    medianDurationB: number;
    driftDetected: boolean;
  };
  passChecks: {
    healthPass: boolean;
    corePass: boolean;
    decayPass: boolean;
    qualityPass: boolean;
  };
  surfaceSymbols: string[];
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

const INPUT_DIR = getArgStr("--input", "");

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

/** Calculate percentile from sorted array */
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

/** Calculate median */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Safe min/max for large arrays (avoids stack overflow with spread) */
function minMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0];
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

/** Read JSONL file */
async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

/** Glob-like file listing */
async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => pattern.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
//  Main Analysis
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Stage 2 — Focused 12h Micro-Run Analyzer                    ║
╚══════════════════════════════════════════════════════════════╝
`);

  if (!INPUT_DIR) {
    console.error("  ✗ --input <dir> is required");
    console.error("    Usage: npx tsx src/scripts/stage2Analyze.ts --input <stage2_output_dir>");
    process.exit(1);
  }

  const inputDir = path.resolve(process.cwd(), INPUT_DIR);

  // ── Load Stage2 config ──
  const configPath = path.join(inputDir, "stage2_config.json");
  let config: Stage2Config;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as Stage2Config;
    console.log(`  ✓ Config loaded: ${config.runId}`);
  } catch {
    console.error(`  ✗ Failed to load stage2_config.json from ${inputDir}`);
    process.exit(1);
  }

  // ── Load events ──
  const eventsPath = path.join(inputDir, "arb_events.jsonl");
  const events = await readJsonl<ArbEvent>(eventsPath);
  console.log(`  ✓ Events loaded: ${events.length}`);

  if (events.length === 0) {
    console.error("  ✗ No events found. Run may not have completed.");
    process.exit(1);
  }

  // ── Load valid samples ──
  const watchFiles = await listFiles(inputDir, /^arb_watch_\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/);
  let allValidSamples: ValidSample[] = [];
  for (const f of watchFiles) {
    const samples = await readJsonl<ValidSample>(f);
    allValidSamples = allValidSamples.concat(samples);
  }
  console.log(`  ✓ Valid samples loaded: ${allValidSamples.length}`);

  // ── Load invalid samples ──
  const invalidFiles = await listFiles(inputDir, /^arb_watch_invalid_.*\.jsonl$/);
  let allInvalidSamples: InvalidSample[] = [];
  for (const f of invalidFiles) {
    const samples = await readJsonl<InvalidSample>(f);
    allInvalidSamples = allInvalidSamples.concat(samples);
  }
  console.log(`  ✓ Invalid samples loaded: ${allInvalidSamples.length}`);

  // ── Determine run time range ──
  const allTs = [
    ...events.map((e) => e.startTs),
    ...events.map((e) => e.endTs),
    ...allValidSamples.map((s) => s.ts),
    ...allInvalidSamples.map((s) => s.ts),
  ].filter((t) => t > 0);

  const { min: runStartTs, max: runEndTs } = minMax(allTs);
  const totalDurationMs = runEndTs - runStartTs;
  const totalDurationHours = totalDurationMs / (1000 * 60 * 60);

  console.log(`  ✓ Run range: ${new Date(runStartTs).toISOString()} → ${new Date(runEndTs).toISOString()}`);
  console.log(`  ✓ Total duration: ${totalDurationHours.toFixed(2)} hours`);

  // ── Deterministic window split ──
  const splitMs = 6 * 60 * 60 * 1000; // 6 hours
  const splitTs = runStartTs + splitMs;

  console.log(`  ✓ Split timestamp: ${new Date(splitTs).toISOString()}`);
  console.log(`    Window A: [${new Date(runStartTs).toISOString()}, ${new Date(splitTs).toISOString()})`);
  console.log(`    Window B: [${new Date(splitTs).toISOString()}, ${new Date(runEndTs).toISOString()})`);

  // ── Thresholds ──
  const T1_BPS = config.thresholds.T1_bps;
  const T2_BPS = config.thresholds.T2_bps;

  // ── Split events into windows ──
  const eventsA = events.filter((e) => e.startTs < splitTs);
  const eventsB = events.filter((e) => e.startTs >= splitTs);

  // ── Split samples into windows ──
  const validA = allValidSamples.filter((s) => s.ts < splitTs);
  const validB = allValidSamples.filter((s) => s.ts >= splitTs);
  const invalidA = allInvalidSamples.filter((s) => s.ts < splitTs);
  const invalidB = allInvalidSamples.filter((s) => s.ts >= splitTs);

  // ── Calculate window metrics ──
  function calcWindowMetrics(
    windowId: "A" | "B",
    wEvents: ArbEvent[],
    wValid: ValidSample[],
    wInvalid: InvalidSample[],
    wStartTs: number,
    wEndTs: number,
  ): WindowMetrics {
    const durationHours = (wEndTs - wStartTs) / (1000 * 60 * 60);

    // Surface symbols for Top3 filtering
    const surfaceSet = new Set(config.surfaceSymbols.map((s) => s.toUpperCase()));

    // Filter samples to Top3 only for validRate calculation
    const top3Valid = wValid.filter((s) => surfaceSet.has(s.baseSymbol.toUpperCase()));
    const top3Invalid = wInvalid.filter((s) => surfaceSet.has(s.baseSymbol.toUpperCase()));

    // Event counts (from arb_events - these are T1 events that peaked >= T1_BPS)
    const events_T1 = wEvents.filter((e) => e.peakBps >= T1_BPS);
    const events_T2_fromEvents = wEvents.filter((e) => e.peakBps >= T2_BPS);

    // ═══ CRITICAL: T2 reconstruction from raw samples ═══
    // Each valid sample with netProfitBps >= T2_BPS counts as a T2 observation
    // This is the TRUE T2 count, not derived from T1 events
    const samples_T2 = top3Valid.filter((s) => s.netProfitBps >= T2_BPS);

    // Valid rate: Top3 subset only (as per spec)
    const top3TotalSamples = top3Valid.length + top3Invalid.length;
    const validRate = top3TotalSamples > 0 ? top3Valid.length / top3TotalSamples : 0;

    // Quote fail rate (Top3 only)
    const quoteFails = top3Invalid.filter((s) => s.invalidRule === "QUOTE_FAIL");
    const quoteFailRate = top3Invalid.length > 0 ? quoteFails.length / top3Invalid.length : 0;

    // Top3 metrics from events (for p95 and duration)
    const peakBpsArr = wEvents.map((e) => e.peakBps).sort((a, b) => a - b);
    const durationMsArr = wEvents.map((e) => e.durationMs).sort((a, b) => a - b);

    // Per-pair breakdown
    const pairMap = new Map<string, { events: ArbEvent[]; valid: ValidSample[]; invalid: InvalidSample[] }>();

    for (const sym of config.surfaceSymbols) {
      pairMap.set(sym.toUpperCase(), { events: [], valid: [], invalid: [] });
    }

    for (const e of wEvents) {
      const sym = e.baseSymbol.toUpperCase();
      if (pairMap.has(sym)) {
        pairMap.get(sym)!.events.push(e);
      }
    }
    for (const s of wValid) {
      const sym = s.baseSymbol.toUpperCase();
      if (pairMap.has(sym)) {
        pairMap.get(sym)!.valid.push(s);
      }
    }
    for (const s of wInvalid) {
      const sym = s.baseSymbol.toUpperCase();
      if (pairMap.has(sym)) {
        pairMap.get(sym)!.invalid.push(s);
      }
    }

    const pairBreakdown: PairWindowStats[] = [];
    for (const [sym, data] of pairMap) {
      const pairPeaks = data.events.map((e) => e.peakBps).sort((a, b) => a - b);
      const pairDurations = data.events.map((e) => e.durationMs);
      const pairTotal = data.valid.length + data.invalid.length;

      pairBreakdown.push({
        baseSymbol: sym,
        baseMint: data.events[0]?.baseMint || "",
        events_T1: data.events.filter((e) => e.peakBps >= T1_BPS).length,
        events_T2: data.events.filter((e) => e.peakBps >= T2_BPS).length,
        p95PeakBps: pairPeaks.length > 0 ? percentile(pairPeaks, 95) : 0,
        medianDurationMs: median(pairDurations),
        validRate: pairTotal > 0 ? data.valid.length / pairTotal : 0,
      });
    }

    return {
      windowId,
      startTs: wStartTs,
      endTs: wEndTs,
      durationHours,
      events_T1_count: events_T1.length,
      events_T2_count: events_T2_fromEvents.length,   // From events (legacy)
      samples_T2_count: samples_T2.length,            // From raw samples (CORRECT)
      eventsPerHour_T1: durationHours > 0 ? events_T1.length / durationHours : 0,
      eventsPerHour_T2: durationHours > 0 ? samples_T2.length / durationHours : 0,  // Use reconstructed T2
      totalValidSamples: top3Valid.length,            // Top3 only
      totalInvalidSamples: top3Invalid.length,        // Top3 only
      validRate,                                       // Top3 subset
      top3_p95PeakBps: percentile(peakBpsArr, 95),
      top3_medianDurationMs: median(durationMsArr),
      quoteFailRate,
      pairBreakdown,
    };
  }

  const windowA = calcWindowMetrics("A", eventsA, validA, invalidA, runStartTs, splitTs);
  const windowB = calcWindowMetrics("B", eventsB, validB, invalidB, splitTs, runEndTs);

  // ── Decay analysis (using reconstructed T2 from samples) ──
  const D1 = windowA.eventsPerHour_T2;  // Now uses samples_T2_count
  const D2 = windowB.eventsPerHour_T2;  // Now uses samples_T2_count
  const decayRatio = D1 > 0 ? D2 / D1 : D2 > 0 ? 1 : 0;
  const severeDecay = D2 < 0.5 * D1;

  // ── Quality drift analysis ──
  // Minimum p95 threshold guard: if Window A p95 < 5bps, use absolute comparison
  const MIN_P95_THRESHOLD = 5; // bps
  const p95RatioBA = windowA.top3_p95PeakBps >= MIN_P95_THRESHOLD
    ? windowB.top3_p95PeakBps / windowA.top3_p95PeakBps
    : windowB.top3_p95PeakBps >= MIN_P95_THRESHOLD ? 1 : 0;
  const medianDurationB = windowB.top3_medianDurationMs;
  const driftDetected = p95RatioBA < 0.7 || medianDurationB < 3000;

  // ── Combined metrics (Top3 subset only) ──
  const surfaceSet = new Set(config.surfaceSymbols.map((s) => s.toUpperCase()));
  const top3AllValid = allValidSamples.filter((s) => surfaceSet.has(s.baseSymbol.toUpperCase()));
  const top3AllInvalid = allInvalidSamples.filter((s) => surfaceSet.has(s.baseSymbol.toUpperCase()));

  // T2 reconstruction from raw samples (CORRECT method)
  const samples_T2_total = top3AllValid.filter((s) => s.netProfitBps >= T2_BPS).length;

  const allPeaks = events.map((e) => e.peakBps).sort((a, b) => a - b);
  const allDurations = events.map((e) => e.durationMs);
  const top3TotalSamples = top3AllValid.length + top3AllInvalid.length;

  const combined = {
    events_T1_total: events.filter((e) => e.peakBps >= T1_BPS).length,
    events_T2_total: samples_T2_total,  // FIXED: From raw samples, not events
    validRate_total: top3TotalSamples > 0 ? top3AllValid.length / top3TotalSamples : 0,  // FIXED: Top3 only
    top3_p95PeakBps: percentile(allPeaks, 95),
    top3_medianDurationMs: median(allDurations),
  };

  // ══════════════════════════════════════════════════════════════
  //  PASS / FAIL Checks
  // ══════════════════════════════════════════════════════════════

  // 1. Health: validRate_topN >= 40% (Top3 subset)
  const healthPass = combined.validRate_total >= 0.40;

  // 2. Core: events_T2_total >= 10 (reconstructed from samples)
  const corePass = combined.events_T2_total >= 10;

  // 3. No severe decay: D2 >= 0.5 × D1
  const decayPass = !severeDecay;

  // 4. Quality drift: p95Ratio >= 0.7 AND medianDuration >= 3000ms
  const qualityPass = !driftDetected;

  // Final verdict
  const allPass = healthPass && corePass && decayPass && qualityPass;
  const verdict: "PASS" | "FAIL" = allPass ? "PASS" : "FAIL";

  // Build reason string
  const failReasons: string[] = [];
  if (!healthPass) failReasons.push(`validRate ${(combined.validRate_total * 100).toFixed(1)}% < 40%`);
  if (!corePass) failReasons.push(`samples_T2=${combined.events_T2_total} < 10`);
  if (!decayPass) failReasons.push(`severe decay: D2/D1=${decayRatio.toFixed(2)} < 0.5`);
  if (!qualityPass) {
    if (p95RatioBA < 0.7) failReasons.push(`p95 drift: ${(p95RatioBA * 100).toFixed(1)}% < 70%`);
    if (medianDurationB < 3000) failReasons.push(`medianDuration(B)=${medianDurationB.toFixed(0)}ms < 3000ms`);
  }

  const verdictReason = allPass
    ? "Edge is structural: consistent across 6h windows"
    : `Edge NOT structural: ${failReasons.join("; ")}`;

  // ══════════════════════════════════════════════════════════════
  //  Build Summary
  // ══════════════════════════════════════════════════════════════

  const summary: Stage2Summary = {
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    verdict,
    verdictReason,
    runStartTs,
    runEndTs,
    totalDurationHours,
    splitTs,
    windowA,
    windowB,
    combined,
    decayAnalysis: {
      D1,
      D2,
      decayRatio,
      severeDecay,
    },
    qualityDrift: {
      p95RatioBA,
      medianDurationB,
      driftDetected,
    },
    passChecks: {
      healthPass,
      corePass,
      decayPass,
      qualityPass,
    },
    surfaceSymbols: config.surfaceSymbols,
  };

  // ── Write summary ──
  const summaryPath = path.join(inputDir, "stage2_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  // ══════════════════════════════════════════════════════════════
  //  Console Output
  // ══════════════════════════════════════════════════════════════

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     STAGE 2 ANALYSIS                         ║
╚══════════════════════════════════════════════════════════════╝

  Run ID:          ${config.runId}
  Surface:         [${config.surfaceSymbols.join(", ")}]
  Duration:        ${totalDurationHours.toFixed(2)} hours
  T2 source:       Raw samples (netProfitBps ≥ ${T2_BPS}bps)

  ── Window A (first 6h) ──────────────────────────────────────
  Events T1 (≥${T1_BPS}bps): ${windowA.events_T1_count} (from arb_events)
  Samples T2 (≥${T2_BPS}bps): ${windowA.samples_T2_count} (from raw samples)
  Samples/hour T2: ${windowA.eventsPerHour_T2.toFixed(2)}
  ValidRate:       ${(windowA.validRate * 100).toFixed(1)}% (Top3 only)
  p95 Peak:        ${windowA.top3_p95PeakBps.toFixed(2)} bps
  Median Duration: ${windowA.top3_medianDurationMs.toFixed(0)} ms

  ── Window B (second 6h) ─────────────────────────────────────
  Events T1 (≥${T1_BPS}bps): ${windowB.events_T1_count} (from arb_events)
  Samples T2 (≥${T2_BPS}bps): ${windowB.samples_T2_count} (from raw samples)
  Samples/hour T2: ${windowB.eventsPerHour_T2.toFixed(2)}
  ValidRate:       ${(windowB.validRate * 100).toFixed(1)}% (Top3 only)
  p95 Peak:        ${windowB.top3_p95PeakBps.toFixed(2)} bps
  Median Duration: ${windowB.top3_medianDurationMs.toFixed(0)} ms

  ── Combined (Top3 subset) ───────────────────────────────────
  Total T1 events: ${combined.events_T1_total}
  Total T2 samples:${combined.events_T2_total} (reconstructed)
  ValidRate:       ${(combined.validRate_total * 100).toFixed(1)}%
  p95 Peak:        ${combined.top3_p95PeakBps.toFixed(2)} bps
  Median Duration: ${combined.top3_medianDurationMs.toFixed(0)} ms

  ── Decay Analysis (T2 samples/hour) ─────────────────────────
  D1 (A):          ${D1.toFixed(2)} samples/hour
  D2 (B):          ${D2.toFixed(2)} samples/hour
  D2/D1:           ${decayRatio.toFixed(2)} (${severeDecay ? "⚠ SEVERE DECAY" : "✓ OK"})

  ── Quality Drift ────────────────────────────────────────────
  p95 Ratio (B/A): ${(p95RatioBA * 100).toFixed(1)}% ${p95RatioBA < 0.7 ? "⚠ DRIFT" : "✓ OK"}
  MedianDur (B):   ${medianDurationB.toFixed(0)} ms ${medianDurationB < 3000 ? "⚠ TOO SHORT" : "✓ OK"}

  ── Pass Checks ──────────────────────────────────────────────
  [${healthPass ? "✓" : "✗"}] Health (validRate ≥ 40%, Top3)
  [${corePass ? "✓" : "✗"}] Core (samples_T2 ≥ 10)
  [${decayPass ? "✓" : "✗"}] Decay (D2 ≥ 0.5 × D1)
  [${qualityPass ? "✓" : "✗"}] Quality (no drift)

╔══════════════════════════════════════════════════════════════╗
║  STAGE 2 VERDICT: ${verdict === "PASS" ? "PASS ✓" : "FAIL ✗"}${" ".repeat(37 - verdict.length)}║
╚══════════════════════════════════════════════════════════════╝

  ${verdictReason}

  Summary written: ${summaryPath}
`);

  // Exit code for CI/automation
  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("Stage2 analyze failed:", err);
  process.exit(1);
});
