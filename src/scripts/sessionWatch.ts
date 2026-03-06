/**
 * Session Mode v1.1 — Session Watch Orchestrator
 *
 * Orchestrates preflight + session watch with 15-minute rolling monitoring.
 *
 * Phases:
 *   1. Wait for preflight start (10:30 UTC)
 *   2. Run preflight (30 min)
 *   3. Run session (6h) with 15-min rolling metrics
 *   4. Output session data for scoring
 *
 * Uses arbWatch.ts internally via config, adds session-specific monitoring.
 *
 * Usage:
 *   npx tsx src/scripts/sessionWatch.ts --config archive/YYYYMMDD_session_v1_1/session_config.json
 *   npm run session:watch -- --config <path>
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs, createWriteStream, WriteStream } from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionConfig {
  version: "1.1";
  dateUTC: string;
  dateTRT: string;
  runId: string;
  
  preflight: {
    startUTC: string;
    endUTC: string;
    startTRT: string;
    endTRT: string;
    durationMin: number;
  };
  
  session: {
    startUTC: string;
    endUTC: string;
    startTRT: string;
    endTRT: string;
    durationMin: number;
  };
  
  surfaceSymbols: string[];
  excludeSymbols: string[];
  thresholds: {
    T1_bps: number;
    T2_bps: number;
  };
  
  mode: "quote_only";
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
  passStatus: boolean;  // All criteria met
}

interface ValidSample {
  ts: number;
  baseSymbol: string;
  netProfitBps: number;
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

const CONFIG_FILE = getArgStr("--config", "");
const SKIP_WAIT = args.includes("--skip-wait");

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatTime(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function parseTimeToMs(dateUTC: string, timeStr: string): number {
  return new Date(`${dateUTC}T${timeStr}:00Z`).getTime();
}

/** Read JSONL samples from a time range */
async function readSamplesInRange(
  dir: string,
  startTs: number,
  endTs: number,
  surfaceSymbols: string[],
): Promise<ValidSample[]> {
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
        if (
          sample.ts >= startTs &&
          sample.ts <= endTs &&
          surfaceSet.has(sample.baseSymbol?.toUpperCase())
        ) {
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

/** Read invalid samples count in range */
async function readInvalidCountInRange(
  dir: string,
  startTs: number,
  endTs: number,
  surfaceSymbols: string[],
): Promise<number> {
  const surfaceSet = new Set(surfaceSymbols.map((s) => s.toUpperCase()));
  let count = 0;
  
  const files = await fs.readdir(dir);
  const invalidFiles = files.filter((f) => /^arb_watch_invalid_.*\.jsonl$/.test(f));
  
  for (const file of invalidFiles) {
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    
    for (const line of lines) {
      try {
        const sample = JSON.parse(line);
        if (
          sample.ts >= startTs &&
          sample.ts <= endTs &&
          surfaceSet.has(sample.baseSymbol?.toUpperCase())
        ) {
          count++;
        }
      } catch {
        // Skip
      }
    }
  }
  
  return count;
}

/** Calculate p95 */
function percentile95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Calculate rolling metrics for a 60-minute window */
async function calcRollingMetrics(
  dir: string,
  windowEnd: number,
  config: SessionConfig,
): Promise<RollingMetrics> {
  const windowStart = windowEnd - 60 * 60 * 1000; // 60 min ago
  
  const validSamples = await readSamplesInRange(
    dir,
    windowStart,
    windowEnd,
    config.surfaceSymbols,
  );
  
  const invalidCount = await readInvalidCountInRange(
    dir,
    windowStart,
    windowEnd,
    config.surfaceSymbols,
  );
  
  const totalSamples = validSamples.length + invalidCount;
  const validRate = totalSamples > 0 ? validSamples.length / totalSamples : 0;
  
  // T2 samples (bps >= 5)
  const T2_samples = validSamples.filter((s) => s.netProfitBps >= config.thresholds.T2_bps);
  const T2_events = T2_samples.length;
  const T2_events_per_hour = T2_events; // Already 60 min window
  
  // p95 of positive samples
  const positiveBps = validSamples
    .filter((s) => s.netProfitBps > 0)
    .map((s) => s.netProfitBps);
  const p95Peak = percentile95(positiveBps);
  
  // Pass status: all criteria met
  const passStatus =
    validRate >= 0.5 &&          // >= 50%
    T2_events_per_hour >= 8 &&   // >= 8/hour
    p95Peak >= 80;               // >= 80bps
  
  return {
    ts: windowEnd,
    windowStart,
    windowEnd,
    validRate,
    T2_events,
    T2_events_per_hour,
    p95Peak,
    passStatus,
  };
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Session Mode v1.1 — Watch Orchestrator                      ║
╚══════════════════════════════════════════════════════════════╝
`);

  if (!CONFIG_FILE) {
    console.error("  ✗ --config <path> is required");
    console.error("    Usage: npm run session:watch -- --config <session_config.json>");
    process.exit(1);
  }

  // ── Load config ──
  const configPath = path.resolve(process.cwd(), CONFIG_FILE);
  let config: SessionConfig;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as SessionConfig;
    console.log(`  ✓ Config loaded: ${config.runId}`);
  } catch (err) {
    console.error(`  ✗ Failed to load config: ${CONFIG_FILE}`);
    process.exit(1);
  }

  const outputDir = path.resolve(process.cwd(), config.outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  // ── Calculate timestamps ──
  const preflightStartMs = parseTimeToMs(config.dateUTC, config.preflight.startUTC);
  const preflightEndMs = parseTimeToMs(config.dateUTC, config.preflight.endUTC);
  const sessionStartMs = parseTimeToMs(config.dateUTC, config.session.startUTC);
  const sessionEndMs = parseTimeToMs(config.dateUTC, config.session.endUTC);

  console.log(`
  Date:            ${config.dateUTC} (UTC) / ${config.dateTRT} (TRT)
  Preflight:       ${config.preflight.startUTC}–${config.preflight.endUTC} UTC
  Session:         ${config.session.startUTC}–${config.session.endUTC} UTC
  Output:          ${config.outputDir}
`);

  // ── Wait for preflight if needed ──
  const now = Date.now();
  
  if (!SKIP_WAIT && now < preflightStartMs) {
    const waitMs = preflightStartMs - now;
    const waitMin = Math.ceil(waitMs / 60000);
    console.log(`  ⏳ Waiting ${waitMin} min for preflight start (${config.preflight.startTRT} TRT)...`);
    console.log(`     Press Ctrl+C to abort.\n`);
    await sleep(waitMs);
  }

  // ── Run arbWatch for full session duration ──
  // Total duration: preflight (30 min) + session (360 min) = 390 min
  // But we'll start from now and run until session end
  
  const effectiveStartMs = Math.max(now, preflightStartMs);
  const remainingMs = sessionEndMs - effectiveStartMs;
  const remainingMin = Math.ceil(remainingMs / 60000);

  if (remainingMs <= 0) {
    console.log(`  ⚠ Session already ended. Use --date for tomorrow.`);
    process.exit(0);
  }

  console.log(`  🚀 Starting watch for ${remainingMin} min until ${config.session.endUTC} UTC\n`);

  // Create a stage2-like config for arbWatch
  const watchConfig = {
    runId: config.runId,
    durationHours: remainingMin / 60,
    surfaceSymbols: config.surfaceSymbols,
    thresholds: config.thresholds,
    excludeSymbols: config.excludeSymbols,
    mode: config.mode,
    outputDir: config.outputDir,
  };

  const watchConfigPath = path.join(outputDir, "watch_config.json");
  await fs.writeFile(watchConfigPath, JSON.stringify(watchConfig, null, 2), "utf-8");

  // Start arbWatch as subprocess
  const watchProcess = spawn(
    "npx",
    [
      "tsx",
      "src/scripts/arbWatch.ts",
      "--config",
      watchConfigPath,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    },
  );

  // Log output
  const logPath = path.join(outputDir, "session_watch.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  
  watchProcess.stdout?.pipe(logStream);
  watchProcess.stderr?.pipe(logStream);

  watchProcess.stdout?.on("data", (data) => {
    const str = data.toString();
    if (str.includes("tick") || str.includes("event") || str.includes("Rotated")) {
      process.stdout.write(`  ${str}`);
    }
  });

  console.log(`  📝 Watch log: ${logPath}`);

  // ── 15-minute rolling monitoring ──
  const rollingResults: RollingMetrics[] = [];
  const monitoringInterval = 15 * 60 * 1000; // 15 min
  let minutesPass = 0;
  let totalMinutesMonitored = 0;

  // Start monitoring after first 60 min (need data for rolling window)
  const monitoringStartMs = effectiveStartMs + 60 * 60 * 1000;
  
  const monitorLoop = setInterval(async () => {
    const nowMs = Date.now();
    
    // Skip if we don't have 60 min of data yet
    if (nowMs < monitoringStartMs) {
      console.log(`  [MONITOR] Waiting for 60 min of data...`);
      return;
    }
    
    // Stop if session ended
    if (nowMs >= sessionEndMs) {
      clearInterval(monitorLoop);
      return;
    }
    
    try {
      const metrics = await calcRollingMetrics(outputDir, nowMs, config);
      rollingResults.push(metrics);
      
      // Track pass minutes (15 min per check)
      if (metrics.passStatus) {
        minutesPass += 15;
      }
      totalMinutesMonitored += 15;
      
      const time = new Date(nowMs).toISOString().slice(11, 16);
      const status = metrics.passStatus ? "✓ PASS" : "✗ FAIL";
      
      console.log(
        `  [MONITOR ${time}] validRate=${(metrics.validRate * 100).toFixed(1)}% ` +
        `T2/h=${metrics.T2_events_per_hour} p95=${metrics.p95Peak.toFixed(1)}bps ${status}`,
      );
      
      // Save rolling results
      const rollingPath = path.join(outputDir, "rolling_metrics.jsonl");
      await fs.appendFile(rollingPath, JSON.stringify(metrics) + "\n", "utf-8");
      
    } catch (err) {
      console.error(`  [MONITOR] Error:`, err);
    }
  }, monitoringInterval);

  // ── Handle process exit ──
  watchProcess.on("exit", async (code) => {
    clearInterval(monitorLoop);
    logStream.end();
    
    console.log(`\n  Watch process exited with code ${code}`);
    
    // Save monitoring summary
    const passRatio = totalMinutesMonitored > 0 ? minutesPass / totalMinutesMonitored : 0;
    
    const monitoringSummary = {
      totalMonitoringChecks: rollingResults.length,
      minutesPass,
      totalMinutesMonitored,
      passRatio,
      rollingResults,
    };
    
    const summaryPath = path.join(outputDir, "monitoring_summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(monitoringSummary, null, 2), "utf-8");
    
    console.log(`  📊 Monitoring summary: ${summaryPath}`);
    console.log(`     Pass ratio: ${(passRatio * 100).toFixed(1)}% (${minutesPass}/${totalMinutesMonitored} min)`);
    console.log(`
  ── Next Step ────────────────────────────────────────────────

  Run scoring analysis:

    npm run session:analyze -- --input ${config.outputDir}
`);
  });

  // Handle SIGINT
  process.on("SIGINT", () => {
    console.log("\n  ⚠ Interrupted. Saving state...");
    watchProcess.kill("SIGINT");
  });
}

main().catch((err) => {
  console.error("Session watch failed:", err);
  process.exit(1);
});
