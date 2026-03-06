/**
 * Stage3 — Execution Feasibility Re-Quote Pipeline
 *
 * Standalone pipeline that measures execution feasibility:
 *   1. Runs its own tick loop (1s default)
 *   2. Detects positive edge (≥10 bps) using same quote logic as arbWatch
 *   3. Waits 150ms then re-quotes ONLY the Orca (bottleneck) leg
 *   4. Logs decay metrics (quotedBps_0, quotedBps_150, decayBps, retained)
 *
 * No transactions — re-quote only.
 * No PASS gating — samples ALL edge events.
 *
 * Rationale:
 *   - Execution feasibility must be measured across ALL edge events
 *   - Edge existence is already validated in Stage2
 *   - PASS gating would create biased retention estimates
 *
 * Usage:
 *   npx tsx src/scripts/stage3Watch.ts --config <session_config.json>
 *   npx tsx src/scripts/stage3Watch.ts --config <session_config.json> --duration-min 10
 *   npm run stage3:watch -- --config <session_config.json>
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { promises as fs, createWriteStream, WriteStream } from "fs";
import path from "path";
import {
  USDC_MINT,
  USDC_DECIMALS,
  BUFFER_USDC_UNITS,
  type RaydiumPoolReserves,
  type OrcaPoolMeta,
  type PoolPairInput,
  type PairsFile,
  sleep,
  fetchRaydiumReserves,
  fetchOrcaPoolMeta,
  quoteRaydiumCpmmExactIn,
  quoteOrcaExactIn,
  checkMintDecimals,
  parallelLimit,
  fileTag,
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

/** Notionals to score each tick (USDC) */
const NOTIONALS = [30, 100] as const;

/** Directions */
type Direction = "O_TO_R" | "R_TO_O";
const DIRECTIONS: Direction[] = ["O_TO_R", "R_TO_O"];

/** Top N pairs */
const TOP_N = 20;

/** Event detection threshold: positive edge must be ≥ +10 bps */
const EVENT_THRESHOLD_BPS = 10;

/** Max parallel Jupiter (Orca) API calls */
const ORCA_CONCURRENCY = 15;

/** ABS_BPS_INSANE: invalidate if |netProfitBps| > 2000 */
const ABS_BPS_INSANE_LIMIT = 2000;

/** Hourly file rotation interval */
const ROTATE_INTERVAL_MS = 60 * 60 * 1000;

/** Heartbeat interval */
const HEARTBEAT_INTERVAL_MS = 60_000;

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionConfig {
  version: string;
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

interface Stage3Sample {
  timestampUTC: string;        // ISO 8601
  ts: number;                  // Unix ms
  symbol: string;              // baseSymbol (e.g. "SOL", "mSOL")
  pairId: string;              // Pool pair identifier (baseMint)
  notional: number;            // USDC notional (30 or 100)
  direction: "O_TO_R" | "R_TO_O";
  quotedBps_0: number;         // t0 netProfitBps
  quotedBps_150: number;       // t0+150ms netProfitBps
  decayBps: number;            // quotedBps_0 - quotedBps_150
  retained: boolean;           // quotedBps_150 > 0
  orcaOutUnits_0: string;      // t0 Orca outAmount (bigint string)
  orcaOutUnits_150: string;    // t0+150ms Orca outAmount (bigint string)
  invalidReason?: string;      // Re-quote failure reason
}

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

const CONFIG_FILE = getArgStr("--config", "");
const DURATION_MIN_OVERRIDE = getArgVal("--duration-min", 0);
const POLL_MS = getArgVal("--poll-ms", 1000);
const DELAY_MS = getArgVal("--delay-ms", 150);
const dryRun = args.includes("--dry");

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  Stage3 — Execution Feasibility Re-Quote Pipeline            ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════╝\n`,
  );

  // ── Load config ──
  if (!CONFIG_FILE) {
    console.error("  ✗ --config <session_config.json> is required.");
    process.exit(1);
  }

  let config: SessionConfig;
  try {
    const configPath = path.resolve(process.cwd(), CONFIG_FILE);
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as SessionConfig;
  } catch (err) {
    console.error(`  ✗ Failed to load config: ${CONFIG_FILE}`);
    console.error(`    ${err}`);
    process.exit(1);
  }

  console.log(`  Config:        ${CONFIG_FILE}`);
  console.log(`  runId:         ${config.runId}`);
  console.log(`  surfaceSymbols: [${config.surfaceSymbols.join(", ")}]`);
  console.log(`  excludeSymbols: [${config.excludeSymbols.join(", ")}]`);

  // ── Jupiter API key ──
  const jupiterApiKey = process.env.JUPITER_API_KEY;
  if (!jupiterApiKey) {
    console.error(
      "  ✗ JUPITER_API_KEY env var is required for Orca CLMM quotes.",
    );
    process.exit(1);
  }

  // ── Resolve output directory ──
  const outputDir = path.resolve(process.cwd(), config.outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  // ── Duration ──
  const effectiveDurationMin =
    DURATION_MIN_OVERRIDE > 0
      ? DURATION_MIN_OVERRIDE
      : config.session.durationMin;

  // ── Load pairs ──
  const pairsPath = path.join(
    path.resolve(process.cwd(), "data"),
    "route1_pool_pairs.json",
  );
  let pairsFile: PairsFile;
  try {
    const raw = await fs.readFile(pairsPath, "utf-8");
    pairsFile = JSON.parse(raw) as PairsFile;
  } catch {
    console.error(`  ✗ Failed to read ${pairsPath}`);
    console.error(`    Run 'npm run match:route1' first.`);
    process.exit(1);
  }

  // Deterministic ordering: sort by baseMint ascending, take TOP_N
  let pairs = pairsFile.pairs
    .sort((a, b) => a.baseMint.localeCompare(b.baseMint))
    .slice(0, TOP_N);

  // ── Surface filter ──
  if (config.surfaceSymbols.length > 0) {
    const surfaceSet = new Set(
      config.surfaceSymbols.map((s) => s.toUpperCase()),
    );
    pairs = pairs.filter((p) => surfaceSet.has(p.baseSymbol.toUpperCase()));
  }

  // ── Exclude filter ──
  if (config.excludeSymbols.length > 0) {
    const excludeSet = new Set(
      config.excludeSymbols.map((s) => s.toUpperCase()),
    );
    pairs = pairs.filter(
      (p) => !excludeSet.has(p.baseSymbol.toUpperCase()),
    );
  }

  if (pairs.length === 0) {
    console.error(`  ✗ No matched pairs after filtering.`);
    process.exit(1);
  }

  const durationMs = effectiveDurationMin * 60 * 1000;
  const combos = pairs.length * NOTIONALS.length * DIRECTIONS.length;

  console.log(`  Pairs:         ${pairs.length}`);
  console.log(`  Combos/tick:   ${combos}`);
  console.log(`  Poll:          ${POLL_MS}ms`);
  console.log(`  Re-quote delay: ${DELAY_MS}ms`);
  console.log(`  Duration:      ${effectiveDurationMin} min`);
  console.log(`  Edge threshold: ≥ ${EVENT_THRESHOLD_BPS} bps`);
  console.log(`  Output:        ${outputDir}`);
  console.log(`  Dry run:       ${dryRun}\n`);

  if (dryRun) {
    console.log(
      `  [DRY RUN] Would watch ${combos} combos for ${effectiveDurationMin} min.\n`,
    );
    return;
  }

  // ── Open rotating output stream ──
  let currentTag = fileTag(Date.now());
  let sampleStream: WriteStream = createWriteStream(
    path.join(outputDir, `stage3_samples_${currentTag}.jsonl`),
    { flags: "a" },
  );
  let lastRotateTs = Date.now();

  function maybeRotate(now: number): void {
    if (now - lastRotateTs < ROTATE_INTERVAL_MS) return;
    const newTag = fileTag(now);
    if (newTag === currentTag) return;
    sampleStream.end();
    currentTag = newTag;
    sampleStream = createWriteStream(
      path.join(outputDir, `stage3_samples_${currentTag}.jsonl`),
      { flags: "a" },
    );
    lastRotateTs = now;
    console.log(`  📁 Rotated → stage3_samples_${currentTag}.jsonl`);
  }

  // ── Counters ──
  let totalTicks = 0;
  let totalEdgesDetected = 0;
  let totalSamplesLogged = 0;
  let retainedCount = 0;
  let lastHeartbeatTs = Date.now();

  const startTime = Date.now();
  const endTime = startTime + durationMs;

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
    totalTicks++;

    const ts = Date.now();
    maybeRotate(ts);

    // 1. Fetch live data (parallel: Raydium reserves + Orca pool meta)
    let raydiumReserves: Map<string, RaydiumPoolReserves>;
    let orcaPoolMeta: Map<string, OrcaPoolMeta>;

    try {
      [raydiumReserves, orcaPoolMeta] = await Promise.all([
        fetchRaydiumReserves(pairs),
        fetchOrcaPoolMeta(pairs),
      ]);
    } catch {
      console.warn(`  [Tick ${totalTicks}] Data fetch failed, skipping`);
      await sleep(POLL_MS);
      continue;
    }

    // 2. Build quote tasks for all combos
    interface ComboQuote {
      pair: PoolPairInput;
      notional: number;
      direction: Direction;
      netProfitBps: number;
      orcaOutUnits: bigint;
      // For re-quote: which leg was Orca and the parameters
      orcaInputMint: string;
      orcaOutputMint: string;
      orcaInAmountUnits: bigint;
      valid: boolean;
      invalidReason?: string;
    }

    const quoteTasks: (() => Promise<ComboQuote>)[] = [];

    for (const pair of pairs) {
      const reserves = raydiumReserves.get(pair.raydiumPoolId);
      const orcaMeta = orcaPoolMeta.get(pair.orcaPoolId);
      const check = checkMintDecimals(pair, orcaMeta, reserves);

      for (const notional of NOTIONALS) {
        const notionalUnits = BigInt(notional) * BigInt(10 ** USDC_DECIMALS);

        for (const dir of DIRECTIONS) {
          if (!check.ok) {
            quoteTasks.push(async () => ({
              pair,
              notional,
              direction: dir,
              netProfitBps: 0,
              orcaOutUnits: 0n,
              orcaInputMint: "",
              orcaOutputMint: "",
              orcaInAmountUnits: 0n,
              valid: false,
              invalidReason: check.reason,
            }));
            continue;
          }

          quoteTasks.push(async (): Promise<ComboQuote> => {
            let buyOutUnits: bigint;
            let sellOutUnits: bigint;
            let orcaOutUnits: bigint;
            let orcaInputMint: string;
            let orcaOutputMint: string;
            let orcaInAmountUnits: bigint;

            if (dir === "O_TO_R") {
              // Buy on Orca (USDC → BASE), sell on Raydium (BASE → USDC)
              orcaInputMint = pair.quoteMint;
              orcaOutputMint = pair.baseMint;
              orcaInAmountUnits = notionalUnits;

              const buyResult = await quoteOrcaExactIn(
                pair.quoteMint,
                pair.baseMint,
                notionalUnits,
                jupiterApiKey,
              );
              if (!buyResult.ok) {
                return {
                  pair, notional, direction: dir,
                  netProfitBps: 0, orcaOutUnits: 0n,
                  orcaInputMint, orcaOutputMint, orcaInAmountUnits,
                  valid: false,
                  invalidReason: `Orca buy: ${buyResult.error}`,
                };
              }
              buyOutUnits = buyResult.outAmountUnits;
              orcaOutUnits = buyResult.outAmountUnits;

              const sellResult = quoteRaydiumCpmmExactIn(
                reserves!,
                pair.baseMint,
                buyOutUnits,
              );
              if (!sellResult.ok) {
                return {
                  pair, notional, direction: dir,
                  netProfitBps: 0, orcaOutUnits: 0n,
                  orcaInputMint, orcaOutputMint, orcaInAmountUnits,
                  valid: false,
                  invalidReason: `Raydium sell: ${sellResult.error}`,
                };
              }
              sellOutUnits = sellResult.outAmountUnits;
            } else {
              // R_TO_O: Buy on Raydium (USDC → BASE), sell on Orca (BASE → USDC)
              const buyResult = quoteRaydiumCpmmExactIn(
                reserves!,
                pair.quoteMint,
                notionalUnits,
              );
              if (!buyResult.ok) {
                return {
                  pair, notional, direction: dir,
                  netProfitBps: 0, orcaOutUnits: 0n,
                  orcaInputMint: "", orcaOutputMint: "", orcaInAmountUnits: 0n,
                  valid: false,
                  invalidReason: `Raydium buy: ${buyResult.error}`,
                };
              }
              buyOutUnits = buyResult.outAmountUnits;

              orcaInputMint = pair.baseMint;
              orcaOutputMint = pair.quoteMint;
              orcaInAmountUnits = buyOutUnits;

              const sellResult = await quoteOrcaExactIn(
                pair.baseMint,
                pair.quoteMint,
                buyOutUnits,
                jupiterApiKey,
              );
              if (!sellResult.ok) {
                return {
                  pair, notional, direction: dir,
                  netProfitBps: 0, orcaOutUnits: 0n,
                  orcaInputMint, orcaOutputMint, orcaInAmountUnits,
                  valid: false,
                  invalidReason: `Orca sell: ${sellResult.error}`,
                };
              }
              sellOutUnits = sellResult.outAmountUnits;
              orcaOutUnits = sellResult.outAmountUnits;
            }

            // Compute profit (identical to arbWatch)
            const grossProfitUnits = sellOutUnits - notionalUnits;
            const netProfitUnits = grossProfitUnits - BUFFER_USDC_UNITS;
            const netProfitBps =
              (Number(netProfitUnits) / Number(notionalUnits)) * 10_000;

            // ABS_BPS_INSANE check
            if (Math.abs(netProfitBps) > ABS_BPS_INSANE_LIMIT) {
              return {
                pair, notional, direction: dir,
                netProfitBps: 0, orcaOutUnits: 0n,
                orcaInputMint: "", orcaOutputMint: "", orcaInAmountUnits: 0n,
                valid: false,
                invalidReason: `|bps|=${Math.abs(netProfitBps).toFixed(1)} > ${ABS_BPS_INSANE_LIMIT}`,
              };
            }

            return {
              pair,
              notional,
              direction: dir,
              netProfitBps: Number(netProfitBps.toFixed(2)),
              orcaOutUnits,
              orcaInputMint,
              orcaOutputMint,
              orcaInAmountUnits,
              valid: true,
            };
          });
        }
      }
    }

    // 3. Execute all quote tasks with concurrency limit
    const results = await parallelLimit(quoteTasks, ORCA_CONCURRENCY);

    // 4. Filter for positive edges ≥ EVENT_THRESHOLD_BPS
    const edgeCombos = results.filter(
      (r) => r.valid && r.netProfitBps >= EVENT_THRESHOLD_BPS,
    );

    if (edgeCombos.length > 0) {
      totalEdgesDetected += edgeCombos.length;

      // 5. Wait DELAY_MS then re-quote only Orca leg
      await sleep(DELAY_MS);

      // Build re-quote tasks (only Orca leg)
      const reQuoteTasks: (() => Promise<void>)[] = [];

      for (const combo of edgeCombos) {
        reQuoteTasks.push(async () => {
          const now = Date.now();
          const reserves = raydiumReserves.get(combo.pair.raydiumPoolId);

          // Re-quote Orca with same parameters
          const reQuoteResult = await quoteOrcaExactIn(
            combo.orcaInputMint,
            combo.orcaOutputMint,
            combo.orcaInAmountUnits,
            jupiterApiKey,
          );

          let quotedBps_150 = 0;
          let orcaOutUnits_150 = "0";
          let invalidReason: string | undefined;

          if (!reQuoteResult.ok) {
            invalidReason = `Re-quote failed: ${reQuoteResult.error}`;
            orcaOutUnits_150 = "0";
            quotedBps_150 = 0;
          } else {
            orcaOutUnits_150 = reQuoteResult.outAmountUnits.toString();

            // Recompute profit with new Orca outAmount
            const notionalUnits =
              BigInt(combo.notional) * BigInt(10 ** USDC_DECIMALS);

            let sellOutUnits_150: bigint;

            if (combo.direction === "O_TO_R") {
              // Orca is buy leg: new buyOut → Raydium sell
              const sellResult = quoteRaydiumCpmmExactIn(
                reserves!,
                combo.pair.baseMint,
                reQuoteResult.outAmountUnits,
              );
              sellOutUnits_150 = sellResult.ok
                ? sellResult.outAmountUnits
                : 0n;
            } else {
              // Orca is sell leg: Raydium buy stays same, new Orca sell out
              sellOutUnits_150 = reQuoteResult.outAmountUnits;
            }

            if (sellOutUnits_150 > 0n) {
              const grossProfit_150 = sellOutUnits_150 - notionalUnits;
              const netProfit_150 = grossProfit_150 - BUFFER_USDC_UNITS;
              quotedBps_150 = Number(
                (
                  (Number(netProfit_150) / Number(notionalUnits)) *
                  10_000
                ).toFixed(2),
              );
            }
          }

          const decayBps = Number(
            (combo.netProfitBps - quotedBps_150).toFixed(2),
          );
          const retained = quotedBps_150 > 0;

          const sample: Stage3Sample = {
            timestampUTC: new Date(now).toISOString(),
            ts: now,
            symbol: combo.pair.baseSymbol,
            pairId: combo.pair.baseMint,
            notional: combo.notional,
            direction: combo.direction,
            quotedBps_0: combo.netProfitBps,
            quotedBps_150: quotedBps_150,
            decayBps,
            retained,
            orcaOutUnits_0: combo.orcaOutUnits.toString(),
            orcaOutUnits_150,
            ...(invalidReason ? { invalidReason } : {}),
          };

          sampleStream.write(JSON.stringify(sample) + "\n");
          totalSamplesLogged++;
          if (retained) retainedCount++;
        });
      }

      // Execute re-quotes with concurrency limit
      await parallelLimit(reQuoteTasks, ORCA_CONCURRENCY);
    }

    // ── Heartbeat (every 60s) ──
    if (ts - lastHeartbeatTs >= HEARTBEAT_INTERVAL_MS) {
      const retentionRate =
        totalSamplesLogged > 0
          ? ((retainedCount / totalSamplesLogged) * 100).toFixed(1)
          : "0.0";

      console.log(
        `  [Heartbeat] ticks=${totalTicks} edges=${totalEdgesDetected} samples=${totalSamplesLogged} retained=${retainedCount} (${retentionRate}%)`,
      );
      lastHeartbeatTs = ts;
    }

    // ── Periodic tick log ──
    if (totalTicks === 1 || totalTicks % 30 === 0) {
      const elapsed = Math.round((ts - startTime) / 1000);
      const remaining = Math.max(0, Math.round((endTime - ts) / 1000));
      console.log(
        `  [Tick ${totalTicks}] ${elapsed}s elapsed, ${remaining}s remaining | edges=${totalEdgesDetected} samples=${totalSamplesLogged}`,
      );
    }

    // ── Pace to poll interval ──
    const tickDuration = Date.now() - tickStart;
    const sleepTime = Math.max(0, POLL_MS - tickDuration);
    if (sleepTime > 0) await sleep(sleepTime);
  }

  // ── Close stream ──
  await new Promise<void>((resolve) => sampleStream.end(resolve));

  // ── Final summary ──
  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const retentionRate =
    totalSamplesLogged > 0
      ? ((retainedCount / totalSamplesLogged) * 100).toFixed(1)
      : "0.0";

  console.log(
    `\n─── Stage3 Watch Complete ──────────────────────────────────\n`,
  );
  console.log(`  Duration:       ${totalDuration}s (${totalTicks} ticks)`);
  console.log(`  Edges detected: ${totalEdgesDetected}`);
  console.log(`  Samples logged: ${totalSamplesLogged}`);
  console.log(`  Retained:       ${retainedCount} (${retentionRate}%)`);
  console.log(`  Re-quote delay: ${DELAY_MS}ms`);
  console.log(`  Output:         ${outputDir}/stage3_samples_*.jsonl`);
  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
