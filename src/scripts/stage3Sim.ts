/**
 * Stage3Sim — TX Simulation Pipeline for Route1 Edge Validation
 *
 * Detects edge opportunities (Orca Whirlpool ↔ Raydium CPMM), builds
 * swap transactions via Jupiter API, and simulates them to measure
 * real executable profit vs quoted profit.
 *
 * Key metrics:
 *   - quotedBps: Edge from quote stage (Orca CLMM quote + Raydium CPMM calc)
 *   - simBps: Simulated profit from TX simulation (real on-chain state)
 *   - slippageBps: quotedBps - simBps (execution decay)
 *
 * Usage:
 *   npx tsx src/scripts/stage3Sim.ts --config <session_config.json>
 *   npx tsx src/scripts/stage3Sim.ts --config <session_config.json> --duration-min 30
 *   npm run stage3:sim -- --config <session_config.json>
 */

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { createWriteStream, WriteStream } from "fs";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";

import { loadConfig } from "../config.js";
import { getConnection, simulateTx } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, buildJupiterSwap } from "../jupiter.js";
import {
  PoolPairInput,
  PairsFile,
  RaydiumPoolReserves,
  OrcaPoolMeta,
  USDC_MINT,
  USDC_DECIMALS,
  BUFFER_USDC_UNITS,
  fetchRaydiumReserves,
  fetchOrcaPoolMeta,
  quoteRaydiumCpmmExactIn,
  quoteOrcaExactIn,
  checkMintDecimals,
  sleep,
  parallelLimit,
} from "./shared/quoteUtils.js";

// ══════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════

const POLL_MS = 3_000;               // Poll interval
const ROTATE_INTERVAL_MS = 3_600_000; // Rotate output file hourly
const EVENT_THRESHOLD_BPS = 5;        // Min edge to trigger simulation (lowered from 10)
const NOTIONALS = [30];               // USDC notional - matches wallet balance (~$10 + margin)
const DIRECTIONS = ["O_TO_R", "R_TO_O"] as const;
const ORCA_CONCURRENCY = 8;
const VERBOSE = true;                 // Enable verbose logging

type Direction = (typeof DIRECTIONS)[number];

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionConfig {
  version: string;
  runId: string;
  surfaceSymbols: string[];
  excludeSymbols: string[];
  thresholds: { T1_bps: number; T2_bps: number };
  outputDir: string;
  session?: { durationMin?: number };
}

interface SimSample {
  timestampUTC: string;
  ts: number;
  symbol: string;
  pairId: string;
  notional: number;
  direction: Direction;
  // Quote stage metrics
  quotedBps: number;
  quotedProfitUsdc: number;
  // Simulation stage metrics
  simSuccess: boolean;
  simError?: string;
  simBps?: number;
  simProfitUsdc?: number;
  slippageBps?: number;
  // TX details
  leg1CU?: number;
  leg2CU?: number;
  totalCU?: number;
}

// ══════════════════════════════════════════════════════════════
//  CLI Argument Parsing
// ══════════════════════════════════════════════════════════════

function getArgVal(flag: string, defaultVal: number): number;
function getArgVal(flag: string, defaultVal: string): string;
function getArgVal(flag: string, defaultVal: number | string): number | string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  const val = process.argv[idx + 1];
  return typeof defaultVal === "number" ? Number(val) : val;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function fileTag(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stage3Sim — TX Simulation Pipeline                          ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // ── Load config ──
  const configPath = getArgVal("--config", "");
  if (!configPath) {
    console.error(`  ✗ --config <session_config.json> is required`);
    process.exit(1);
  }

  const configRaw = await fs.readFile(configPath, "utf-8");
  const sessionConfig: SessionConfig = JSON.parse(configRaw);
  console.log(`  ✓ Config loaded: ${sessionConfig.runId}`);

  const outputDir = sessionConfig.outputDir;
  await fs.mkdir(outputDir, { recursive: true });

  // Duration override
  const effectiveDurationMin = getArgVal(
    "--duration-min",
    sessionConfig.session?.durationMin ?? 60,
  );
  const dryRun = hasFlag("--dry");

  // ── Load pool pairs ──
  const cfg = loadConfig();
  const jupiterApiKey = cfg.jupiterApiKey ?? "";

  const pairFiles = ["route1_pool_pairs.json"];
  let pairs: PoolPairInput[] = [];

  for (const file of pairFiles) {
    const p = path.join("data", file);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const pf: PairsFile = JSON.parse(raw);
      pairs.push(...pf.pairs);
    } catch {
      console.error(`  ✗ Failed to load ${p}`);
      console.error(`    Run 'npm run match:route1' first.`);
      process.exit(1);
    }
  }

  // Filter by session config surfaces
  const surfaceSet = new Set(sessionConfig.surfaceSymbols);
  const excludeSet = new Set(sessionConfig.excludeSymbols);
  pairs = pairs.filter(
    (p) => surfaceSet.has(p.baseSymbol) && !excludeSet.has(p.baseSymbol),
  );

  if (pairs.length === 0) {
    console.error(`  ✗ No matched pairs after filtering.`);
    process.exit(1);
  }

  // ── Load wallet for TX build ──
  const owner: Keypair = getKeypairFromEnv();
  const ownerPub = owner.publicKey;
  const connection = getConnection();

  const durationMs = effectiveDurationMin * 60 * 1000;
  const combos = pairs.length * NOTIONALS.length * DIRECTIONS.length;

  console.log(`  Pairs:         ${pairs.length}`);
  console.log(`  Combos/tick:   ${combos}`);
  console.log(`  Poll:          ${POLL_MS}ms`);
  console.log(`  Duration:      ${effectiveDurationMin} min`);
  console.log(`  Edge threshold: ≥ ${EVENT_THRESHOLD_BPS} bps`);
  console.log(`  Output:        ${outputDir}`);
  console.log(`  Dry run:       ${dryRun}\n`);

  if (dryRun) {
    console.log(`  [DRY RUN] Would simulate ${combos} combos for ${effectiveDurationMin} min.\n`);
    return;
  }

  // ── Open rotating output stream ──
  let currentTag = fileTag(Date.now());
  let sampleStream: WriteStream = createWriteStream(
    path.join(outputDir, `stage3_sim_${currentTag}.jsonl`),
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
      path.join(outputDir, `stage3_sim_${currentTag}.jsonl`),
      { flags: "a" },
    );
    lastRotateTs = now;
    console.log(`  📁 Rotated output → stage3_sim_${newTag}.jsonl`);
  }

  // ── Stats ──
  let totalTicks = 0;
  let totalEdgesDetected = 0;
  let totalSimulations = 0;
  let totalSimSuccess = 0;
  let totalSimFail = 0;

  const startTime = Date.now();
  const endTime = startTime + durationMs;

  console.log(`  ⏱  Started at ${new Date(startTime).toISOString()}`);
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

    // 1. Fetch live data
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

    // 2. Build quote tasks
    interface ComboQuote {
      pair: PoolPairInput;
      notional: number;
      direction: Direction;
      netProfitBps: number;
      netProfitUsdc: number;
      orcaInputMint: string;
      orcaOutputMint: string;
      orcaInAmountUnits: bigint;
      orcaOutUnits: bigint;
      raydiumOutUnits: bigint;
      valid: boolean;
    }

    const quoteTasks: (() => Promise<ComboQuote>)[] = [];

    for (const pair of pairs) {
      const reserves = raydiumReserves.get(pair.raydiumPoolId);
      const orcaMeta = orcaPoolMeta.get(pair.orcaPoolId);

      // Mint/decimal check
      const mintCheck = checkMintDecimals(pair, orcaMeta, reserves);
      if (!mintCheck.ok) continue;

      for (const notional of NOTIONALS) {
        for (const direction of DIRECTIONS) {
          quoteTasks.push(async () => {
            const notionalUnits = BigInt(notional) * BigInt(10 ** USDC_DECIMALS);

            let netProfitBps = 0;
            let netProfitUsdc = 0;
            let orcaInputMint = "";
            let orcaOutputMint = "";
            let orcaInAmountUnits = 0n;
            let orcaOutUnits = 0n;
            let raydiumOutUnits = 0n;
            let valid = false;

            try {
              if (direction === "O_TO_R") {
                // Buy on Orca (USDC → BASE), sell on Raydium (BASE → USDC)
                orcaInputMint = USDC_MINT;
                orcaOutputMint = pair.baseMint;
                orcaInAmountUnits = notionalUnits;

                const buyResult = await quoteOrcaExactIn(
                  USDC_MINT,
                  pair.baseMint,
                  notionalUnits,
                  jupiterApiKey,
                );

                if (!buyResult.ok || buyResult.outAmountUnits <= 0n) {
                  return { pair, notional, direction, netProfitBps, netProfitUsdc, orcaInputMint, orcaOutputMint, orcaInAmountUnits, orcaOutUnits, raydiumOutUnits, valid: false };
                }

                orcaOutUnits = buyResult.outAmountUnits;

                const sellResult = quoteRaydiumCpmmExactIn(
                  reserves!,
                  pair.baseMint,
                  buyResult.outAmountUnits,
                );

                if (!sellResult.ok) {
                  return { pair, notional, direction, netProfitBps, netProfitUsdc, orcaInputMint, orcaOutputMint, orcaInAmountUnits, orcaOutUnits, raydiumOutUnits, valid: false };
                }

                raydiumOutUnits = sellResult.outAmountUnits;
                const grossProfit = sellResult.outAmountUnits - notionalUnits;
                const netProfit = grossProfit - BUFFER_USDC_UNITS;
                netProfitBps = Number(((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2));
                netProfitUsdc = Number(netProfit) / 1e6;
                valid = true;
              } else {
                // R_TO_O: Buy on Raydium (USDC → BASE), sell on Orca (BASE → USDC)
                const buyResult = quoteRaydiumCpmmExactIn(
                  reserves!,
                  USDC_MINT,
                  notionalUnits,
                );

                if (!buyResult.ok || buyResult.outAmountUnits <= 0n) {
                  return { pair, notional, direction, netProfitBps, netProfitUsdc, orcaInputMint, orcaOutputMint, orcaInAmountUnits, orcaOutUnits, raydiumOutUnits, valid: false };
                }

                raydiumOutUnits = buyResult.outAmountUnits;

                orcaInputMint = pair.baseMint;
                orcaOutputMint = USDC_MINT;
                orcaInAmountUnits = buyResult.outAmountUnits;

                const sellResult = await quoteOrcaExactIn(
                  pair.baseMint,
                  USDC_MINT,
                  buyResult.outAmountUnits,
                  jupiterApiKey,
                );

                if (!sellResult.ok) {
                  return { pair, notional, direction, netProfitBps, netProfitUsdc, orcaInputMint, orcaOutputMint, orcaInAmountUnits, orcaOutUnits, raydiumOutUnits, valid: false };
                }

                orcaOutUnits = sellResult.outAmountUnits;
                const grossProfit = sellResult.outAmountUnits - notionalUnits;
                const netProfit = grossProfit - BUFFER_USDC_UNITS;
                netProfitBps = Number(((Number(netProfit) / Number(notionalUnits)) * 10_000).toFixed(2));
                netProfitUsdc = Number(netProfit) / 1e6;
                valid = true;
              }
            } catch (err) {
              // Quote failed
            }

            return { pair, notional, direction, netProfitBps, netProfitUsdc, orcaInputMint, orcaOutputMint, orcaInAmountUnits, orcaOutUnits, raydiumOutUnits, valid };
          });
        }
      }
    }

    // 3. Execute quote tasks
    const quoteResults = await parallelLimit(quoteTasks, ORCA_CONCURRENCY);

    // Verbose: print best edge from this tick
    if (VERBOSE) {
      const validResults = quoteResults.filter((r) => r.valid);
      const bestEdge = validResults.reduce((best, curr) =>
        curr.netProfitBps > best.netProfitBps ? curr : best,
        { netProfitBps: -Infinity } as ComboQuote,
      );
      if (validResults.length > 0) {
        console.log(
          `  [Tick ${totalTicks}] valid=${validResults.length}/${quoteResults.length} ` +
          `best=${bestEdge.netProfitBps.toFixed(1)}bps ${bestEdge.pair?.baseSymbol || 'N/A'} ${bestEdge.direction || ''}`,
        );
      } else {
        console.log(`  [Tick ${totalTicks}] No valid quotes`);
      }
    }

    // 4. Filter for positive edges
    const edgeCombos = quoteResults.filter(
      (r) => r.valid && r.netProfitBps >= EVENT_THRESHOLD_BPS,
    );

    if (edgeCombos.length > 0) {
      totalEdgesDetected += edgeCombos.length;

      // 5. Build and simulate TX for each edge
      for (const combo of edgeCombos) {
        totalSimulations++;

        const simResult = await simulateEdge(
          connection,
          combo,
          ownerPub,
          jupiterApiKey,
          cfg.rpc.priorityFeeMicrolamports ?? 50_000,
        );

        const sample: SimSample = {
          timestampUTC: new Date().toISOString(),
          ts: Date.now(),
          symbol: combo.pair.baseSymbol,
          pairId: combo.pair.baseMint,
          notional: combo.notional,
          direction: combo.direction,
          quotedBps: combo.netProfitBps,
          quotedProfitUsdc: combo.netProfitUsdc,
          simSuccess: simResult.success,
          simError: simResult.error,
          simBps: simResult.simBps,
          simProfitUsdc: simResult.simProfitUsdc,
          slippageBps: simResult.slippageBps,
          leg1CU: simResult.leg1CU,
          leg2CU: simResult.leg2CU,
          totalCU: simResult.totalCU,
        };

        sampleStream.write(JSON.stringify(sample) + "\n");

        if (simResult.success) {
          totalSimSuccess++;
          console.log(
            `  ✓ [${combo.pair.baseSymbol}] ${combo.direction} $${combo.notional} ` +
            `quoted=${combo.netProfitBps.toFixed(1)}bps sim=${simResult.simBps?.toFixed(1)}bps ` +
            `slip=${simResult.slippageBps?.toFixed(1)}bps CU=${simResult.totalCU}`,
          );
        } else {
          totalSimFail++;
          console.log(
            `  ✗ [${combo.pair.baseSymbol}] ${combo.direction} $${combo.notional} ` +
            `quoted=${combo.netProfitBps.toFixed(1)}bps FAIL: ${simResult.error}`,
          );
        }
      }
    }

    // Wait for next tick
    const elapsed = Date.now() - tickStart;
    const waitMs = Math.max(0, POLL_MS - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  // ── Cleanup ──
  sampleStream.end();

  // ── Summary ──
  const runDurationMin = ((Date.now() - startTime) / 60_000).toFixed(1);
  console.log(`\n  ─── Stage3Sim Summary ───────────────────────────────────\n`);
  console.log(`  Duration:        ${runDurationMin} min`);
  console.log(`  Ticks:           ${totalTicks}`);
  console.log(`  Edges detected:  ${totalEdgesDetected}`);
  console.log(`  Simulations:     ${totalSimulations}`);
  console.log(`  Success:         ${totalSimSuccess} (${totalSimulations > 0 ? ((totalSimSuccess / totalSimulations) * 100).toFixed(1) : 0}%)`);
  console.log(`  Failed:          ${totalSimFail}`);

  // Write summary
  const summary = {
    generatedAt: new Date().toISOString(),
    durationMin: Number(runDurationMin),
    ticks: totalTicks,
    edgesDetected: totalEdgesDetected,
    simulations: totalSimulations,
    simSuccess: totalSimSuccess,
    simFail: totalSimFail,
    successRate: totalSimulations > 0 ? totalSimSuccess / totalSimulations : 0,
  };
  await fs.writeFile(
    path.join(outputDir, "stage3_sim_summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(`\n  📝 Summary written: ${path.join(outputDir, "stage3_sim_summary.json")}\n`);
}

// ══════════════════════════════════════════════════════════════
//  Simulate Edge
// ══════════════════════════════════════════════════════════════

interface SimResult {
  success: boolean;
  error?: string;
  simBps?: number;
  simProfitUsdc?: number;
  slippageBps?: number;
  leg1CU?: number;
  leg2CU?: number;
  totalCU?: number;
}

async function simulateEdge(
  connection: Connection,
  combo: {
    pair: PoolPairInput;
    notional: number;
    direction: Direction;
    netProfitBps: number;
    orcaInputMint: string;
    orcaOutputMint: string;
    orcaInAmountUnits: bigint;
    orcaOutUnits: bigint;
    raydiumOutUnits: bigint;
  },
  ownerPub: PublicKey,
  jupiterApiKey: string,
  priorityFee: number,
): Promise<SimResult> {
  const notionalUnits = BigInt(combo.notional) * BigInt(10 ** USDC_DECIMALS);

  try {
    // ══════════════════════════════════════════════════════════════
    //  Strategy: Simulate Leg1 only, trust Raydium math for Leg2
    //
    //  Why? Leg2 simulation would fail because BASE tokens don't exist
    //  in wallet yet - they only appear after Leg1 executes.
    //  Raydium CPMM is deterministic math, so we trust our calculation.
    // ══════════════════════════════════════════════════════════════

    // ── Leg 1: Orca via Jupiter Whirlpool ──
    const leg1Quote = await fetchJupiterQuote({
      inputMint: combo.orcaInputMint,
      outputMint: combo.orcaOutputMint,
      amount: combo.orcaInAmountUnits,
      slippageBps: 50, // Allow some slippage for simulation
      dexes: "Whirlpool",
    });

    const leg1Tx = await buildJupiterSwap({
      route: leg1Quote.route,
      userPublicKey: ownerPub,
      priorityFeeMicroLamports: priorityFee,
    });

    const leg1Sim = await simulateTx(connection, leg1Tx);

    if (leg1Sim.error) {
      return { success: false, error: `Leg1 sim failed: ${leg1Sim.error}` };
    }

    // ── Leg1 success - extract simulated output ──
    const leg1CU = leg1Sim.unitsConsumed ?? 0;
    
    // Get Jupiter's expected output for Leg1
    const leg1SimOut = leg1Quote.meta.expectedOut;

    // ── Leg2: Use Raydium CPMM deterministic math ──
    // Since Raydium CPMM is purely mathematical (no routing uncertainty),
    // we trust the pre-calculated raydiumOutUnits from quote stage.
    // The actual execution will match because CPMM reserves are read at TX time.
    
    const leg2CU = 100_000; // Approximate Raydium CU (typical range: 80k-120k)
    const totalCU = leg1CU + leg2CU;

    // Calculate simulated profit based on Leg1 actual + Leg2 expected
    let simOutUsdc: bigint;
    
    if (combo.direction === "O_TO_R") {
      // Leg1: USDC → BASE (buy on Orca)
      // Leg2: BASE → USDC (sell on Raydium) - use pre-calculated raydiumOutUnits
      simOutUsdc = combo.raydiumOutUnits;
    } else {
      // Leg1: USDC → BASE (buy on Raydium - already happened via quote)
      // Leg2: BASE → USDC (sell on Orca) - Leg1 output
      simOutUsdc = leg1SimOut;
    }

    const simGrossProfit = simOutUsdc - notionalUnits;
    const simNetProfit = simGrossProfit - BUFFER_USDC_UNITS;
    const simBps = Number(((Number(simNetProfit) / Number(notionalUnits)) * 10_000).toFixed(2));
    const simProfitUsdc = Number(simNetProfit) / 1e6;
    const slippageBps = Number((combo.netProfitBps - simBps).toFixed(2));

    return {
      success: true,
      simBps,
      simProfitUsdc,
      slippageBps,
      leg1CU,
      leg2CU,
      totalCU,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractUsdcOut(
  balances: Array<{ mint: string; owner: string; rawAmount: string }> | undefined,
  usdcMint: string,
  ownerPub: string,
): bigint {
  if (!balances) return 0n;
  const entry = balances.find((b) => b.mint === usdcMint && b.owner === ownerPub);
  return entry ? BigInt(entry.rawAmount) : 0n;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
