/**
 * Kill Switch — Deterministic PASS/FAIL Decision Layer
 *
 * Reads existing Watch Mode outputs (arb_events.jsonl and/or arb_watch.jsonl)
 * and produces a deterministic verdict based on transient-edge event metrics.
 *
 * Outputs:
 *   - data/killSwitchReport.json
 *   - Console one-liner: KILL SWITCH: PASS / FAIL / INSUFFICIENT_DATA
 *
 * Usage:
 *   npm run kill:switch
 *   npx tsx src/scripts/killSwitch.ts
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Glob helper — read all arb_watch*.jsonl files from data/
// ══════════════════════════════════════════════════════════════

async function readAllWatchSamples(dataDir: string): Promise<{ samples: WatchSample[]; files: string[] }> {
  const entries = await fs.readdir(dataDir);
  // Match both legacy arb_watch.jsonl and rotated arb_watch_*.jsonl
  const watchFiles = entries
    .filter((f) => /^arb_watch[_.].*\.jsonl$/.test(f))
    .sort();
  const allSamples: WatchSample[] = [];
  const loaded: string[] = [];
  for (const file of watchFiles) {
    try {
      const raw = await fs.readFile(path.join(dataDir, file), "utf-8");
      const parsed = parseJsonl<WatchSample>(raw);
      if (parsed.length > 0) {
        allSamples.push(...parsed);
        loaded.push(file);
      }
    } catch { /* skip unreadable files */ }
  }
  return { samples: allSamples, files: loaded };
}

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

const T1_BPS = 10;
const T2_BPS = 5;
const K = 3;              // consecutive below-threshold samples to close event
const MIN_SAMPLES = 3;    // minimum samples for a valid event

const W6_MS = 6 * 60 * 60 * 1000;
const W24_MS = 24 * 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════
//  Types — Watch outputs
// ══════════════════════════════════════════════════════════════

interface WatchSample {
  ts: number;
  tickId?: number;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  netProfitBps: number;
  netProfitUsdc: number;
  priceDivPct?: number;
}

interface WatchEvent {
  pairId: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  peakBps: number;
  peakUsdc: number;
  sampleCount: number;
  /** Threshold at which event was detected — present when reconstructed */
  thresholdBps?: number;
}

// ── Report types ──

interface WindowMetrics {
  window: string;
  thresholdBps: number;
  windowDurationMs: number;
  totalEvents: number;
  eventsByPair: Record<string, number>;
  topPairs: Array<{
    pairId: string;
    baseSymbol: string;
    eventCount: number;
    p95PeakBps: number;
    medianDurationMs: number;
    totalPositiveDurationMs: number;
  }>;
  p95PeakBps_top3: number[];
  medianDurationMs_top3: number[];
  totalPositiveDurationMs_top3: number;
  eventCount_top3_total: number;
}

interface KillSwitchReport {
  generatedAt: string;
  dataRange: { startTs: number; endTs: number; durationMs: number };
  thresholds: { T1: number; T2: number; K: number; minSamples: number };
  windows: {
    W6: WindowMetrics | null;
    W24: WindowMetrics | null;
  };
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
  phase1: string;
  reasons: string[];
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function parseJsonl<T>(content: string): T[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ══════════════════════════════════════════════════════════════
//  Event Reconstruction from raw samples
// ══════════════════════════════════════════════════════════════

/**
 * Deterministically reconstruct events from raw samples at a given threshold.
 * Sorts samples by (pairId, notional, direction, ts) then applies the
 * same event detection rules as arbWatch.ts.
 */
function reconstructEvents(
  samples: WatchSample[],
  thresholdBps: number,
): WatchEvent[] {
  // Group by (baseMint, notional, direction)
  const groups = new Map<string, WatchSample[]>();
  for (const s of samples) {
    const key = `${s.baseMint}:${s.notional}:${s.direction}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(s);
  }

  const events: WatchEvent[] = [];

  for (const [_key, group] of groups) {
    // Sort by timestamp
    group.sort((a, b) => a.ts - b.ts);

    let active = false;
    let startTs = 0;
    let lastTs = 0;
    let peakBps = 0;
    let peakUsdc = 0;
    let sampleCount = 0;
    let belowCount = 0;

    const closeEvent = () => {
      if (sampleCount >= MIN_SAMPLES) {
        events.push({
          pairId: group[0].baseMint,
          baseSymbol: group[0].baseSymbol,
          notional: group[0].notional,
          direction: group[0].direction,
          startTs,
          endTs: lastTs,
          durationMs: lastTs - startTs,
          peakBps,
          peakUsdc,
          sampleCount,
          thresholdBps,
        });
      }
      active = false;
      startTs = 0;
      lastTs = 0;
      peakBps = 0;
      peakUsdc = 0;
      sampleCount = 0;
      belowCount = 0;
    };

    for (const s of group) {
      if (s.netProfitBps >= thresholdBps) {
        if (!active) {
          active = true;
          startTs = s.ts;
          peakBps = s.netProfitBps;
          peakUsdc = s.netProfitUsdc;
          sampleCount = 1;
          belowCount = 0;
        } else {
          sampleCount++;
          belowCount = 0;
          if (s.netProfitBps > peakBps) {
            peakBps = s.netProfitBps;
            peakUsdc = s.netProfitUsdc;
          }
        }
        lastTs = s.ts;
      } else {
        if (active) {
          belowCount++;
          if (belowCount >= K) {
            closeEvent();
          }
        }
      }
    }

    // Close any trailing active event
    if (active) {
      closeEvent();
    }
  }

  return events;
}

// ══════════════════════════════════════════════════════════════
//  Window Metrics Computation
// ══════════════════════════════════════════════════════════════

function computeWindowMetrics(
  events: WatchEvent[],
  windowLabel: string,
  thresholdBps: number,
  windowStart: number,
  windowEnd: number,
): WindowMetrics {
  const windowDurationMs = windowEnd - windowStart;

  // Filter events to this window (event starts within the window)
  const windowEvents = events.filter(
    (e) => e.startTs >= windowStart && e.startTs < windowEnd,
  );

  // Events by pair
  const eventsByPair: Record<string, number> = {};
  const eventDataByPair = new Map<
    string,
    { pairId: string; baseSymbol: string; events: WatchEvent[] }
  >();

  for (const e of windowEvents) {
    eventsByPair[e.pairId] = (eventsByPair[e.pairId] ?? 0) + 1;
    let pd = eventDataByPair.get(e.pairId);
    if (!pd) {
      pd = { pairId: e.pairId, baseSymbol: e.baseSymbol, events: [] };
      eventDataByPair.set(e.pairId, pd);
    }
    pd.events.push(e);
  }

  // Top 5 pairs by eventCount, tie-break by p95PeakBps desc
  const pairEntries = Array.from(eventDataByPair.values())
    .map((pd) => {
      const peaks = pd.events.map((e) => e.peakBps);
      const durations = pd.events.map((e) => e.durationMs);
      return {
        pairId: pd.pairId,
        baseSymbol: pd.baseSymbol,
        eventCount: pd.events.length,
        p95PeakBps: Number(percentile(peaks, 95).toFixed(2)),
        medianDurationMs: Number(median(durations).toFixed(0)),
        totalPositiveDurationMs: durations.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => {
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
      return b.p95PeakBps - a.p95PeakBps;
    });

  const topPairs = pairEntries.slice(0, 5);
  const top3 = pairEntries.slice(0, 3);

  return {
    window: windowLabel,
    thresholdBps,
    windowDurationMs,
    totalEvents: windowEvents.length,
    eventsByPair,
    topPairs,
    p95PeakBps_top3: top3.map((p) => p.p95PeakBps),
    medianDurationMs_top3: top3.map((p) => p.medianDurationMs),
    totalPositiveDurationMs_top3: top3.reduce(
      (a, p) => a + p.totalPositiveDurationMs,
      0,
    ),
    eventCount_top3_total: top3.reduce((a, p) => a + p.eventCount, 0),
  };
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

/** --input flag for deterministic re-run from archive */
const INPUT_DIR_OVERRIDE = getArgStr("--input", "");

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  Kill Switch — Deterministic Decision Layer                  ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════╝\n`,
  );

  const dataDir = INPUT_DIR_OVERRIDE
    ? path.resolve(process.cwd(), INPUT_DIR_OVERRIDE)
    : path.resolve(process.cwd(), "data");

  if (INPUT_DIR_OVERRIDE) {
    console.log(`  📂 Deterministic re-run from: ${INPUT_DIR_OVERRIDE}`);
  }

  const eventsPath = path.join(dataDir, "arb_events.jsonl");
  const reportPath = path.join(dataDir, "killSwitchReport.json");

  // ── Load data ──
  let rawSamples: WatchSample[] | null = null;
  let eventsT1: WatchEvent[] = [];
  let eventsT2: WatchEvent[] = [];
  let dataStartTs = Infinity;
  let dataEndTs = -Infinity;
  let sourceDescription = "";

  // Try Option A: arb_events.jsonl (only at T1=10bps from watch mode)
  let hasEventsFile = false;
  try {
    const raw = await fs.readFile(eventsPath, "utf-8");
    const parsed = parseJsonl<WatchEvent>(raw);
    if (parsed.length > 0) {
      hasEventsFile = true;
      // These events are at T1 (10 bps threshold from watch mode)
      eventsT1 = parsed;
      for (const e of eventsT1) {
        if (e.startTs < dataStartTs) dataStartTs = e.startTs;
        if (e.endTs > dataEndTs) dataEndTs = e.endTs;
      }
      console.log(`  Loaded ${eventsT1.length} events from arb_events.jsonl (T1=${T1_BPS}bps)`);
      sourceDescription += `arb_events.jsonl(${eventsT1.length} events) `;
    }
  } catch {
    // No events file
  }

  // Always try to load raw samples for T2 reconstruction + timestamp range
  const { samples: loadedSamples, files: watchFiles } = await readAllWatchSamples(dataDir);
  if (loadedSamples.length > 0) {
    rawSamples = loadedSamples;
    for (const s of rawSamples) {
      if (s.ts < dataStartTs) dataStartTs = s.ts;
      if (s.ts > dataEndTs) dataEndTs = s.ts;
    }
    console.log(`  Loaded ${rawSamples.length} samples from ${watchFiles.length} watch file(s): ${watchFiles.join(", ")}`);
    sourceDescription += `watch(${rawSamples.length} samples from ${watchFiles.length} files)`;
  }

  // If no events file, reconstruct T1 from samples
  if (!hasEventsFile && rawSamples && rawSamples.length > 0) {
    console.log(`  Reconstructing T1 events from raw samples…`);
    eventsT1 = reconstructEvents(rawSamples, T1_BPS);
    console.log(`  Reconstructed ${eventsT1.length} T1 events (${T1_BPS}bps)`);
  }

  // Always reconstruct T2 from samples (watch mode only detects at T1=10bps)
  if (rawSamples && rawSamples.length > 0) {
    console.log(`  Reconstructing T2 events from raw samples…`);
    eventsT2 = reconstructEvents(rawSamples, T2_BPS);
    console.log(`  Reconstructed ${eventsT2.length} T2 events (${T2_BPS}bps)`);
  } else if (!hasEventsFile) {
    console.error(`\n  ✗ No data files found. Run 'npm run m3:watch' first.\n`);
    process.exit(1);
  }

  // If we only have events file but no samples, we cannot reconstruct T2
  // In that case, T2 events remain empty — decision will be conservative (FAIL)
  if (eventsT2.length === 0 && !rawSamples) {
    console.warn(`  ⚠ No raw samples available — cannot reconstruct T2 (${T2_BPS}bps) events.`);
    console.warn(`    T2 metrics will be empty. For full analysis, ensure arb_watch.jsonl exists.`);
  }

  const dataDurationMs = dataEndTs - dataStartTs;
  console.log(
    `\n  Data range: ${new Date(dataStartTs).toISOString()} → ${new Date(dataEndTs).toISOString()}`,
  );
  console.log(
    `  Duration:   ${(dataDurationMs / 3_600_000).toFixed(2)}h (${dataDurationMs}ms)`,
  );

  // ══════════════════════════════════════════════════════════════
  //  Compute window metrics
  // ══════════════════════════════════════════════════════════════

  const windowW6End = dataStartTs + W6_MS;
  const windowW24End = dataStartTs + W24_MS;

  const hasW6 = dataDurationMs >= W6_MS;
  const hasW24 = dataDurationMs >= W24_MS;

  let metricsT1_W6: WindowMetrics | null = null;
  let metricsT1_W24: WindowMetrics | null = null;
  let metricsT2_W6: WindowMetrics | null = null;
  let metricsT2_W24: WindowMetrics | null = null;

  if (hasW6) {
    metricsT1_W6 = computeWindowMetrics(eventsT1, "W6", T1_BPS, dataStartTs, windowW6End);
    metricsT2_W6 = computeWindowMetrics(eventsT2, "W6", T2_BPS, dataStartTs, windowW6End);
    console.log(`\n  W6 (T1=${T1_BPS}bps): ${metricsT1_W6.totalEvents} events`);
    console.log(`  W6 (T2=${T2_BPS}bps): ${metricsT2_W6.totalEvents} events`);
  } else {
    console.log(`\n  W6: not enough data (${(dataDurationMs / 3_600_000).toFixed(2)}h < 6h)`);
  }

  if (hasW24) {
    metricsT1_W24 = computeWindowMetrics(eventsT1, "W24", T1_BPS, dataStartTs, windowW24End);
    metricsT2_W24 = computeWindowMetrics(eventsT2, "W24", T2_BPS, dataStartTs, windowW24End);
    console.log(`  W24 (T1=${T1_BPS}bps): ${metricsT1_W24.totalEvents} events`);
    console.log(`  W24 (T2=${T2_BPS}bps): ${metricsT2_W24.totalEvents} events`);
  } else {
    console.log(`  W24: not enough data (${(dataDurationMs / 3_600_000).toFixed(2)}h < 24h)`);
  }

  // ══════════════════════════════════════════════════════════════
  //  Kill Switch Decision Logic
  // ══════════════════════════════════════════════════════════════

  const reasons: string[] = [];
  let verdict: "PASS" | "FAIL" | "INSUFFICIENT_DATA" = "PASS";
  let phase1 = "NOT_EVALUATED";

  // ── Guardrail: must have >= 24h of data ──
  if (!hasW24) {
    verdict = "INSUFFICIENT_DATA";
    reasons.push(
      `INSUFFICIENT_DATA: only ${(dataDurationMs / 3_600_000).toFixed(2)}h of data (need 24h)`,
    );
  }

  // ── Phase 1: Quick Fail (6h @ T1) ──
  if (hasW6 && metricsT1_W6) {
    if (metricsT1_W6.totalEvents === 0) {
      phase1 = "FAIL_FAST";
      reasons.push("FAIL_NO_EVENTS_T1_W6");
    } else {
      phase1 = "PASS";
    }
  }

  // ── Additional guardrails ──
  if (verdict !== "INSUFFICIENT_DATA") {
    // All events combined (T1 + T2 in W24)
    const allEventsW24 = [
      ...(metricsT1_W24 ? eventsT1.filter((e) => e.startTs >= dataStartTs && e.startTs < windowW24End) : []),
      ...(metricsT2_W24 ? eventsT2.filter((e) => e.startTs >= dataStartTs && e.startTs < windowW24End) : []),
    ];

    if (allEventsW24.length > 0) {
      // All events are < MIN_SAMPLES
      const allTooShort = allEventsW24.every((e) => e.sampleCount < MIN_SAMPLES);
      if (allTooShort) {
        verdict = "FAIL";
        reasons.push("FAIL_ALL_EVENTS_TOO_SHORT");
      }

      // All peaks < 5 bps
      const allPeaksTooLow = allEventsW24.every((e) => e.peakBps < 5);
      if (allPeaksTooLow) {
        verdict = "FAIL";
        reasons.push("FAIL_ALL_PEAKS_BELOW_5BPS");
      }
    }

    // ── Phase 2: Final Decision (24h @ T2) ──
    if (verdict !== "FAIL" && metricsT2_W24) {
      // Condition 1: totalEvents >= 10
      if (metricsT2_W24.totalEvents < 10) {
        verdict = "FAIL";
        reasons.push(
          `FAIL_TOTAL_EVENTS_T2_W24_LT_10 (got ${metricsT2_W24.totalEvents})`,
        );
      }

      // Condition 2: eventCount_top3_total >= 6
      if (metricsT2_W24.eventCount_top3_total < 6) {
        verdict = "FAIL";
        reasons.push(
          `FAIL_TOP3_EVENT_COUNT_LT_6 (got ${metricsT2_W24.eventCount_top3_total})`,
        );
      }

      // Condition 3: p95PeakBps >= 12 for at least 1 of top 3
      const anyPeakOk = metricsT2_W24.p95PeakBps_top3.some((v) => v >= 12);
      if (!anyPeakOk) {
        verdict = "FAIL";
        reasons.push(
          `FAIL_P95_PEAK_TOP3_LT_12BPS (got [${metricsT2_W24.p95PeakBps_top3.join(", ")}])`,
        );
      }

      // Condition 4: medianDurationMs >= 3000 for at least 1 of top 3
      const anyDurationOk = metricsT2_W24.medianDurationMs_top3.some(
        (v) => v >= 3000,
      );
      if (!anyDurationOk) {
        verdict = "FAIL";
        reasons.push(
          `FAIL_MEDIAN_DURATION_TOP3_LT_3000MS (got [${metricsT2_W24.medianDurationMs_top3.join(", ")}])`,
        );
      }
    } else if (verdict !== "FAIL" && (verdict as string) !== "INSUFFICIENT_DATA") {
      // No W24 T2 metrics
      verdict = "FAIL";
      reasons.push("FAIL_NO_T2_W24_METRICS");
    }
  }

  if (reasons.length === 0 && verdict === "PASS") {
    reasons.push("ALL_CONDITIONS_MET");
  }

  // ══════════════════════════════════════════════════════════════
  //  Build Report
  // ══════════════════════════════════════════════════════════════

  const report: KillSwitchReport = {
    generatedAt: new Date().toISOString(),
    dataRange: {
      startTs: dataStartTs,
      endTs: dataEndTs,
      durationMs: dataDurationMs,
    },
    thresholds: { T1: T1_BPS, T2: T2_BPS, K, minSamples: MIN_SAMPLES },
    windows: {
      W6: metricsT1_W6
        ? {
            ...metricsT1_W6,
            // Also include T2 W6 metrics in a combined view
          }
        : null,
      W24: metricsT2_W24 ?? null,
    },
    verdict,
    phase1,
    reasons,
  };

  // For a richer report, attach all 4 metric sets
  const richReport = {
    ...report,
    detailedMetrics: {
      T1_W6: metricsT1_W6,
      T1_W24: metricsT1_W24,
      T2_W6: metricsT2_W6,
      T2_W24: metricsT2_W24,
    },
    source: sourceDescription.trim(),
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(richReport, null, 2), "utf-8");

  // ══════════════════════════════════════════════════════════════
  //  Console Output
  // ══════════════════════════════════════════════════════════════

  console.log(`\n─── Kill Switch Report ──────────────────────────────────────\n`);

  // Phase 1
  console.log(`  Phase 1 (6h @ T1=${T1_BPS}bps): ${phase1}`);

  // W6 summary
  if (metricsT1_W6) {
    console.log(`    T1 events in W6: ${metricsT1_W6.totalEvents}`);
    if (metricsT1_W6.topPairs.length > 0) {
      console.log(`    Top pair: ${metricsT1_W6.topPairs[0].baseSymbol} (${metricsT1_W6.topPairs[0].eventCount} events, p95=${metricsT1_W6.topPairs[0].p95PeakBps} bps)`);
    }
  }

  if (metricsT2_W6) {
    console.log(`    T2 events in W6: ${metricsT2_W6.totalEvents}`);
  }

  // Phase 2
  console.log(`\n  Phase 2 (24h @ T2=${T2_BPS}bps):`);
  if (metricsT2_W24) {
    console.log(`    Total events:         ${metricsT2_W24.totalEvents} (need ≥10)`);
    console.log(`    Top3 event count:     ${metricsT2_W24.eventCount_top3_total} (need ≥6)`);
    console.log(`    Top3 p95PeakBps:      [${metricsT2_W24.p95PeakBps_top3.join(", ")}] (need ≥12 in ≥1)`);
    console.log(`    Top3 medianDuration:  [${metricsT2_W24.medianDurationMs_top3.join(", ")}]ms (need ≥3000 in ≥1)`);

    if (metricsT2_W24.topPairs.length > 0) {
      console.log(`\n    Top 5 pairs (T2 W24):`);
      for (const p of metricsT2_W24.topPairs) {
        console.log(
          `      ${p.baseSymbol.padEnd(10)} events=${String(p.eventCount).padStart(3)} p95Peak=${p.p95PeakBps.toFixed(1).padStart(6)}bps medDur=${String(p.medianDurationMs).padStart(6)}ms totalDur=${String(p.totalPositiveDurationMs).padStart(8)}ms`,
        );
      }
    }
  } else {
    console.log(`    No W24 T2 metrics available.`);
  }

  // Reasons
  if (reasons.length > 0 && reasons[0] !== "ALL_CONDITIONS_MET") {
    console.log(`\n  Reasons:`);
    for (const r of reasons) {
      console.log(`    • ${r}`);
    }
  }

  // Final verdict
  console.log(`\n  Report written to: ${reportPath}`);
  console.log();
  console.log(`  ╔═══════════════════════════════════════════════╗`);
  console.log(
    `  ║  KILL SWITCH: ${verdict.padEnd(31)} ║`,
  );
  console.log(`  ╚═══════════════════════════════════════════════╝`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
