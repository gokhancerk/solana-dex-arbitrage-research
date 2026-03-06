/**
 * M3 — Analyze Arb Watch Results
 *
 * Parses arb_watch.jsonl + arb_events.jsonl produced by arbWatch.ts
 * and outputs data/arb_watch_summary.json.
 *
 * Usage:
 *   npm run m3:analyze
 *   npx tsx src/scripts/analyzeArbWatch.ts
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Glob helper — read all arb_watch*.jsonl files from data/
// ══════════════════════════════════════════════════════════════

async function readAllWatchSamples(dataDir: string): Promise<{ samples: WatchSample[]; files: string[] }> {
  const entries = await fs.readdir(dataDir);
  const watchFiles = entries
    .filter((f) => /^arb_watch_(?!invalid).*\.jsonl$/.test(f))
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
//  Types (matching arbWatch.ts output)
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
  orca: { impactPct: number; feeUsdc: number; tvl: number; price: number };
  raydium: { impactPct: number; feeUsdc: number; tvl: number; price?: number };
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
}

// ── Summary types ──

interface PairStat {
  baseMint: string;
  baseSymbol: string;
  totalSamples: number;
  positiveSamples: number;
  positiveRatio: number;
  /** Min / max / mean / median of netProfitBps */
  bpsMin: number;
  bpsMax: number;
  bpsMean: number;
  bpsMedian: number;
  bpsP95: number;
  /** Events for this pair */
  eventCount: number;
  totalPositiveDurationMs: number;
  medianDurationMs: number | null;
  p95PeakBps: number | null;
  bestDirection: string;
  bestNotional: number;
  /** Composite score for ranking */
  compositeScore: number;
}

interface SummaryOutput {
  generatedAt: string;
  sampleFile: string;
  eventFile: string;
  totalSamples: number;
  totalEvents: number;
  timeRangeMs: number;
  uniquePairs: number;
  pairStats: PairStat[];
  topCandidates: Array<{
    rank: number;
    baseSymbol: string;
    baseMint: string;
    compositeScore: number;
    eventCount: number;
    p95PeakBps: number | null;
    bestDirection: string;
    bestNotional: number;
  }>;
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

function minMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0];
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const value = arr[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
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
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  M3 — Analyze Arb Watch Results                              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const dataDir = INPUT_DIR_OVERRIDE
    ? path.resolve(process.cwd(), INPUT_DIR_OVERRIDE)
    : path.resolve(process.cwd(), "data");

  if (INPUT_DIR_OVERRIDE) {
    console.log(`  📂 Deterministic re-run from: ${INPUT_DIR_OVERRIDE}`);
  }
  const eventsPath = path.join(dataDir, "arb_events.jsonl");
  const summaryPath = path.join(dataDir, "arb_watch_summary.json");

  // ── Load samples from all rotated watch files ──
  let samples: WatchSample[];
  const { samples: loadedSamples, files: watchFiles } = await readAllWatchSamples(dataDir);
  if (loadedSamples.length > 0) {
    samples = loadedSamples;
    console.log(`  Loaded ${samples.length} samples from ${watchFiles.length} watch file(s): ${watchFiles.join(", ")}`);
  } else {
    console.error(`  ✗ No arb_watch*.jsonl files found in ${dataDir}`);
    console.error(`    Run 'npm run m3:watch' first.`);
    process.exit(1);
  }

  // ── Load events ──
  let events: WatchEvent[] = [];
  try {
    const raw = await fs.readFile(eventsPath, "utf-8");
    events = parseJsonl<WatchEvent>(raw);
    console.log(`  Loaded ${events.length} events from arb_events.jsonl`);
  } catch {
    console.warn(`  ⚠ No events file found, continuing with 0 events.`);
  }

  if (samples.length === 0) {
    console.error(`  ✗ No samples to analyze.`);
    process.exit(1);
  }

  // ── Time range ──
  const tsValues = samples.map((s) => s.ts);
  const { min: minTs, max: maxTs } = minMax(tsValues);
  const timeRangeMs = maxTs - minTs;

  console.log(`  Time range: ${new Date(minTs).toISOString()} → ${new Date(maxTs).toISOString()}`);
  console.log(`  Duration: ${Math.round(timeRangeMs / 1000)}s\n`);

  // ── Group by baseMint ──
  const byPair = new Map<string, WatchSample[]>();
  for (const s of samples) {
    const arr = byPair.get(s.baseMint) ?? [];
    arr.push(s);
    byPair.set(s.baseMint, arr);
  }

  // ── Group events by baseMint ──
  const eventsByPair = new Map<string, WatchEvent[]>();
  for (const e of events) {
    const arr = eventsByPair.get(e.pairId) ?? [];
    arr.push(e);
    eventsByPair.set(e.pairId, arr);
  }

  // ── Compute per-pair stats ──
  const pairStats: PairStat[] = [];

  for (const [baseMint, pairSamples] of byPair) {
    const baseSymbol = pairSamples[0].baseSymbol;
    const allBps = pairSamples
      .map((s) => s.netProfitBps)
      .filter((value): value is number => Number.isFinite(value));
    if (allBps.length === 0) continue;
    const positiveSamples = pairSamples.filter((s) => s.netProfitBps > 0);

    // Find best direction/notional combo by median bps
    const combos = new Map<string, number[]>();
    for (const s of pairSamples) {
      const key = `${s.direction}:${s.notional}`;
      const arr = combos.get(key) ?? [];
      arr.push(s.netProfitBps);
      combos.set(key, arr);
    }

    let bestComboKey = "";
    let bestComboMedian = -Infinity;
    for (const [key, bpsArr] of combos) {
      const med = median(bpsArr);
      if (med > bestComboMedian) {
        bestComboMedian = med;
        bestComboKey = key;
      }
    }

    const [bestDir, bestNotStr] = bestComboKey.split(":");

    // Events for this pair
    const pairEvents = eventsByPair.get(baseMint) ?? [];
    const eventDurations = pairEvents.map((e) => e.durationMs);
    const eventPeaks = pairEvents.map((e) => e.peakBps);

    const stat: PairStat = {
      baseMint,
      baseSymbol,
      totalSamples: pairSamples.length,
      positiveSamples: positiveSamples.length,
      positiveRatio: Number((positiveSamples.length / pairSamples.length).toFixed(4)),
      bpsMin: Number(minMax(allBps).min.toFixed(2)),
      bpsMax: Number(minMax(allBps).max.toFixed(2)),
      bpsMean: Number((allBps.reduce((a, b) => a + b, 0) / allBps.length).toFixed(2)),
      bpsMedian: Number(median(allBps).toFixed(2)),
      bpsP95: Number(percentile(allBps, 95).toFixed(2)),
      eventCount: pairEvents.length,
      totalPositiveDurationMs: eventDurations.reduce((a, b) => a + b, 0),
      medianDurationMs: eventDurations.length > 0 ? median(eventDurations) : null,
      p95PeakBps: eventPeaks.length > 0 ? Number(percentile(eventPeaks, 95).toFixed(2)) : null,
      bestDirection: bestDir,
      bestNotional: Number(bestNotStr),
      // Composite = eventCount * p95PeakBps (or fallback to bpsP95 weight)
      compositeScore: pairEvents.length > 0
        ? pairEvents.length * (percentile(eventPeaks, 95))
        : Number(percentile(allBps, 95).toFixed(2)) * 0.01,
    };

    pairStats.push(stat);
  }

  // ── Sort pairStats by compositeScore desc ──
  pairStats.sort((a, b) => b.compositeScore - a.compositeScore);

  // ── Top 20 candidates ──
  const topCandidates = pairStats.slice(0, 20).map((s, i) => ({
    rank: i + 1,
    baseSymbol: s.baseSymbol,
    baseMint: s.baseMint,
    compositeScore: Number(s.compositeScore.toFixed(2)),
    eventCount: s.eventCount,
    p95PeakBps: s.p95PeakBps,
    bestDirection: s.bestDirection,
    bestNotional: s.bestNotional,
  }));

  // ── Build summary ──
  const summary: SummaryOutput = {
    generatedAt: new Date().toISOString(),
    sampleFile: watchFiles.join(", "),
    eventFile: eventsPath,
    totalSamples: samples.length,
    totalEvents: events.length,
    timeRangeMs,
    uniquePairs: byPair.size,
    pairStats,
    topCandidates,
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`  ✔ Summary written to ${summaryPath}\n`);

  // ── Console table ──
  console.log(`  ┌──────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`  │  Top Candidates by Composite Score (eventCount × p95PeakBps)                │`);
  console.log(`  ├──────┬──────────┬────────┬────────┬──────────┬────────┬───────────┬──────────┤`);
  console.log(`  │ Rank │ Symbol   │ Events │ p95Bps │ MedianMs │ bpsP95 │ BestDir   │ Notional │`);
  console.log(`  ├──────┼──────────┼────────┼────────┼──────────┼────────┼───────────┼──────────┤`);

  for (const c of topCandidates.slice(0, 20)) {
    const stat = pairStats.find((s) => s.baseMint === c.baseMint)!;
    console.log(
      `  │ ${String(c.rank).padStart(4)} │ ${c.baseSymbol.padEnd(8).slice(0, 8)} │ ${String(c.eventCount).padStart(6)} │ ${(c.p95PeakBps?.toFixed(1) ?? "n/a").padStart(6)} │ ${(stat.medianDurationMs?.toFixed(0) ?? "n/a").padStart(8)} │ ${stat.bpsP95.toFixed(1).padStart(6)} │ ${c.bestDirection.padEnd(9).slice(0, 9)} │ ${String(c.bestNotional).padStart(8)} │`,
    );
  }

  console.log(`  └──────┴──────────┴────────┴────────┴──────────┴────────┴───────────┴──────────┘\n`);

  // ── Global summary ──
  const allBps = samples.map((s) => s.netProfitBps);
  const finiteAllBps = allBps.filter((value): value is number => Number.isFinite(value));
  if (finiteAllBps.length === 0) {
    console.error(`  ✗ No numeric netProfitBps values to summarize.`);
    process.exit(1);
  }
  const globalPositive = finiteAllBps.filter((b) => b > 0).length;
  const { min: globalMinBps, max: globalMaxBps } = minMax(finiteAllBps);
  console.log(`  Global Stats:`);
  console.log(`    Min bps:           ${globalMinBps.toFixed(2)}`);
  console.log(`    Max bps:           ${globalMaxBps.toFixed(2)}`);
  console.log(`    Mean bps:          ${(finiteAllBps.reduce((a, b) => a + b, 0) / finiteAllBps.length).toFixed(2)}`);
  console.log(`    Median bps:        ${median(finiteAllBps).toFixed(2)}`);
  console.log(`    P95 bps:           ${percentile(finiteAllBps, 95).toFixed(2)}`);
  console.log(`    Positive %:        ${((globalPositive / finiteAllBps.length) * 100).toFixed(2)}%`);
  console.log(`    Unique events:     ${events.length}`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
