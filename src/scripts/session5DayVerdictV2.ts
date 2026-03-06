/**
 * Session Mode v2 — 5-Day Verdict (Edge Workability)
 *
 * v2 focuses on "how many tradeable hours + when" rather than "6h stable edge".
 * Edge is clustered/bursty, not continuous. We quantify:
 *   1. Tradeable minutes/hours per day
 *   2. Peak time-of-day window
 *
 * WORKABILITY CLASSES (based on tradeableHours):
 *   - TRADEABLE: >= 2.0h
 *   - PARTIAL:   0.5h - 2.0h
 *   - NONE:      < 0.5h
 *
 * 5-DAY PASS CONDITIONS (any ONE sufficient):
 *   P1) tradeableDays >= 2
 *   P2) partialOrBetterDays >= 3 AND totalTradeableHours >= 6.0
 *
 * INCONCLUSIVE:
 *   I1) partialOrBetterDays == 2 AND totalTradeableHours in [2.0, 6.0)
 *   I2) partialOrBetterDays >= 3 BUT totalTradeableHours < 6.0
 *
 * FAIL:
 *   F1) partialOrBetterDays <= 1
 *   F2) totalTradeableHours < 2.0
 *
 * Usage:
 *   npx tsx src/scripts/session5DayVerdictV2.ts
 *   npm run session:5day:v2
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface RollingMetric {
  ts: number;
  windowStart: number;
  windowEnd: number;
  validRate: number;
  T2_events: number;
  T2_events_per_hour: number;
  p95Peak: number;
  passStatus: boolean;
}

interface SessionSummary {
  runId: string;
  dateUTC: string;
  dateTRT: string;
  totalScore: number;
  classification: "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME";
  validRate: number;
  passRatio: number;
  rollingWindowsTotal: number;
  rollingWindowsPass: number;
  minutesPass: number;
  sessionMinutes: number;
  T2_per_hour: number;
  p95_bps: number;
}

type WorkabilityClass = "TRADEABLE" | "PARTIAL" | "NONE";

interface DayResult {
  date: string;
  score: number;
  classScore: string;
  tradeableMinutes: number;
  tradeableHours: number;
  workabilityClass: WorkabilityClass;
  rollingWindowsPass: number;
  rollingWindowsTotal: number;
  peakStartUTC: string | null;
  peakEndUTC: string | null;
  peakStartTRT: string | null;
  peakEndTRT: string | null;
  peakBlockMinutes: number;
  peakConcentration: number;
}

interface Aggregates {
  totalTradeableHours: number;
  meanTradeableHours: number;
  medianTradeableHours: number;
  tradeableDays: number;
  partialOrBetterDays: number;
  modalPeakStartUTC: string | null;
  modalPeakEndUTC: string | null;
  peakStabilityDays: number;
}

interface VerdictV2 {
  windowUTC: string;
  windowTRT: string;
  days: DayResult[];
  aggregates: Aggregates;
  verdict: "PASS" | "INCONCLUSIVE" | "FAIL";
  verdictReason: string;
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

const DIRS_ARG = getArgStr("--dirs", "");
const LAST_N = parseInt(getArgStr("--last", "5"), 10);

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

/** Find session directories in archive/ */
async function findSessionDirs(n: number): Promise<string[]> {
  const archiveDir = path.resolve(process.cwd(), "archive");

  try {
    const entries = await fs.readdir(archiveDir, { withFileTypes: true });
    const sessionDirs = entries
      .filter((e) => e.isDirectory() && /_session_v1_[12]$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(-n);

    return sessionDirs.map((d) => path.join(archiveDir, d));
  } catch {
    return [];
  }
}

/** Load session summary */
async function loadSummary(dir: string): Promise<SessionSummary | null> {
  const summaryPath = path.join(dir, "session_summary.json");
  try {
    const raw = await fs.readFile(summaryPath, "utf-8");
    return JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
}

/** Load rolling metrics */
async function loadRollingMetrics(dir: string): Promise<RollingMetric[]> {
  const metricsPath = path.join(dir, "rolling_metrics.jsonl");
  try {
    const raw = await fs.readFile(metricsPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines.map((l) => JSON.parse(l) as RollingMetric);
  } catch {
    return [];
  }
}

/** Format timestamp to UTC time string (HH:MM) */
function tsToUTC(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** Format timestamp to TRT time string (HH:MM) - UTC+3 */
function tsToTRT(ts: number): string {
  const trt = new Date(ts + 3 * 60 * 60 * 1000);
  return trt.toISOString().slice(11, 16);
}

/** Get 30-min bucket for a timestamp (for modal calculation) */
function get30MinBucket(ts: number): string {
  const d = new Date(ts);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes() < 30 ? 0 : 30;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/** Find longest consecutive PASS streak */
function findLongestPassStreak(
  metrics: RollingMetric[]
): { startTs: number; endTs: number; count: number } | null {
  if (metrics.length === 0) return null;

  // Sort by timestamp
  const sorted = [...metrics].sort((a, b) => a.ts - b.ts);

  let bestStart = -1;
  let bestEnd = -1;
  let bestCount = 0;

  let currentStart = -1;
  let currentCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].passStatus) {
      if (currentStart === -1) {
        currentStart = i;
      }
      currentCount++;
    } else {
      if (currentCount > bestCount) {
        bestCount = currentCount;
        bestStart = currentStart;
        bestEnd = i - 1;
      }
      currentStart = -1;
      currentCount = 0;
    }
  }

  // Check final streak
  if (currentCount > bestCount) {
    bestCount = currentCount;
    bestStart = currentStart;
    bestEnd = sorted.length - 1;
  }

  if (bestCount === 0) return null;

  return {
    startTs: sorted[bestStart].windowStart,
    endTs: sorted[bestEnd].windowEnd,
    count: bestCount,
  };
}

/** Determine workability class */
function getWorkabilityClass(tradeableHours: number): WorkabilityClass {
  if (tradeableHours >= 2.0) return "TRADEABLE";
  if (tradeableHours >= 0.5) return "PARTIAL";
  return "NONE";
}

/** Calculate median */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Find modal (most common) value */
function findMode(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of arr) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let maxCount = 0;
  let mode: string | null = null;
  for (const [v, c] of counts) {
    if (c > maxCount) {
      maxCount = c;
      mode = v;
    }
  }
  return mode;
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Session Mode v2 — 5-Day Verdict (Edge Workability)          ║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Determine directories ──
  let dirs: string[];

  if (DIRS_ARG) {
    dirs = DIRS_ARG.split(",").map((d) => path.resolve(process.cwd(), d.trim()));
    console.log(`  ✓ Using ${dirs.length} specified directories`);
  } else {
    dirs = await findSessionDirs(LAST_N);
    console.log(`  ✓ Found ${dirs.length} session directories (last ${LAST_N})`);
  }

  if (dirs.length === 0) {
    console.error(`\n  ✗ No session directories found.`);
    process.exit(1);
  }

  // ── Process each day ──
  const dayResults: DayResult[] = [];
  const peakStarts: { date: string; bucket: string; ts: number }[] = [];

  console.log(`\n  ── Processing Sessions ──────────────────────────────────────\n`);

  for (const dir of dirs) {
    const dirName = path.basename(dir);
    const summary = await loadSummary(dir);

    if (!summary) {
      console.log(`  ✗ ${dirName}: missing session_summary.json`);
      continue;
    }

    const metrics = await loadRollingMetrics(dir);

    // Calculate derived metrics
    const rollingWindowsPass = metrics.filter((m) => m.passStatus).length;
    const rollingWindowsTotal = metrics.length;
    const tradeableMinutes = rollingWindowsPass * 15;
    const tradeableHours = tradeableMinutes / 60;
    const workabilityClass = getWorkabilityClass(tradeableHours);

    // Find peak block
    const peakStreak = findLongestPassStreak(metrics);
    const peakBlockMinutes = peakStreak ? peakStreak.count * 15 : 0;
    const peakConcentration =
      tradeableMinutes > 0 ? peakBlockMinutes / tradeableMinutes : 0;

    const peakStartUTC = peakStreak ? tsToUTC(peakStreak.startTs) : null;
    const peakEndUTC = peakStreak ? tsToUTC(peakStreak.endTs) : null;
    const peakStartTRT = peakStreak ? tsToTRT(peakStreak.startTs) : null;
    const peakEndTRT = peakStreak ? tsToTRT(peakStreak.endTs) : null;

    // Store peak start for modal calculation
    if (peakStreak) {
      peakStarts.push({
        date: summary.dateUTC,
        bucket: get30MinBucket(peakStreak.startTs),
        ts: peakStreak.startTs,
      });
    }

    const day: DayResult = {
      date: summary.dateUTC,
      score: summary.totalScore,
      classScore: summary.classification,
      tradeableMinutes,
      tradeableHours: Math.round(tradeableHours * 100) / 100,
      workabilityClass,
      rollingWindowsPass,
      rollingWindowsTotal,
      peakStartUTC,
      peakEndUTC,
      peakStartTRT,
      peakEndTRT,
      peakBlockMinutes,
      peakConcentration: Math.round(peakConcentration * 1000) / 1000,
    };

    dayResults.push(day);

    // Print day summary
    const classIcon =
      workabilityClass === "TRADEABLE"
        ? "🟢"
        : workabilityClass === "PARTIAL"
        ? "🟡"
        : "🔴";

    const peakInfo = peakStartTRT
      ? `peak=${peakStartTRT}-${peakEndTRT} (${peakBlockMinutes}min)`
      : "no peak";

    console.log(
      `  ${classIcon} ${summary.dateUTC}  ${workabilityClass.padEnd(9)} ` +
        `${tradeableHours.toFixed(1)}h  ${peakInfo}`
    );
  }

  if (dayResults.length === 0) {
    console.error(`\n  ✗ No valid session summaries found.`);
    process.exit(1);
  }

  // ── Calculate aggregates ──
  const tradeableHoursArray = dayResults.map((d) => d.tradeableHours);
  const totalTradeableHours = tradeableHoursArray.reduce((a, b) => a + b, 0);
  const meanTradeableHours = totalTradeableHours / dayResults.length;
  const medianTradeableHours = median(tradeableHoursArray);

  const tradeableDays = dayResults.filter(
    (d) => d.workabilityClass === "TRADEABLE"
  ).length;
  const partialOrBetterDays = dayResults.filter(
    (d) => d.workabilityClass === "TRADEABLE" || d.workabilityClass === "PARTIAL"
  ).length;

  // Modal peak calculation
  const peakBuckets = peakStarts.map((p) => p.bucket);
  const modalPeakStartUTC = findMode(peakBuckets);

  // For modal end, we need to estimate based on typical peak duration
  // Use median peak block duration
  const peakDurations = dayResults
    .filter((d) => d.peakBlockMinutes > 0)
    .map((d) => d.peakBlockMinutes);
  const medianPeakDuration = median(peakDurations);

  let modalPeakEndUTC: string | null = null;
  if (modalPeakStartUTC) {
    const [h, m] = modalPeakStartUTC.split(":").map(Number);
    const startMinutes = h * 60 + m;
    const endMinutes = startMinutes + medianPeakDuration;
    const endH = Math.floor(endMinutes / 60) % 24;
    const endM = endMinutes % 60;
    modalPeakEndUTC = `${endH.toString().padStart(2, "0")}:${endM
      .toString()
      .padStart(2, "0")}`;
  }

  // Peak stability: days with peakStart within ±30min of modal
  let peakStabilityDays = 0;
  if (modalPeakStartUTC) {
    const [modalH, modalM] = modalPeakStartUTC.split(":").map(Number);
    const modalMinutes = modalH * 60 + modalM;

    for (const ps of peakStarts) {
      const [psh, psm] = ps.bucket.split(":").map(Number);
      const psMinutes = psh * 60 + psm;
      if (Math.abs(psMinutes - modalMinutes) <= 30) {
        peakStabilityDays++;
      }
    }
  }

  const aggregates: Aggregates = {
    totalTradeableHours: Math.round(totalTradeableHours * 100) / 100,
    meanTradeableHours: Math.round(meanTradeableHours * 100) / 100,
    medianTradeableHours: Math.round(medianTradeableHours * 100) / 100,
    tradeableDays,
    partialOrBetterDays,
    modalPeakStartUTC,
    modalPeakEndUTC,
    peakStabilityDays,
  };

  // ── Determine verdict ──
  let verdict: "PASS" | "INCONCLUSIVE" | "FAIL";
  let verdictReason: string;

  // PASS conditions
  if (tradeableDays >= 2) {
    verdict = "PASS";
    verdictReason = `P1: tradeableDays=${tradeableDays} >= 2`;
  } else if (partialOrBetterDays >= 3 && totalTradeableHours >= 6.0) {
    verdict = "PASS";
    verdictReason = `P2: partialOrBetterDays=${partialOrBetterDays} >= 3 AND totalTradeableHours=${totalTradeableHours.toFixed(1)} >= 6.0`;
  }
  // FAIL conditions
  else if (partialOrBetterDays <= 1) {
    verdict = "FAIL";
    verdictReason = `F1: partialOrBetterDays=${partialOrBetterDays} <= 1`;
  } else if (totalTradeableHours < 2.0) {
    verdict = "FAIL";
    verdictReason = `F2: totalTradeableHours=${totalTradeableHours.toFixed(1)} < 2.0`;
  }
  // INCONCLUSIVE conditions
  else if (
    partialOrBetterDays === 2 &&
    totalTradeableHours >= 2.0 &&
    totalTradeableHours < 6.0
  ) {
    verdict = "INCONCLUSIVE";
    verdictReason = `I1: partialOrBetterDays=2 AND totalTradeableHours=${totalTradeableHours.toFixed(1)} in [2.0, 6.0)`;
  } else if (partialOrBetterDays >= 3 && totalTradeableHours < 6.0) {
    verdict = "INCONCLUSIVE";
    verdictReason = `I2: partialOrBetterDays=${partialOrBetterDays} >= 3 BUT totalTradeableHours=${totalTradeableHours.toFixed(1)} < 6.0`;
  } else {
    // Fallback
    verdict = "INCONCLUSIVE";
    verdictReason = `Edge case: partialOrBetterDays=${partialOrBetterDays}, totalTradeableHours=${totalTradeableHours.toFixed(1)}`;
  }

  // ── Build output ──
  const output: VerdictV2 = {
    windowUTC: "11:00-17:00",
    windowTRT: "14:00-20:00",
    days: dayResults,
    aggregates,
    verdict,
    verdictReason,
  };

  // ── Print results ──
  console.log(`
  ── Aggregates ───────────────────────────────────────────────

  Total tradeable hours:    ${totalTradeableHours.toFixed(2)}h (${dayResults.length} days)
  Mean tradeable hours:     ${meanTradeableHours.toFixed(2)}h/day
  Median tradeable hours:   ${medianTradeableHours.toFixed(2)}h/day

  TRADEABLE days (≥2h):     ${tradeableDays}
  PARTIAL+ days (≥0.5h):    ${partialOrBetterDays}

  Modal peak window (UTC):  ${modalPeakStartUTC || "N/A"} - ${modalPeakEndUTC || "N/A"}
  Peak stability:           ${peakStabilityDays}/${peakStarts.length} days within ±30min

  ── Verdict Checks ───────────────────────────────────────────

  [${tradeableDays >= 2 ? "✓" : " "}] P1: tradeableDays >= 2 (actual: ${tradeableDays})
  [${partialOrBetterDays >= 3 && totalTradeableHours >= 6.0 ? "✓" : " "}] P2: partialOrBetterDays >= 3 AND totalH >= 6.0
  [${partialOrBetterDays <= 1 ? "✗" : " "}] F1: partialOrBetterDays <= 1 (actual: ${partialOrBetterDays})
  [${totalTradeableHours < 2.0 ? "✗" : " "}] F2: totalTradeableHours < 2.0 (actual: ${totalTradeableHours.toFixed(1)})
`);

  // ── Save output ──
  const outputPath = path.resolve(process.cwd(), "data/session_5day_verdict_v2.json");
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`  ✓ Saved: data/session_5day_verdict_v2.json`);

  // ── Print final verdict ──
  const verdictBadge =
    verdict === "PASS"
      ? "🟢 PASS"
      : verdict === "INCONCLUSIVE"
      ? "🟡 INCONCLUSIVE"
      : "🔴 FAIL";

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  5-DAY VERDICT v2 (WORKABILITY)              ${verdictBadge.padStart(14)} ║
╟──────────────────────────────────────────────────────────────╢
║  ${verdictReason.slice(0, 60).padEnd(60)} ║
╟──────────────────────────────────────────────────────────────╢
║  Total: ${totalTradeableHours.toFixed(1)}h tradeable | Mean: ${meanTradeableHours.toFixed(1)}h/day | Peak: ${modalPeakStartUTC || "N/A"} UTC     ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Return exit code based on verdict
  process.exit(verdict === "PASS" ? 0 : verdict === "INCONCLUSIVE" ? 2 : 1);
}

main().catch((err) => {
  console.error("5-day verdict v2 failed:", err);
  process.exit(1);
});
