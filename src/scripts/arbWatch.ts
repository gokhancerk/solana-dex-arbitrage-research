/**
 * M3 — Quote-Only Watch (No Models, No Execution)
 *
 * Uses ONLY real quote outputs from each DEX:
 *   - Orca Whirlpools (CLMM): via Jupiter API with dexes=Whirlpool restriction
 *   - Raydium CPMM: actual on-chain reserves + CPMM constant-product formula
 *
 * Zero dependence on:
 *   - spot price math
 *   - TVL-based pricing
 *   - reserve-derived "phantom" models
 *   - price divergence heuristics
 *
 * If the 10-minute health run cannot produce valid samples, the project
 * is terminated (see m3Health.ts).
 *
 * Usage:
 *   npm run m3:watch                  # 60 min, 1s poll
 *   npm run m3:watch:6h               # 360 min
 *   npm run m3:watch:24h              # 1440 min
 *   npx tsx src/scripts/arbWatch.ts --duration-min 10 --poll-ms 1000
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs, createWriteStream, WriteStream } from "fs";
import path from "path";
import {
  USDC_MINT,
  USDC_DECIMALS,
  BUFFER_USDC_UNITS,
  JUP_QUOTE_URL,
  type InvalidRule,
  type RaydiumPoolReserves,
  type DexQuoteResult,
  type OrcaPoolMeta,
  type PoolPairInput,
  type PairsFile,
  sleep,
  fetchWithRetry,
  parallelLimit,
  fetchRaydiumReserves,
  fetchOrcaPoolMeta,
  quoteRaydiumCpmmExactIn,
  quoteOrcaExactIn,
  checkMintDecimals,
  fileTag,
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  Constants (local-only; shared constants imported from quoteUtils)
// ══════════════════════════════════════════════════════════════

/** Notionals to score each tick (USDC) */
const NOTIONALS = [30, 100] as const;

/** Directions */
type Direction = "O_TO_R" | "R_TO_O";
const DIRECTIONS: Direction[] = ["O_TO_R", "R_TO_O"];

/** Top N pairs (deterministic ordering, tie-break by baseMint asc) */
const TOP_N = 20;

/** Event detection thresholds */
const EVENT_THRESHOLD_BPS = 10;   // positive edge must be >= +10 bps
const EVENT_END_K = 3;            // K consecutive below threshold to close event
const EVENT_MIN_SAMPLES = 3;      // minimum samples for a valid event

/** Sample logging floor: only write valid samples with netProfitBps >= this */
const SAMPLE_LOG_MIN_BPS = -200;

/** ABS_BPS_INSANE: invalidate if |netProfitBps| > 2000 (±20%)
 *  Loose check — only catches catastrophic unit bugs */
const ABS_BPS_INSANE_LIMIT = 2000;

/** Heartbeat interval (every 60s) */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Hourly file rotation */
const ROTATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** M3 24h Manual Excludes — temporary prune for known ghost/stale pairs
 *  These are excluded ONLY from M3 watch, NOT global blacklist.
 *  Reversible by removing the entry. */
interface M3ManualExclude {
  pairId: string;       // baseMint (deterministic key)
  symbol: string;
  reasonCode: string;
  note: string;
}

const M3_24H_MANUAL_EXCLUDES: M3ManualExclude[] = [
  {
    pairId: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    reasonCode: "PRUNED_STALE_QUOTE_USDT",
    note: "MANUAL_EXCLUDE_24H_GHOST",
  },
];

/** Stage2 Config — runtime configuration for focused micro-runs */
interface Stage2Config {
  runId: string;
  durationHours: number;
  surfaceSymbols: string[];   // e.g., ["SOL", "mSOL", "whETH"]
  thresholds: {
    T1_bps: number;
    T2_bps: number;
  };
  excludeSymbols: string[];   // e.g., ["USDT"]
  mode: "quote_only";
  outputDir: string;          // e.g., "data/m3_stage2_12h/<timestamp>/"
}

/** Max parallel Jupiter (Orca) API calls per batch */
const ORCA_CONCURRENCY = 15;

// ══════════════════════════════════════════════════════════════
//  Types (shared types imported from quoteUtils; local-only types below)
// ══════════════════════════════════════════════════════════════

/** JSONL valid sample record */
interface WatchSample {
  ts: number;
  tickId: number;
  baseMint: string;
  baseSymbol: string;
  notional: number;         // human USDC
  direction: Direction;
  netProfitBps: number;
  netProfitUsdc: number;
  buyDex: "orca" | "raydium";
  sellDex: "orca" | "raydium";
  buyInUnits: string;       // USDC input (base units)
  buyOutUnits: string;      // BASE output (base units)
  sellInUnits: string;      // BASE input (= buyOutUnits)
  sellOutUnits: string;     // USDC output (base units)
  grossProfitUnits: string;
  bufferUnits: string;
  netProfitUnits: string;
}

/** JSONL invalid sample record */
interface InvalidSample {
  ts: number;
  tickId: number;
  pairId: string;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: Direction;
  invalidReason: string;
  invalidRule: InvalidRule;
  netProfitBps?: number;
  netProfitUsdc?: number;
}

/** JSONL event record */
interface WatchEvent {
  pairId: string;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: Direction;
  startTs: number;
  endTs: number;
  durationMs: number;
  peakBps: number;
  peakUsdc: number;
  sampleCount: number;
}

/** In-memory event tracker per (pair, notional, direction) */
interface EventTracker {
  active: boolean;
  startTs: number;
  startTickId: number;
  lastTs: number;
  lastTickId: number;
  peakBps: number;
  peakUsdc: number;
  peakTs: number;
  sampleCount: number;
  belowCount: number;
}

// ══════════════════════════════════════════════════════════════
//  Helpers (shared helpers imported from quoteUtils)
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  Raydium & Orca functions imported from shared/quoteUtils
// ══════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════
//  CLI Args
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

function getArgVal(name: string, def: number): number {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return Number(args[idx + 1]) || def;
  return def;
}

function getArgStr(name: string, def: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}

const DURATION_MIN = getArgVal("--duration-min", 60);
const POLL_MS = getArgVal("--poll-ms", 1000);
const dryRun = args.includes("--dry");
/** Custom pairs file (pruned whitelist for 24h runs) */
const PAIRS_FILE_OVERRIDE = getArgStr("--pairs-file", "");
/** Stage2 config file (focused micro-runs) */
const CONFIG_FILE = getArgStr("--config", "");

/** Load Stage2 config if provided */
async function loadStage2Config(): Promise<Stage2Config | null> {
  if (!CONFIG_FILE) return null;
  try {
    const configPath = path.resolve(process.cwd(), CONFIG_FILE);
    const raw = await fs.readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Stage2Config;
    console.log(`  ⚡ Stage2 config loaded: ${CONFIG_FILE}`);
    console.log(`    runId: ${cfg.runId}`);
    console.log(`    durationHours: ${cfg.durationHours}`);
    console.log(`    surfaceSymbols: [${cfg.surfaceSymbols.join(", ")}]`);
    console.log(`    excludeSymbols: [${cfg.excludeSymbols.join(", ")}]`);
    console.log(`    outputDir: ${cfg.outputDir}`);
    return cfg;
  } catch (err) {
    console.error(`  ✗ Failed to load Stage2 config: ${CONFIG_FILE}`);
    console.error(`    ${err}`);
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════
//  Main Watch Loop
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  M3 — Quote-Only Watch (No Models, No Execution)             ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════╝\n`,
  );

  // ── Load Stage2 config if provided ──
  const stage2Cfg = await loadStage2Config();
  const effectiveDurationMin = stage2Cfg
    ? stage2Cfg.durationHours * 60
    : DURATION_MIN;

  // ── Jupiter API key (required for Orca CLMM quotes) ──
  const jupiterApiKey = process.env.JUPITER_API_KEY;
  if (!jupiterApiKey) {
    console.error(
      "  ✗ JUPITER_API_KEY env var is required for Orca CLMM quotes.",
    );
    console.error("    Add JUPITER_API_KEY=<key> to .env file.");
    process.exit(1);
  }

  // ── Resolve output directory ──
  const dataDir = stage2Cfg
    ? path.resolve(process.cwd(), stage2Cfg.outputDir)
    : path.resolve(process.cwd(), "data");

  const pairsPath = PAIRS_FILE_OVERRIDE
    ? path.resolve(process.cwd(), PAIRS_FILE_OVERRIDE)
    : path.join(path.resolve(process.cwd(), "data"), "route1_pool_pairs.json");

  // ── Load pairs ──
  let pairsFile: PairsFile;
  try {
    const raw = await fs.readFile(pairsPath, "utf-8");
    pairsFile = JSON.parse(raw) as PairsFile;
  } catch {
    console.error(`  ✗ Failed to read ${pairsPath}`);
    console.error(`    Run 'npm run match:route1' first.`);
    process.exit(1);
  }

  if (PAIRS_FILE_OVERRIDE) {
    console.log(`  ⚡ Using pruned pairs file: ${path.basename(pairsPath)}`);
    console.log(`    Pairs loaded: ${pairsFile.pairs.length} (pruned from original)`);
  }

  // Deterministic ordering: sort by baseMint ascending, take TOP_N
  let pairs = pairsFile.pairs
    .sort((a, b) => a.baseMint.localeCompare(b.baseMint))
    .slice(0, TOP_N);

  // ── Stage2 surface filter (Top3 only) ──
  if (stage2Cfg && stage2Cfg.surfaceSymbols.length > 0) {
    const surfaceSet = new Set(
      stage2Cfg.surfaceSymbols.map((s) => s.toUpperCase()),
    );
    const beforeCount = pairs.length;
    pairs = pairs.filter((p) =>
      surfaceSet.has(p.baseSymbol.toUpperCase()),
    );
    console.log(
      `  ⚡ Stage2 surface filter: ${beforeCount} → ${pairs.length} pairs`,
    );
    console.log(
      `    Surface: [${stage2Cfg.surfaceSymbols.join(", ")}]`,
    );
  }

  // ── Stage2 exclude filter (e.g., USDT) ──
  if (stage2Cfg && stage2Cfg.excludeSymbols.length > 0) {
    const excludeSet = new Set(
      stage2Cfg.excludeSymbols.map((s) => s.toUpperCase()),
    );
    const beforeCount = pairs.length;
    pairs = pairs.filter(
      (p) => !excludeSet.has(p.baseSymbol.toUpperCase()),
    );
    if (beforeCount !== pairs.length) {
      console.log(
        `  ⚡ Stage2 exclude filter: ${beforeCount} → ${pairs.length} pairs`,
      );
      console.log(
        `    Excluded: [${stage2Cfg.excludeSymbols.join(", ")}]`,
      );
    }
  }

  // ── M3 24h Manual Excludes (ghost/stale quote prune) ──
  const is24hRun = effectiveDurationMin >= 1440;
  const prunedExcludes: M3ManualExclude[] = [];

  if (is24hRun && M3_24H_MANUAL_EXCLUDES.length > 0) {
    const excludeIds = new Set(M3_24H_MANUAL_EXCLUDES.map((e) => e.pairId));
    const beforeCount = pairs.length;

    pairs = pairs.filter((p) => {
      if (excludeIds.has(p.baseMint)) {
        const exc = M3_24H_MANUAL_EXCLUDES.find((e) => e.pairId === p.baseMint)!;
        prunedExcludes.push(exc);
        console.log(
          `  [M3-PRUNE] excluded pair=${p.baseMint.slice(0, 8)}... symbol=${p.baseSymbol} reason=${exc.reasonCode} note=${exc.note} run=24h`,
        );
        return false;
      }
      return true;
    });

    if (prunedExcludes.length > 0) {
      console.log(
        `  ⚠ M3 24h prune: ${prunedExcludes.length} pair(s) excluded (${beforeCount} → ${pairs.length})`,
      );

      // Write prune audit JSON
      const auditPath = path.join(dataDir, "m3_prune_audit.json");
      const auditRecord = {
        ts: Date.now(),
        isoTs: new Date().toISOString(),
        runMode: "m3_watch_24h",
        action: "exclude_from_pruned_set",
        excludes: prunedExcludes.map((e) => ({
          pairId: e.pairId,
          symbol: e.symbol,
          reasonCode: e.reasonCode,
          note: e.note,
          reversible: true,
        })),
        prunedManualExcludesCount: prunedExcludes.length,
        prunedManualExcludeSymbols: prunedExcludes.map((e) => e.symbol),
      };
      await fs.writeFile(auditPath, JSON.stringify(auditRecord, null, 2), "utf-8");
      console.log(`  📝 Prune audit written: ${auditPath}\n`);
    }
  }

  if (pairs.length === 0) {
    console.error(`  ✗ No matched pairs. Run M2 pipeline first.`);
    process.exit(1);
  }

  const durationMs = effectiveDurationMin * 60 * 1000;
  const combos = pairs.length * NOTIONALS.length * DIRECTIONS.length;

  console.log(`  Pairs:         ${pairs.length} (TOP_N=${TOP_N})`);
  console.log(`  Notionals:     ${NOTIONALS.join(", ")} USDC`);
  console.log(`  Directions:    O→R, R→O`);
  console.log(`  Combos/tick:   ${combos}`);
  console.log(`  Poll:          ${POLL_MS}ms`);
  console.log(`  Duration:      ${effectiveDurationMin} min`);
  console.log(`  Event:         ≥ ${EVENT_THRESHOLD_BPS} bps`);
  console.log(`  Sample log:    ≥ ${SAMPLE_LOG_MIN_BPS} bps`);
  console.log(`  Insane cap:    |bps| > ${ABS_BPS_INSANE_LIMIT}`);
  console.log(
    `  Buffer:        ${Number(BUFFER_USDC_UNITS) / 1e6} USDC (${BUFFER_USDC_UNITS} units)`,
  );
  console.log(
    `  Quote mode:    Orca=Jupiter(Whirlpool), Raydium=CPMM(actual reserves)`,
  );
  console.log(`  Dry run:       ${dryRun}\n`);

  if (dryRun) {
    console.log(
      `  [DRY RUN] Would watch ${combos} combos for ${effectiveDurationMin} min.\n`,
    );
    return;
  }

  // ── Open output streams ──
  await fs.mkdir(dataDir, { recursive: true });

  // ── Write Stage2 config to output dir if running Stage2 ──
  if (stage2Cfg) {
    const cfgOutPath = path.join(dataDir, "stage2_config.json");
    await fs.writeFile(cfgOutPath, JSON.stringify(stage2Cfg, null, 2), "utf-8");
    console.log(`  📝 Stage2 config copied to: ${cfgOutPath}`);
  }

  const eventsPath = path.join(dataDir, "arb_events.jsonl");
  const eventsStream: WriteStream = createWriteStream(eventsPath, {
    flags: "a",
  });


  // ── Hourly rotating watch + invalid streams ──
  let currentTag = fileTag(Date.now());
  let watchStream: WriteStream = createWriteStream(
    path.join(dataDir, `arb_watch_${currentTag}.jsonl`),
    { flags: "a" },
  );
  let invalidStream: WriteStream = createWriteStream(
    path.join(dataDir, `arb_watch_invalid_${currentTag}.jsonl`),
    { flags: "a" },
  );
  let lastRotateTs = Date.now();

  function maybeRotate(now: number): void {
    if (now - lastRotateTs < ROTATE_INTERVAL_MS) return;
    const newTag = fileTag(now);
    if (newTag === currentTag) return;
    watchStream.end();
    invalidStream.end();
    currentTag = newTag;
    watchStream = createWriteStream(
      path.join(dataDir, `arb_watch_${currentTag}.jsonl`),
      { flags: "a" },
    );
    invalidStream = createWriteStream(
      path.join(dataDir, `arb_watch_invalid_${currentTag}.jsonl`),
      { flags: "a" },
    );
    lastRotateTs = now;
    console.log(`  📁 Rotated → arb_watch_${currentTag}.jsonl`);
  }

  // ── Initialize event trackers ──
  const trackers = new Map<string, EventTracker>();
  for (const pair of pairs) {
    for (const notional of NOTIONALS) {
      for (const dir of DIRECTIONS) {
        const key = `${pair.baseMint}:${notional}:${dir}`;
        trackers.set(key, {
          active: false,
          startTs: 0,
          startTickId: 0,
          lastTs: 0,
          lastTickId: 0,
          peakBps: 0,
          peakUsdc: 0,
          peakTs: 0,
          sampleCount: 0,
          belowCount: 0,
        });
      }
    }
  }

  // ── Counters ──
  let totalSamples = 0;
  let validSamples = 0;
  let invalidSamplesCount = 0;
  let writtenSamples = 0;
  let totalEvents = 0;
  let bestBpsEver = -Infinity;
  let bestComboEver = "";

  // ── Variance tracking (NoPriceMovement detection) ──
  const lastBuyOutMap = new Map<string, bigint>();
  let quoteChangeCount = 0;
  let lastHeartbeatTs = Date.now();

  const startTime = Date.now();
  const endTime = startTime + durationMs;
  let tickCount = 0;

  console.log(`  Start: ${new Date(startTime).toISOString()}`);
  console.log(`  End:   ${new Date(endTime).toISOString()}\n`);

  // Graceful shutdown
  let running = true;
  const shutdown = () => {
    running = false;
    console.log(`\n  ⚡ Shutdown signal received, finishing…`);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ═══════════════════════════════════════════════════════════
  //  Tick Loop
  // ═══════════════════════════════════════════════════════════

  while (running && Date.now() < endTime) {
    const tickStart = Date.now();
    tickCount++;

    // 1. Fetch live data (parallel: Raydium reserves + Orca pool meta)
    let raydiumReserves: Map<string, RaydiumPoolReserves>;
    let orcaPoolMeta: Map<string, OrcaPoolMeta>;

    try {
      [raydiumReserves, orcaPoolMeta] = await Promise.all([
        fetchRaydiumReserves(pairs),
        fetchOrcaPoolMeta(pairs),
      ]);
    } catch {
      console.warn(`  [Tick ${tickCount}] Data fetch failed, skipping`);
      await sleep(POLL_MS);
      continue;
    }

    const ts = Date.now();
    maybeRotate(ts);

    // 2. Build scoring tasks — each handles one (pair, notional, direction) combo
    interface ComboResult {
      valid: boolean;
      invalidRule?: InvalidRule;
      invalidReason?: string;
      pair: PoolPairInput;
      notional: number;
      direction: Direction;
      notionalUnits: bigint;
      buyDex?: "orca" | "raydium";
      sellDex?: "orca" | "raydium";
      buyOutUnits?: bigint;
      sellOutUnits?: bigint;
      netProfitBps?: number;
      netProfitUsdc?: number;
      grossProfitUnits?: bigint;
      netProfitUnits?: bigint;
    }

    const scoringTasks: (() => Promise<ComboResult>)[] = [];

    for (const pair of pairs) {
      const reserves = raydiumReserves.get(pair.raydiumPoolId);
      const orcaMeta = orcaPoolMeta.get(pair.orcaPoolId);

      // Pre-check: mint / decimals
      const check = checkMintDecimals(pair, orcaMeta, reserves);

      for (const notional of NOTIONALS) {
        const notionalUnits = BigInt(notional) * BigInt(10 ** USDC_DECIMALS);

        for (const dir of DIRECTIONS) {
          if (!check.ok) {
            // Structural failure → mark invalid (no async work needed)
            const inv: ComboResult = {
              valid: false,
              invalidRule: "MINT_OR_DECIMALS_MISMATCH",
              invalidReason: check.reason!,
              pair,
              notional,
              direction: dir,
              notionalUnits,
            };
            scoringTasks.push(async () => inv);
            continue;
          }

          // ── Build async scoring task for this combo ──
          scoringTasks.push(async (): Promise<ComboResult> => {
            let buyOutUnits: bigint;
            let sellOutUnits: bigint;
            let buyDex: "orca" | "raydium";
            let sellDex: "orca" | "raydium";

            if (dir === "O_TO_R") {
              buyDex = "orca";
              sellDex = "raydium";

              // Buy on Orca (USDC → BASE) via Jupiter/Whirlpool
              const buyResult = await quoteOrcaExactIn(
                pair.quoteMint,
                pair.baseMint,
                notionalUnits,
                jupiterApiKey,
              );
              if (!buyResult.ok) {
                return {
                  valid: false,
                  invalidRule: "QUOTE_FAIL",
                  invalidReason: `Orca buy: ${buyResult.error}`,
                  pair,
                  notional,
                  direction: dir,
                  notionalUnits,
                };
              }
              buyOutUnits = buyResult.outAmountUnits;

              // Sell on Raydium (BASE → USDC) using actual reserves
              const sellResult = quoteRaydiumCpmmExactIn(
                reserves!,
                pair.baseMint,
                buyOutUnits,
              );
              if (!sellResult.ok) {
                return {
                  valid: false,
                  invalidRule: "QUOTE_FAIL",
                  invalidReason: `Raydium sell: ${sellResult.error}`,
                  pair,
                  notional,
                  direction: dir,
                  notionalUnits,
                };
              }
              sellOutUnits = sellResult.outAmountUnits;
            } else {
              // R_TO_O: Buy on Raydium (USDC → BASE)
              buyDex = "raydium";
              sellDex = "orca";

              const buyResult = quoteRaydiumCpmmExactIn(
                reserves!,
                pair.quoteMint,
                notionalUnits,
              );
              if (!buyResult.ok) {
                return {
                  valid: false,
                  invalidRule: "QUOTE_FAIL",
                  invalidReason: `Raydium buy: ${buyResult.error}`,
                  pair,
                  notional,
                  direction: dir,
                  notionalUnits,
                };
              }
              buyOutUnits = buyResult.outAmountUnits;

              // Sell on Orca (BASE → USDC) via Jupiter/Whirlpool
              const sellResult = await quoteOrcaExactIn(
                pair.baseMint,
                pair.quoteMint,
                buyOutUnits,
                jupiterApiKey,
              );
              if (!sellResult.ok) {
                return {
                  valid: false,
                  invalidRule: "QUOTE_FAIL",
                  invalidReason: `Orca sell: ${sellResult.error}`,
                  pair,
                  notional,
                  direction: dir,
                  notionalUnits,
                };
              }
              sellOutUnits = sellResult.outAmountUnits;
            }

            // ── Compute profit (all in USDC base units) ──
            //   grossProfitUnits = usdcOutUnits - notionalUsdcUnits
            //   netProfitUnits = grossProfitUnits - BUFFER_USDC_UNITS
            //   netProfitUsdc = netProfitUnits / 1e6
            //   netProfitBps = (netProfitUnits / notionalUsdcUnits) * 10_000
            const grossProfitUnits = sellOutUnits - notionalUnits;
            const netProfitUnits = grossProfitUnits - BUFFER_USDC_UNITS;
            const netProfitUsdc =
              Number(netProfitUnits) / 10 ** USDC_DECIMALS;
            const netProfitBps =
              (Number(netProfitUnits) / Number(notionalUnits)) * 10_000;

            // ABS_BPS_INSANE — only catches catastrophic unit bugs
            if (Math.abs(netProfitBps) > ABS_BPS_INSANE_LIMIT) {
              return {
                valid: false,
                invalidRule: "ABS_BPS_INSANE",
                invalidReason: `|bps|=${Math.abs(netProfitBps).toFixed(1)} > ${ABS_BPS_INSANE_LIMIT}`,
                pair,
                notional,
                direction: dir,
                notionalUnits,
                netProfitBps: Number(netProfitBps.toFixed(2)),
                netProfitUsdc: Number(netProfitUsdc.toFixed(6)),
              };
            }

            return {
              valid: true,
              pair,
              notional,
              direction: dir,
              notionalUnits,
              buyDex,
              sellDex,
              buyOutUnits,
              sellOutUnits,
              netProfitBps: Number(netProfitBps.toFixed(2)),
              netProfitUsdc: Number(netProfitUsdc.toFixed(6)),
              grossProfitUnits,
              netProfitUnits,
            };
          });
        }
      }
    }

    // 3. Execute all scoring tasks with concurrency limit
    const results = await parallelLimit(scoringTasks, ORCA_CONCURRENCY);

    // 4. Process results: write samples, track events
    let tickBest = -Infinity;
    let tickBestCombo = "";

    for (const r of results) {
      totalSamples++;

      if (!r.valid) {
        invalidSamplesCount++;
        const inv: InvalidSample = {
          ts,
          tickId: tickCount,
          pairId: r.pair.baseMint,
          baseMint: r.pair.baseMint,
          baseSymbol: r.pair.baseSymbol,
          notional: r.notional,
          direction: r.direction,
          invalidReason: r.invalidReason!,
          invalidRule: r.invalidRule!,
          ...(r.netProfitBps !== undefined
            ? {
                netProfitBps: r.netProfitBps,
                netProfitUsdc: r.netProfitUsdc,
              }
            : {}),
        };
        invalidStream.write(JSON.stringify(inv) + "\n");
        continue;
      }

      // ═══ Valid sample ═══
      validSamples++;

      // Variance tracking: detect quote changes per combo
      const changeKey = `${r.pair.baseMint}:${r.notional}:${r.direction}`;
      const prevOut = lastBuyOutMap.get(changeKey);
      if (prevOut !== undefined && prevOut !== r.buyOutUnits) {
        quoteChangeCount++;
      }
      lastBuyOutMap.set(changeKey, r.buyOutUnits!);

      // Write JSONL sample (if above log floor)
      if (r.netProfitBps! >= SAMPLE_LOG_MIN_BPS) {
        const sample: WatchSample = {
          ts,
          tickId: tickCount,
          baseMint: r.pair.baseMint,
          baseSymbol: r.pair.baseSymbol,
          notional: r.notional,
          direction: r.direction,
          netProfitBps: r.netProfitBps!,
          netProfitUsdc: r.netProfitUsdc!,
          buyDex: r.buyDex!,
          sellDex: r.sellDex!,
          buyInUnits: r.notionalUnits.toString(),
          buyOutUnits: r.buyOutUnits!.toString(),
          sellInUnits: r.buyOutUnits!.toString(), // invariant: sell input == buy output
          sellOutUnits: r.sellOutUnits!.toString(),
          grossProfitUnits: r.grossProfitUnits!.toString(),
          bufferUnits: BUFFER_USDC_UNITS.toString(),
          netProfitUnits: r.netProfitUnits!.toString(),
        };
        watchStream.write(JSON.stringify(sample) + "\n");
        writtenSamples++;
      }

      // Track best for tick and overall
      if (r.netProfitBps! > tickBest) {
        tickBest = r.netProfitBps!;
        tickBestCombo = `${r.pair.baseSymbol} ${r.notional}$ ${r.direction}`;
      }
      if (r.netProfitBps! > bestBpsEver) {
        bestBpsEver = r.netProfitBps!;
        bestComboEver = `${r.pair.baseSymbol} ${r.notional}$ ${r.direction}`;
      }

      // ── Event tracking (valid samples only) ──
      const trackerKey = `${r.pair.baseMint}:${r.notional}:${r.direction}`;
      const tracker = trackers.get(trackerKey)!;

      if (r.netProfitBps! >= EVENT_THRESHOLD_BPS) {
        if (!tracker.active) {
          // Start new event
          tracker.active = true;
          tracker.startTs = ts;
          tracker.startTickId = tickCount;
          tracker.peakBps = r.netProfitBps!;
          tracker.peakUsdc = r.netProfitUsdc!;
          tracker.peakTs = ts;
          tracker.sampleCount = 1;
          tracker.belowCount = 0;
        } else {
          // Continue event
          tracker.sampleCount++;
          tracker.belowCount = 0;
          if (r.netProfitBps! > tracker.peakBps) {
            tracker.peakBps = r.netProfitBps!;
            tracker.peakUsdc = r.netProfitUsdc!;
            tracker.peakTs = ts;
          }
        }
        tracker.lastTs = ts;
        tracker.lastTickId = tickCount;
      } else {
        // Below threshold
        if (tracker.active) {
          tracker.belowCount++;
          if (tracker.belowCount >= EVENT_END_K) {
            // Close event
            if (tracker.sampleCount >= EVENT_MIN_SAMPLES) {
              const event: WatchEvent = {
                pairId: r.pair.baseMint,
                baseMint: r.pair.baseMint,
                baseSymbol: r.pair.baseSymbol,
                notional: r.notional,
                direction: r.direction,
                startTs: tracker.startTs,
                endTs: tracker.lastTs,
                durationMs: tracker.lastTs - tracker.startTs,
                peakBps: tracker.peakBps,
                peakUsdc: tracker.peakUsdc,
                sampleCount: tracker.sampleCount,
              };
              eventsStream.write(JSON.stringify(event) + "\n");
              totalEvents++;
              console.log(
                `  🔔 EVENT: ${r.pair.baseSymbol} ${r.notional}$ ${r.direction} — peak=${tracker.peakBps.toFixed(1)}bps, ${tracker.sampleCount} samples, ${tracker.lastTs - tracker.startTs}ms`,
              );
            }
            // Reset tracker
            tracker.active = false;
            tracker.startTs = 0;
            tracker.startTickId = 0;
            tracker.lastTs = 0;
            tracker.lastTickId = 0;
            tracker.peakBps = 0;
            tracker.peakUsdc = 0;
            tracker.peakTs = 0;
            tracker.sampleCount = 0;
            tracker.belowCount = 0;
          }
        }
      }
    }

    // ── Heartbeat every 60s ──
    if (ts - lastHeartbeatTs >= HEARTBEAT_INTERVAL_MS) {
      const noPriceMovement = quoteChangeCount === 0;
      const activeEvents = Array.from(trackers.values()).filter(
        (t) => t.active,
      ).length;

      if (noPriceMovement) {
        console.warn(
          `  ⚠ NO_PRICE_MOVEMENT: no quote changes detected in last 60s`,
        );
      }

      console.log(
        `  [Heartbeat] totalSamples=${totalSamples} validSamples=${validSamples} invalidSamples=${invalidSamplesCount} invalidRate=${totalSamples > 0 ? ((invalidSamplesCount / totalSamples) * 100).toFixed(1) : "0"}% eventsWrittenCount=${totalEvents} activeEventsCount=${activeEvents} quoteChanges=${quoteChangeCount}`,
      );

      quoteChangeCount = 0;
      lastHeartbeatTs = ts;
    }

    // ── Periodic tick log ──
    if (tickCount === 1 || tickCount % 30 === 0) {
      const elapsed = Math.round((ts - startTime) / 1000);
      const remaining = Math.max(0, Math.round((endTime - ts) / 1000));
      console.log(
        `  [Tick ${tickCount}] ${elapsed}s elapsed, ${remaining}s remaining | valid=${validSamples} invalid=${invalidSamplesCount} events=${totalEvents} | tickBest=${tickBest > -Infinity ? tickBest.toFixed(1) : "–"}bps (${tickBestCombo || "–"}) | bestEver=${bestBpsEver > -Infinity ? bestBpsEver.toFixed(1) : "–"}bps`,
      );
    }

    // ── Pace to poll interval ──
    const tickDuration = Date.now() - tickStart;
    const sleepTime = Math.max(0, POLL_MS - tickDuration);
    if (sleepTime > 0) await sleep(sleepTime);
  }

  // ── Close any still-active events ──
  for (const [key, tracker] of trackers) {
    if (tracker.active && tracker.sampleCount >= EVENT_MIN_SAMPLES) {
      const [baseMint, notionalStr, dir] = key.split(":");
      const pair = pairs.find((p) => p.baseMint === baseMint);
      const event: WatchEvent = {
        pairId: baseMint,
        baseMint,
        baseSymbol: pair?.baseSymbol ?? baseMint.slice(0, 8),
        notional: Number(notionalStr),
        direction: dir as Direction,
        startTs: tracker.startTs,
        endTs: tracker.lastTs,
        durationMs: tracker.lastTs - tracker.startTs,
        peakBps: tracker.peakBps,
        peakUsdc: tracker.peakUsdc,
        sampleCount: tracker.sampleCount,
      };
      eventsStream.write(JSON.stringify(event) + "\n");
      totalEvents++;
    }
  }

  // ── Close streams ──
  await new Promise<void>((resolve) => watchStream.end(resolve));
  await new Promise<void>((resolve) => invalidStream.end(resolve));
  await new Promise<void>((resolve) => eventsStream.end(resolve));

  // ── Final summary ──
  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const validRate =
    totalSamples > 0
      ? ((validSamples / totalSamples) * 100).toFixed(1)
      : "0";
  const invalidRate =
    totalSamples > 0
      ? ((invalidSamplesCount / totalSamples) * 100).toFixed(1)
      : "0";

  console.log(
    `\n─── Watch Complete ─────────────────────────────────────────\n`,
  );
  console.log(`  Duration:      ${totalDuration}s (${tickCount} ticks)`);
  console.log(`  Total samples: ${totalSamples}`);
  console.log(`  Valid:         ${validSamples} (${validRate}%)`);
  console.log(
    `  Written:       ${writtenSamples} (≥ ${SAMPLE_LOG_MIN_BPS} bps filter)`,
  );
  console.log(`  Invalid:       ${invalidSamplesCount} (${invalidRate}%)`);
  console.log(`  Total events:  ${totalEvents}`);
  console.log(
    `  Best edge:     ${bestBpsEver > -Infinity ? bestBpsEver.toFixed(1) : "–"} bps (${bestComboEver || "–"})`,
  );
  console.log(
    `  Watch files:   ${dataDir}/arb_watch_*.jsonl (hourly rotated)`,
  );
  console.log(`  Invalid files: ${dataDir}/arb_watch_invalid_*.jsonl`);
  console.log(`  Events file:   ${eventsPath}`);

  if (totalEvents === 0) {
    console.log(
      `\n  ⚠ No positive events found at threshold +${EVENT_THRESHOLD_BPS} bps.`,
    );
  }

  // M3 24h prune summary
  if (prunedExcludes.length > 0) {
    console.log(`  ─── M3 Prune Summary ───`);
    console.log(`  prunedManualExcludesCount: ${prunedExcludes.length}`);
    console.log(`  prunedManualExcludeSymbols: [${prunedExcludes.map((e) => e.symbol).join(", ")}]`);
  }

  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
