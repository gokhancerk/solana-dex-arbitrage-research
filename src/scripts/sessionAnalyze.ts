/**
 * Session Mode v1.1 — Scoring Analyzer
 *
 * Analyzes session watch data and generates daily regime score.
 *
 * 4-Component Scoring (0-100 total):
 *   1. Intensity (25pts)    - T2 events per hour
 *   2. p95 Strength (25pts) - Peak basis points
 *   3. Continuity (25pts)   - % of 15-min windows passing
 *   4. Health (25pts)       - Valid rate %
 *
 * Classification (5-day verdict thresholds):
 *   - STRONG:    75-100
 *   - MODERATE:  60-74
 *   - WEAK:      40-59
 *   - NO_REGIME: 0-39
 *
 * Usage:
 *   npx tsx src/scripts/sessionAnalyze.ts --input archive/YYYYMMDD_session_v1_1
 *   npm run session:analyze -- --input <session_dir>
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionConfig {
  version: "1.1" | "1.2";
  dateUTC: string;
  dateTRT: string;
  runId: string;
  preflight: { startUTC: string; endUTC: string; durationMin: number };
  session: { startUTC: string; endUTC: string; durationMin: number };
  surfaceSymbols: string[];
  excludeSymbols: string[];
  thresholds: { T1_bps: number; T2_bps: number };
  mode: string;
  outputDir: string;
}

interface RollingMetrics {
  ts: number;
  windowStart: number;
  windowEnd: number;
  validRate: number;
  T2_events: number;
  T2_events_per_hour: number;
  p95Peak: number;
  passStatus: boolean;
}

interface ValidSample {
  ts: number;
  baseSymbol: string;
  netProfitBps: number;
}

interface ComponentScore {
  name: string;
  value: number;
  score: number;
  maxScore: number;
  bucket: string;
}

interface SessionSummary {
  runId: string;
  dateUTC: string;
  dateTRT: string;
  
  // Raw metrics
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
  
  // Rolling metrics
  rollingWindowsTotal: number;
  rollingWindowsPass: number;
  continuityRatio: number;
  
  // passRatio for 5-day verdict
  minutesPass: number;          // minutes where rolling criteria met
  sessionMinutes: number;       // total session minutes (360)
  passRatio: number;            // minutesPass / 360
  
  // Component scoring
  components: ComponentScore[];
  totalScore: number;
  classification: "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME";
  
  // Verdict
  verdict: "PASS" | "WATCH" | "FAIL";
  verdictReason: string;
  
  // Next action
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

const INPUT_DIR = getArgStr("--input", "");

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

/** Safe percentile (handles empty arrays) */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function minMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) {
    return { min: 0, max: 0 };
  }

  let min = arr[0];
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const value = arr[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return { min, max };
}

/** Read all valid samples from watch files */
async function readValidSamples(dir: string, surfaceSymbols: string[]): Promise<ValidSample[]> {
  const surfaceSet = new Set(surfaceSymbols.map((s) => s.toUpperCase()));
  const samples: ValidSample[] = [];
  
  const files = await fs.readdir(dir);
  const watchFiles = files.filter((f) => /^arb_watch_\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/.test(f));
  
  for (const file of watchFiles) {
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    
    for (const line of lines) {
      try {
        const sample = JSON.parse(line);
        if (surfaceSet.has(sample.baseSymbol?.toUpperCase())) {
          samples.push({
            ts: sample.ts,
            baseSymbol: sample.baseSymbol,
            netProfitBps: sample.netProfitBps,
          });
        }
      } catch {
        // Skip invalid lines
      }
    }
  }
  
  return samples;
}

/** Read invalid sample count */
async function readInvalidCount(dir: string, surfaceSymbols: string[]): Promise<number> {
  const surfaceSet = new Set(surfaceSymbols.map((s) => s.toUpperCase()));
  let count = 0;
  
  const files = await fs.readdir(dir);
  const invalidFiles = files.filter((f) => /^arb_watch_invalid.*\.jsonl$/.test(f));
  
  for (const file of invalidFiles) {
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    
    for (const line of lines) {
      try {
        const sample = JSON.parse(line);
        if (surfaceSet.has(sample.baseSymbol?.toUpperCase())) {
          count++;
        }
      } catch {
        // Skip
      }
    }
  }
  
  return count;
}

/** Read rolling metrics from monitoring file */
async function readRollingMetrics(dir: string): Promise<RollingMetrics[]> {
  const filePath = path.join(dir, "rolling_metrics.jsonl");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    return lines.map((l) => JSON.parse(l) as RollingMetrics);
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
//  Scoring Functions
// ══════════════════════════════════════════════════════════════

/**
 * Intensity Score (0-25)
 * Based on T2 events per hour
 * 
 * >= 20/h: 25 pts (Excellent)
 * >= 12/h: 20 pts (Good)
 * >=  8/h: 15 pts (Acceptable)
 * >=  5/h: 10 pts (Low)
 * <   5/h:  5 pts (Very Low)
 */
function scoreIntensity(T2_per_hour: number): ComponentScore {
  let score: number;
  let bucket: string;
  
  if (T2_per_hour >= 20) {
    score = 25;
    bucket = "Excellent (≥20/h)";
  } else if (T2_per_hour >= 12) {
    score = 20;
    bucket = "Good (12-19/h)";
  } else if (T2_per_hour >= 8) {
    score = 15;
    bucket = "Acceptable (8-11/h)";
  } else if (T2_per_hour >= 5) {
    score = 10;
    bucket = "Low (5-7/h)";
  } else {
    score = 5;
    bucket = "Very Low (<5/h)";
  }
  
  return {
    name: "Intensity",
    value: T2_per_hour,
    score,
    maxScore: 25,
    bucket,
  };
}

/**
 * p95 Strength Score (0-25)
 * Based on p95 peak basis points
 * 
 * >= 120 bps: 25 pts (Excellent)
 * >= 100 bps: 20 pts (Good)
 * >=  80 bps: 15 pts (Acceptable)
 * >=  50 bps: 10 pts (Low)
 * <   50 bps:  5 pts (Very Low)
 */
function scorep95Strength(p95_bps: number): ComponentScore {
  let score: number;
  let bucket: string;
  
  if (p95_bps >= 120) {
    score = 25;
    bucket = "Excellent (≥120bps)";
  } else if (p95_bps >= 100) {
    score = 20;
    bucket = "Good (100-119bps)";
  } else if (p95_bps >= 80) {
    score = 15;
    bucket = "Acceptable (80-99bps)";
  } else if (p95_bps >= 50) {
    score = 10;
    bucket = "Low (50-79bps)";
  } else {
    score = 5;
    bucket = "Very Low (<50bps)";
  }
  
  return {
    name: "p95 Strength",
    value: p95_bps,
    score,
    maxScore: 25,
    bucket,
  };
}

/**
 * Continuity Score (0-25)
 * Based on % of rolling 15-min windows passing all criteria
 * 
 * >= 80%: 25 pts (Excellent)
 * >= 60%: 20 pts (Good)
 * >= 40%: 15 pts (Acceptable)
 * >= 20%: 10 pts (Low)
 * <  20%:  5 pts (Very Low)
 */
function scoreContinuity(passRatio: number): ComponentScore {
  let score: number;
  let bucket: string;
  
  if (passRatio >= 0.80) {
    score = 25;
    bucket = "Excellent (≥80%)";
  } else if (passRatio >= 0.60) {
    score = 20;
    bucket = "Good (60-79%)";
  } else if (passRatio >= 0.40) {
    score = 15;
    bucket = "Acceptable (40-59%)";
  } else if (passRatio >= 0.20) {
    score = 10;
    bucket = "Low (20-39%)";
  } else {
    score = 5;
    bucket = "Very Low (<20%)";
  }
  
  return {
    name: "Continuity",
    value: passRatio * 100,
    score,
    maxScore: 25,
    bucket,
  };
}

/**
 * Health Score (0-25)
 * Based on valid rate %
 * 
 * >= 70%: 25 pts (Excellent)
 * >= 60%: 20 pts (Good)
 * >= 50%: 15 pts (Acceptable)
 * >= 40%: 10 pts (Low)
 * <  40%:  5 pts (Very Low)
 */
function scoreHealth(validRate: number): ComponentScore {
  let score: number;
  let bucket: string;
  
  if (validRate >= 0.70) {
    score = 25;
    bucket = "Excellent (≥70%)";
  } else if (validRate >= 0.60) {
    score = 20;
    bucket = "Good (60-69%)";
  } else if (validRate >= 0.50) {
    score = 15;
    bucket = "Acceptable (50-59%)";
  } else if (validRate >= 0.40) {
    score = 10;
    bucket = "Low (40-49%)";
  } else {
    score = 5;
    bucket = "Very Low (<40%)";
  }
  
  return {
    name: "Health",
    value: validRate * 100,
    score,
    maxScore: 25,
    bucket,
  };
}

/**
 * Get classification from total score
 */
function getClassification(score: number): "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME" {
  if (score >= 75) return "STRONG";   // 5-day verdict: STRONG ≥75
  if (score >= 60) return "MODERATE"; // 5-day verdict: MODERATE 60-74
  if (score >= 40) return "WEAK";     // 5-day verdict: WEAK 40-59
  return "NO_REGIME";                 // 5-day verdict: NO_REGIME <40
}

/**
 * Get verdict and recommendation based on classification
 */
function getVerdictAndRecommendation(
  classification: "STRONG" | "MODERATE" | "WEAK" | "NO_REGIME",
  components: ComponentScore[],
): { verdict: "PASS" | "WATCH" | "FAIL"; reason: string; recommendation: string } {
  switch (classification) {
    case "STRONG":
      return {
        verdict: "PASS",
        reason: "All metrics strong. Edge appears consistently in session window.",
        recommendation: "Ready for paper trading. Monitor 3 consecutive STRONG days before live.",
      };
    
    case "MODERATE":
      const weakComponent = components.find((c) => c.score <= 15);
      return {
        verdict: "WATCH",
        reason: `Overall moderate. ${weakComponent?.name || "Some components"} need improvement.`,
        recommendation: "Continue monitoring. Run 2+ more sessions to confirm trend.",
      };
    
    case "WEAK":
      const failing = components.filter((c) => c.score <= 10).map((c) => c.name);
      return {
        verdict: "WATCH",
        reason: `Weak regime. Failing components: ${failing.join(", ") || "multiple"}.`,
        recommendation: "Edge may be session-dependent or sporadic. Consider different time window.",
      };
    
    case "NO_REGIME":
      return {
        verdict: "FAIL",
        reason: "No consistent edge detected in session window.",
        recommendation: "Re-evaluate strategy. Consider different pairs/routes or time windows.",
      };
  }
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Session Mode v1.1 — Scoring Analyzer                        ║
╚══════════════════════════════════════════════════════════════╝
`);

  if (!INPUT_DIR) {
    console.error("  ✗ --input <session_dir> is required");
    console.error("    Usage: npm run session:analyze -- --input archive/YYYYMMDD_session_v1_1");
    process.exit(1);
  }

  const inputDir = path.resolve(process.cwd(), INPUT_DIR);
  
  // ── Load session config ──
  const configPath = path.join(inputDir, "session_config.json");
  let config: SessionConfig;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as SessionConfig;
    console.log(`  ✓ Config loaded: ${config.runId}`);
  } catch {
    console.error(`  ✗ Missing session_config.json in ${INPUT_DIR}`);
    process.exit(1);
  }

  // ── Load data ──
  console.log(`  ⏳ Loading samples...`);
  
  const validSamples = await readValidSamples(inputDir, config.surfaceSymbols);
  const invalidCount = await readInvalidCount(inputDir, config.surfaceSymbols);
  const rollingMetrics = await readRollingMetrics(inputDir);
  
  const totalSamples = validSamples.length + invalidCount;
  const validRate = totalSamples > 0 ? validSamples.length / totalSamples : 0;
  
  console.log(`  ✓ Valid samples: ${validSamples.length}`);
  console.log(`  ✓ Invalid samples: ${invalidCount}`);
  console.log(`  ✓ Valid rate: ${(validRate * 100).toFixed(1)}%`);
  console.log(`  ✓ Rolling windows: ${rollingMetrics.length}`);

  // ── Calculate metrics ──
  const positiveBps = validSamples
    .filter((s) => s.netProfitBps > 0)
    .map((s) => s.netProfitBps);
  
  const T1_events = validSamples.filter((s) => s.netProfitBps >= config.thresholds.T1_bps).length;
  const T2_events = validSamples.filter((s) => s.netProfitBps >= config.thresholds.T2_bps).length;
  
  // Session duration from actual data
  const timestamps = validSamples.map((s) => s.ts);
  const { min: minTs, max: maxTs } = minMax(timestamps);
  const sessionDurationHours = (maxTs - minTs) / (1000 * 60 * 60);
  
  const T2_per_hour = sessionDurationHours > 0 ? T2_events / sessionDurationHours : 0;
  
  const p95_bps = percentile(positiveBps, 0.95);
  const p90_bps = percentile(positiveBps, 0.90);
  const p75_bps = percentile(positiveBps, 0.75);
  const { max: max_bps } = minMax(positiveBps);
  
  // Rolling continuity
  const rollingWindowsTotal = rollingMetrics.length;
  const rollingWindowsPass = rollingMetrics.filter((m) => m.passStatus).length;
  const continuityRatio = rollingWindowsTotal > 0 ? rollingWindowsPass / rollingWindowsTotal : 0;
  
  // passRatio for 5-day verdict (minutesPass / sessionMinutes)
  const SESSION_MINUTES = config.session?.durationMin || 360; // from config (v1.1=360, v1.2=240)
  const minutesPass = rollingWindowsPass * 15; // each rolling window = 15 min
  const passRatio = minutesPass / SESSION_MINUTES;

  console.log(`
  ── Raw Metrics ──────────────────────────────────────────────
  
  T1 events (≥10bps):   ${T1_events}
  T2 events (≥5bps):    ${T2_events}
  Session duration:     ${sessionDurationHours.toFixed(2)} hours
  T2/hour:              ${T2_per_hour.toFixed(1)}
  
  p95:                  ${p95_bps.toFixed(2)} bps
  p90:                  ${p90_bps.toFixed(2)} bps
  p75:                  ${p75_bps.toFixed(2)} bps
  max:                  ${max_bps.toFixed(2)} bps
  
  Rolling continuity:   ${rollingWindowsPass}/${rollingWindowsTotal} (${(continuityRatio * 100).toFixed(1)}%)
  Pass ratio:           ${minutesPass}/${SESSION_MINUTES} min (${(passRatio * 100).toFixed(1)}%)
`);

  // ── Calculate scores ──
  const components: ComponentScore[] = [
    scoreIntensity(T2_per_hour),
    scorep95Strength(p95_bps),
    scoreContinuity(continuityRatio),
    scoreHealth(validRate),
  ];
  
  const totalScore = components.reduce((sum, c) => sum + c.score, 0);
  const classification = getClassification(totalScore);
  const { verdict, reason, recommendation } = getVerdictAndRecommendation(classification, components);

  console.log(`  ── Component Scores ─────────────────────────────────────────
`);

  for (const c of components) {
    const bar = "█".repeat(c.score) + "░".repeat(c.maxScore - c.score);
    console.log(`  ${c.name.padEnd(14)} [${bar}] ${c.score}/${c.maxScore}  ${c.bucket}`);
  }

  console.log(`
  ── Total Score ──────────────────────────────────────────────
  
  Score:        ${totalScore}/100
  Class:        ${classification}
  Verdict:      ${verdict}
  
  ${reason}
  
  📌 ${recommendation}
`);

  // ── Build summary ──
  const summary: SessionSummary = {
    runId: config.runId,
    dateUTC: config.dateUTC,
    dateTRT: config.dateTRT,
    
    totalSamples,
    validSamples: validSamples.length,
    invalidSamples: invalidCount,
    validRate,
    
    T1_events,
    T2_events,
    sessionDurationHours,
    T2_per_hour,
    
    p95_bps,
    p90_bps,
    p75_bps,
    max_bps,
    
    rollingWindowsTotal,
    rollingWindowsPass,
    continuityRatio,
    
    minutesPass,
    sessionMinutes: SESSION_MINUTES,
    passRatio,
    
    components,
    totalScore,
    classification,
    
    verdict,
    verdictReason: reason,
    recommendation,
  };

  // ── Save summary ──
  const summaryPath = path.join(inputDir, "session_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`  ✓ Saved: ${summaryPath}`);

  // ── Print ASCII badge ──
  const badge = classification === "STRONG"
    ? "🟢 STRONG"
    : classification === "MODERATE"
    ? "🟡 MODERATE"
    : classification === "WEAK"
    ? "🟠 WEAK"
    : "🔴 NO_REGIME";
  
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ${config.runId.padEnd(30)} ${badge.padStart(22)} ║
║  ${`Score: ${totalScore}/100`.padEnd(30)} ${verdict.padStart(22)} ║
╚══════════════════════════════════════════════════════════════╝
`);
}

main().catch((err) => {
  console.error("Session analyze failed:", err);
  process.exit(1);
});
