/**
 * Session Mode v1.1 — 5-Day Verdict Analyzer
 *
 * Determines if the 14:00–20:00 TRT session window produces
 * a repeatable measurement regime over 5 consecutive days.
 *
 * PASS Conditions (ALL must be met):
 *   1. ≥3 days with classification ∈ {STRONG, MODERATE}
 *   2. ≤1 day with NO_REGIME (score < 40)
 *   3. All PASS days have passRatio ≥ 40%
 *   4. All 5 days have validRate ≥ 45%
 *
 * FAIL Conditions (ANY triggers):
 *   - STRONG/MODERATE days ≤ 2
 *   - NO_REGIME days ≥ 2
 *   - Any PASS day has passRatio < 40%
 *   - Any day has validRate < 45%
 *
 * INCONCLUSIVE:
 *   - STRONG/MODERATE = 2 AND NO_REGIME ≤ 1
 *     → Window may need recalibration (v1.2)
 *
 * Usage:
 *   npx tsx src/scripts/session5DayVerdict.ts
 *   npx tsx src/scripts/session5DayVerdict.ts --dirs archive/20260301_session_v1_1,archive/20260302_session_v1_1,...
 *   npm run session:5day
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionSummary {
  runId: string;
  dateUTC: string;
  dateTRT: string;
  
  totalSamples: number;
  validSamples: number;
  invalidSamples: number;
  validRate: number;
  
  T1_events: number;
  T2_events: number;
  sessionDurationHours: number;
  T2_per_hour: number;
  
  p95_bps: number;
  p90_bps: number;
  p75_bps: number;
  max_bps: number;
  
  rollingWindowsTotal: number;
  rollingWindowsPass: number;
  continuityRatio: number;
  
  minutesPass: number;
  sessionMinutes: number;
  passRatio: number;
  
  components: Array<{
    name: string;
    value: number;
    score: number;
    maxScore: number;
    bucket: string;
  }>;
  totalScore: number;
  classification: "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME";
  
  verdict: "PASS" | "WATCH" | "FAIL";
  verdictReason: string;
  recommendation: string;
}

interface DaySummary {
  date: string;
  runId: string;
  score: number;
  classification: "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME";
  validRate: number;
  passRatio: number;
  T2_per_hour: number;
  p95_bps: number;
  meetsPassCriteria: boolean;
  failReasons: string[];
}

interface FiveDayVerdict {
  analyzedAt: string;
  days: DaySummary[];
  
  // Counts
  strongModDays: number;
  noRegimeDays: number;
  weakDays: number;
  
  // Checks
  check1_strongModDays: { required: "≥3"; actual: number; pass: boolean };
  check2_noRegimeDays: { required: "≤1"; actual: number; pass: boolean };
  check3_passRatioAllValid: { required: "≥40% on PASS days"; failedDays: string[]; pass: boolean };
  check4_validRateAll: { required: "≥45% all days"; failedDays: string[]; pass: boolean };
  
  // Final
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  verdictReason: string;
  recommendation: string;
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

/** Load session summary from directory */
async function loadSummary(dir: string): Promise<SessionSummary | null> {
  const summaryPath = path.join(dir, "session_summary.json");
  try {
    const raw = await fs.readFile(summaryPath, "utf-8");
    return JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Session Mode v1.1 — 5-Day Verdict Analyzer                  ║
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
    console.error(`
  ✗ No session directories found.
    Run at least one session first:
      npm run session:init
      npm run session:watch -- --config <config.json>
      npm run session:analyze -- --input <session_dir>
`);
    process.exit(1);
  }

  if (dirs.length < 5) {
    console.log(`
  ⚠ Only ${dirs.length} sessions found. Need 5 for full verdict.
    Proceeding with partial analysis...
`);
  }

  // ── Load summaries ──
  const daySummaries: DaySummary[] = [];
  
  console.log(`  ── Loading Sessions ─────────────────────────────────────────\n`);
  
  for (const dir of dirs) {
    const summary = await loadSummary(dir);
    const dirName = path.basename(dir);
    
    if (!summary) {
      console.log(`  ✗ ${dirName}: missing session_summary.json`);
      continue;
    }
    
    // Check if this day meets PASS criteria
    const failReasons: string[] = [];
    
    // Check validRate >= 45%
    if (summary.validRate < 0.45) {
      failReasons.push(`validRate ${(summary.validRate * 100).toFixed(1)}% < 45%`);
    }
    
    // For STRONG/MODERATE days, check passRatio >= 40%
    const isPassDay = summary.classification === "STRONG" || summary.classification === "MODERATE";
    if (isPassDay && summary.passRatio < 0.40) {
      failReasons.push(`passRatio ${(summary.passRatio * 100).toFixed(1)}% < 40%`);
    }
    
    const meetsPassCriteria = failReasons.length === 0;
    
    daySummaries.push({
      date: summary.dateUTC,
      runId: summary.runId,
      score: summary.totalScore,
      classification: summary.classification,
      validRate: summary.validRate,
      passRatio: summary.passRatio,
      T2_per_hour: summary.T2_per_hour,
      p95_bps: summary.p95_bps,
      meetsPassCriteria,
      failReasons,
    });
    
    const badge = summary.classification === "STRONG"
      ? "🟢"
      : summary.classification === "MODERATE"
      ? "🟡"
      : summary.classification === "WEAK"
      ? "🟠"
      : "🔴";
    
    const status = meetsPassCriteria ? "✓" : "✗";
    
    console.log(
      `  ${status} ${summary.dateUTC}  ${badge} ${summary.classification.padEnd(10)} ` +
      `score=${summary.totalScore.toString().padStart(2)} ` +
      `validRate=${(summary.validRate * 100).toFixed(0).padStart(2)}% ` +
      `passRatio=${(summary.passRatio * 100).toFixed(0).padStart(2)}%`
    );
    
    if (failReasons.length > 0) {
      console.log(`      → ${failReasons.join(", ")}`);
    }
  }

  if (daySummaries.length === 0) {
    console.error(`\n  ✗ No valid session summaries found.`);
    process.exit(1);
  }

  // ── Calculate counts ──
  const strongModDays = daySummaries.filter(
    (d) => d.classification === "STRONG" || d.classification === "MODERATE"
  ).length;
  
  const noRegimeDays = daySummaries.filter(
    (d) => d.classification === "NO_REGIME"
  ).length;
  
  const weakDays = daySummaries.filter(
    (d) => d.classification === "WEAK"
  ).length;

  // ── Run checks ──
  
  // Check 1: ≥3 STRONG/MODERATE days
  const check1 = {
    required: "≥3" as const,
    actual: strongModDays,
    pass: strongModDays >= 3,
  };
  
  // Check 2: ≤1 NO_REGIME day
  const check2 = {
    required: "≤1" as const,
    actual: noRegimeDays,
    pass: noRegimeDays <= 1,
  };
  
  // Check 3: passRatio ≥ 40% on all STRONG/MODERATE days
  const passDaysWithLowPassRatio = daySummaries
    .filter((d) => d.classification === "STRONG" || d.classification === "MODERATE")
    .filter((d) => d.passRatio < 0.40)
    .map((d) => d.date);
  
  const check3 = {
    required: "≥40% on PASS days" as const,
    failedDays: passDaysWithLowPassRatio,
    pass: passDaysWithLowPassRatio.length === 0,
  };
  
  // Check 4: validRate ≥ 45% all days
  const daysWithLowValidRate = daySummaries
    .filter((d) => d.validRate < 0.45)
    .map((d) => d.date);
  
  const check4 = {
    required: "≥45% all days" as const,
    failedDays: daysWithLowValidRate,
    pass: daysWithLowValidRate.length === 0,
  };

  console.log(`
  ── 5-Day Checks ─────────────────────────────────────────────

  [${check1.pass ? "✓" : "✗"}] STRONG/MODERATE days:  ${strongModDays}/${daySummaries.length} (required ${check1.required})
  [${check2.pass ? "✓" : "✗"}] NO_REGIME days:        ${noRegimeDays}/${daySummaries.length} (required ${check2.required})
  [${check3.pass ? "✓" : "✗"}] passRatio on PASS days: ${check3.pass ? "all ≥40%" : `failed: ${check3.failedDays.join(", ")}`}
  [${check4.pass ? "✓" : "✗"}] validRate all days:    ${check4.pass ? "all ≥45%" : `failed: ${check4.failedDays.join(", ")}`}
`);

  // ── Determine verdict ──
  let verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  let verdictReason: string;
  let recommendation: string;
  
  const allChecksPassed = check1.pass && check2.pass && check3.pass && check4.pass;
  
  if (allChecksPassed) {
    verdict = "PASS";
    verdictReason = `All criteria met: ${strongModDays} STRONG/MODERATE days, ${noRegimeDays} NO_REGIME days, all passRatio/validRate thresholds passed.`;
    recommendation = "14:00–20:00 TRT window produces repeatable regime. Ready to discuss Stage3/4 execution.";
  } else if (
    strongModDays === 2 && noRegimeDays <= 1 && check3.pass && check4.pass
  ) {
    // INCONCLUSIVE case
    verdict = "INCONCLUSIVE";
    verdictReason = `Edge detected but borderline: ${strongModDays} STRONG/MODERATE days (need 3). Window may need recalibration.`;
    recommendation = "Consider v1.2 window recalibration. Do not proceed to execution without adjustment.";
  } else {
    // FAIL
    verdict = "FAIL";
    const failReasons: string[] = [];
    
    if (!check1.pass) {
      failReasons.push(`only ${strongModDays} STRONG/MODERATE days (need ≥3)`);
    }
    if (!check2.pass) {
      failReasons.push(`${noRegimeDays} NO_REGIME days (max 1 allowed)`);
    }
    if (!check3.pass) {
      failReasons.push(`passRatio <40% on: ${check3.failedDays.join(", ")}`);
    }
    if (!check4.pass) {
      failReasons.push(`validRate <45% on: ${check4.failedDays.join(", ")}`);
    }
    
    verdictReason = `Failed checks: ${failReasons.join("; ")}`;
    recommendation = "Edge not repeatable in current window. Consider different time window or strategy adjustment.";
  }

  // ── Build verdict object ──
  const fiveDayVerdict: FiveDayVerdict = {
    analyzedAt: new Date().toISOString(),
    days: daySummaries,
    
    strongModDays,
    noRegimeDays,
    weakDays,
    
    check1_strongModDays: check1,
    check2_noRegimeDays: check2,
    check3_passRatioAllValid: check3,
    check4_validRateAll: check4,
    
    verdict,
    verdictReason,
    recommendation,
  };

  // ── Save verdict ──
  const verdictPath = path.resolve(process.cwd(), "data/session_5day_verdict.json");
  await fs.writeFile(verdictPath, JSON.stringify(fiveDayVerdict, null, 2), "utf-8");
  console.log(`  ✓ Saved: data/session_5day_verdict.json`);

  // ── Print final verdict ──
  const verdictBadge = verdict === "PASS"
    ? "🟢 PASS"
    : verdict === "INCONCLUSIVE"
    ? "🟡 INCONCLUSIVE"
    : "🔴 FAIL";
  
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  5-DAY VERDICT                                 ${verdictBadge.padStart(14)} ║
╟──────────────────────────────────────────────────────────────╢
║  ${verdictReason.slice(0, 60).padEnd(60)} ║
╟──────────────────────────────────────────────────────────────╢
║  📌 ${recommendation.slice(0, 57).padEnd(57)} ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Return exit code based on verdict
  process.exit(verdict === "PASS" ? 0 : verdict === "INCONCLUSIVE" ? 2 : 1);
}

main().catch((err) => {
  console.error("5-day verdict failed:", err);
  process.exit(1);
});
