/**
 * Session Mode v1.1 — Daily Session Config Generator
 *
 * Creates config for session-based measurement:
 *   - Preflight: 10:30–11:00 UTC (13:30–14:00 TRT)
 *   - Session:   11:00–17:00 UTC (14:00–20:00 TRT)
 *
 * Output:
 *   archive/<YYYYMMDD>_session_v1_1/
 *   └── session_config.json
 *
 * Usage:
 *   npx tsx src/scripts/sessionInit.ts
 *   npx tsx src/scripts/sessionInit.ts --date 2026-02-27
 *   npm run session:init
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════

interface SessionConfig {
  version: "1.1";
  dateUTC: string;           // YYYY-MM-DD
  dateTRT: string;           // YYYY-MM-DD (same or +1 day)
  runId: string;             // YYYYMMDD_session_v1_1
  
  preflight: {
    startUTC: string;        // 10:30
    endUTC: string;          // 11:00
    startTRT: string;        // 13:30
    endTRT: string;          // 14:00
    durationMin: number;     // 30
  };
  
  session: {
    startUTC: string;        // 11:00
    endUTC: string;          // 17:00
    startTRT: string;        // 14:00
    endTRT: string;          // 20:00
    durationMin: number;     // 360
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

interface Top3Freeze {
  surface: string[];
  thresholds: {
    T1_bps: number;
    T2_bps: number;
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

// Allow override for testing: --date 2026-02-27
const DATE_OVERRIDE = getArgStr("--date", "");

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Session Mode v1.1 — Daily Config Generator                  ║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Determine date ──
  const now = new Date();
  let targetDate: Date;
  
  if (DATE_OVERRIDE) {
    targetDate = new Date(DATE_OVERRIDE + "T00:00:00Z");
    console.log(`  ⚡ Date override: ${DATE_OVERRIDE}`);
  } else {
    targetDate = now;
  }
  
  const dateUTC = targetDate.toISOString().slice(0, 10);
  const dateCompact = dateUTC.replace(/-/g, "");
  
  // TRT is UTC+3
  const trtDate = new Date(targetDate.getTime() + 3 * 60 * 60 * 1000);
  const dateTRT = trtDate.toISOString().slice(0, 10);

  // ── Load top3_freeze.json ──
  const archiveDir = path.resolve(process.cwd(), "archive/2026-02-26_24h_pass");
  const freezePath = path.join(archiveDir, "top3_freeze.json");

  let freeze: Top3Freeze;
  try {
    const raw = await fs.readFile(freezePath, "utf-8");
    freeze = JSON.parse(raw) as Top3Freeze;
    console.log(`  ✓ Loaded top3_freeze.json`);
    console.log(`    Surface: [${freeze.surface.join(", ")}]`);
  } catch {
    console.error(`  ✗ Failed to load ${freezePath}`);
    console.error(`    Stage 1 must be completed first.`);
    process.exit(1);
  }

  // ── Create output directory ──
  const runId = `${dateCompact}_session_v1_2`;
  const outputDir = `archive/${runId}`;
  const fullOutputDir = path.resolve(process.cwd(), outputDir);
  await fs.mkdir(fullOutputDir, { recursive: true });
  console.log(`  ✓ Created output directory: ${outputDir}`);

  // ── Build config ──
  const config: SessionConfig = {
    version: "1.2",
    dateUTC,
    dateTRT,
    runId,
    
    preflight: {
      startUTC: "11:30",
      endUTC: "12:00",
      startTRT: "14:30",
      endTRT: "15:00",
      durationMin: 30,
    },
    
    session: {
      startUTC: "12:00",
      endUTC: "16:00",
      startTRT: "15:00",
      endTRT: "19:00",
      durationMin: 240,
    },
    
    surfaceSymbols: freeze.surface,
    excludeSymbols: ["USDT", "USDC"],
    thresholds: {
      T1_bps: freeze.thresholds.T1_bps,
      T2_bps: freeze.thresholds.T2_bps,
    },
    
    mode: "quote_only",
    outputDir,
  };

  // ── Write config ──
  const configPath = path.join(fullOutputDir, "session_config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  // ── Calculate start times ──
  const preflightStartUTC = new Date(`${dateUTC}T11:30:00Z`);
  const sessionStartUTC = new Date(`${dateUTC}T12:00:00Z`);
  const sessionEndUTC = new Date(`${dateUTC}T16:00:00Z`);
  
  const nowUTC = now.getTime();
  const preflightStartMs = preflightStartUTC.getTime();
  const sessionStartMs = sessionStartUTC.getTime();
  const sessionEndMs = sessionEndUTC.getTime();
  
  let status: string;
  let msUntilStart: number;
  
  if (nowUTC < preflightStartMs) {
    status = "PENDING";
    msUntilStart = preflightStartMs - nowUTC;
  } else if (nowUTC < sessionStartMs) {
    status = "PREFLIGHT_ACTIVE";
    msUntilStart = 0;
  } else if (nowUTC < sessionEndMs) {
    status = "SESSION_ACTIVE";
    msUntilStart = 0;
  } else {
    status = "SESSION_ENDED";
    msUntilStart = 0;
  }

  console.log(`
  ── Session Config ────────────────────────────────────────────

  Version:         ${config.version}
  Run ID:          ${config.runId}
  Date (UTC):      ${config.dateUTC}
  Date (TRT):      ${config.dateTRT}
  
  Preflight:       ${config.preflight.startUTC}–${config.preflight.endUTC} UTC
                   ${config.preflight.startTRT}–${config.preflight.endTRT} TRT
                   ${config.preflight.durationMin} min
  
  Session:         ${config.session.startUTC}–${config.session.endUTC} UTC
                   ${config.session.startTRT}–${config.session.endTRT} TRT
                   ${config.session.durationMin} min (4h)
  
  Surface:         [${config.surfaceSymbols.join(", ")}]
  Excluded:        [${config.excludeSymbols.join(", ")}]
  Thresholds:      T1=${config.thresholds.T1_bps}bps, T2=${config.thresholds.T2_bps}bps
  
  Output:          ${config.outputDir}
  
  Status:          ${status}
  ${msUntilStart > 0 ? `Wait:            ${Math.round(msUntilStart / 60000)} min until preflight` : ""}

  Config written:  ${configPath}

  ── Next Steps ────────────────────────────────────────────────
`);

  if (status === "PENDING") {
    console.log(`
  Wait until ${config.preflight.startTRT} TRT, then:

    npm run session:watch -- --config ${outputDir}/session_config.json
`);
  } else if (status === "PREFLIGHT_ACTIVE" || status === "SESSION_ACTIVE") {
    console.log(`
  Session is active! Start now:

    npm run session:watch -- --config ${outputDir}/session_config.json
`);
  } else {
    console.log(`
  Session ended for today. Run again tomorrow or with --date:

    npm run session:init -- --date 2026-02-28
`);
  }

  console.log(`  ✓ Session init complete.\n`);
}

main().catch((err) => {
  console.error("Session init failed:", err);
  process.exit(1);
});
