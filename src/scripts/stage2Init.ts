/**
 * Stage 2 — Config Generator
 *
 * Generates the stage2_config.json file for a focused 12h micro-run.
 * Reads top3_freeze.json from archive to get frozen surface pairs.
 *
 * Usage:
 *   npx tsx src/scripts/stage2Init.ts
 *   npm run stage2:init
 *
 * Output:
 *   data/m3_stage2_12h/<timestamp>/
 *   └── stage2_config.json
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface Top3Freeze {
  freezeTs: number;
  freezeIso: string;
  sourceArchive: string;
  surface: string[];
  surfaceMints: string[];
  thresholds: {
    T1_bps: number;
    T2_bps: number;
    K: number;
    minSamples: number;
  };
  top3Metrics: Record<string, {
    T1_events: number;
    T2_events: number;
    p95PeakBps: number;
    medianDurationMs: number;
    totalDurationMs: number;
    bestDirection: string;
    validRate: number;
  }>;
  note: string;
}

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

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Stage 2 — Config Generator                                  ║
╚══════════════════════════════════════════════════════════════╝
`);

  const archiveDir = path.resolve(process.cwd(), "archive/2026-02-26_24h_pass");
  const freezePath = path.join(archiveDir, "top3_freeze.json");

  // ── Load top3_freeze.json ──
  let freeze: Top3Freeze;
  try {
    const raw = await fs.readFile(freezePath, "utf-8");
    freeze = JSON.parse(raw) as Top3Freeze;
    console.log(`  ✓ Loaded top3_freeze.json from archive`);
    console.log(`    Surface: [${freeze.surface.join(", ")}]`);
  } catch {
    console.error(`  ✗ Failed to load ${freezePath}`);
    console.error(`    Stage 1 must be completed first.`);
    process.exit(1);
  }

  // ── Generate timestamp ──
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = `${timestamp}_stage2_12h`;

  // ── Create output directory ──
  const outputDir = `data/m3_stage2_12h/${timestamp}`;
  const fullOutputDir = path.resolve(process.cwd(), outputDir);
  await fs.mkdir(fullOutputDir, { recursive: true });
  console.log(`  ✓ Created output directory: ${outputDir}`);

  // ── Build config ──
  const config: Stage2Config = {
    runId,
    durationHours: 12,
    surfaceSymbols: freeze.surface,
    thresholds: {
      T1_bps: freeze.thresholds.T1_bps,
      T2_bps: freeze.thresholds.T2_bps,
    },
    excludeSymbols: ["USDT", "USDC"], // Always exclude stables
    mode: "quote_only",
    outputDir,
  };

  // ── Write config ──
  const configPath = path.join(fullOutputDir, "stage2_config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  console.log(`
  ── Stage 2 Config ────────────────────────────────────────────

  runId:           ${config.runId}
  durationHours:   ${config.durationHours}
  surfaceSymbols:  [${config.surfaceSymbols.join(", ")}]
  excludeSymbols:  [${config.excludeSymbols.join(", ")}]
  mode:            ${config.mode}
  outputDir:       ${config.outputDir}

  Config written:  ${configPath}

  ── Next Steps ────────────────────────────────────────────────

  1. Start Stage 2 watch (12h):

     npm run m3:watch -- --config ${outputDir}/stage2_config.json

     or with nohup for background:

     nohup npx tsx src/scripts/arbWatch.ts \\
       --config ${outputDir}/stage2_config.json \\
       > ${outputDir}/watch.log 2>&1 &

  2. After 12h, analyze:

     npm run stage2:analyze -- --input ${outputDir}

  3. Check verdict:

     cat ${outputDir}/stage2_summary.json | jq .verdict

`);

  console.log(`  ✓ Stage 2 init complete.\n`);
}

main().catch((err) => {
  console.error("Stage2 init failed:", err);
  process.exit(1);
});
