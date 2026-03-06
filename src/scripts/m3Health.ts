/**
 * M3 Health — Quote-Only Measurement Health Analyzer
 *
 * Reads arb_watch_invalid_*.jsonl + arb_watch_*.jsonl and produces:
 *   - data/m3_health_report.json   (structured diagnostic report)
 *   - Console summary              (human-readable verdict)
 *
 * HEALTH PASS criteria (per spec — 10-minute run):
 *   1. validRate >= 20%
 *   2. Mint+Decimals mismatch rate == 0%
 *   3. NoPriceMovement warning == false (quotes must change at least occasionally)
 *
 * If HEALTH FAIL:
 *   Print: "MEASUREMENT BROKEN — STOP PROJECT"
 *   Do not proceed to 6h/24h.
 *
 * Usage:
 *   npm run m3:health
 *   npx tsx src/scripts/m3Health.ts
 */

import { promises as fs } from "fs";
import path from "path";

// ══════════════════════════════════════════════════════════════
//  Types (aligned with quote-only arbWatch.ts)
// ══════════════════════════════════════════════════════════════

type InvalidRule =
  | "QUOTE_FAIL"
  | "MINT_OR_DECIMALS_MISMATCH"
  | "SELL_INPUT_MISMATCH"
  | "ABS_BPS_INSANE";

interface InvalidSample {
  ts: number;
  tickId: number;
  pairId: string;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  invalidReason: string;
  invalidRule: InvalidRule;
  netProfitBps?: number;
  netProfitUsdc?: number;
}

interface ValidSample {
  ts: number;
  tickId: number;
  baseMint: string;
  baseSymbol: string;
  notional: number;
  direction: string;
  netProfitBps: number;
  netProfitUsdc: number;
  buyDex: string;
  sellDex: string;
  buyOutUnits: string;
  sellOutUnits: string;
}

// ══════════════════════════════════════════════════════════════
//  Report types
// ══════════════════════════════════════════════════════════════

interface RuleHistogram {
  rule: InvalidRule;
  count: number;
  pct: number;
}

interface PairDigest {
  baseMint: string;
  baseSymbol: string;
  totalSamples: number;
  validSamples: number;
  invalidSamples: number;
  validRate: number;
  dominantRule: InvalidRule | null;
}

interface HealthReport {
  generatedAt: string;
  verdict: "PASS" | "FAIL";
  validRate: number;               // 0–1
  invalidRate: number;             // 0–1
  totalValid: number;
  totalInvalid: number;
  totalSamples: number;
  mintDecimalMismatchRate: number;  // 0–1 — must be 0 to pass
  noPriceMovement: boolean;        // must be false to pass
  ruleHistogram: RuleHistogram[];
  dominantRule: InvalidRule | null;
  pairs: PairDigest[];
  failReasons: string[];           // human-readable list of failure reasons
  details: string;
}

// ══════════════════════════════════════════════════════════════
//  Utility: parse JSONL
// ══════════════════════════════════════════════════════════════

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, idx) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        console.warn(`  ⚠ Skipping malformed JSONL line ${idx + 1}`);
        return null;
      }
    })
    .filter((v): v is T => v !== null);
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  M3 Health — Quote-Only Measurement Self-Diagnosis           ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════╝\n`,
  );

  const dataDir = path.resolve(process.cwd(), "data");

  // ── Load invalid samples (arb_watch_invalid_*.jsonl) ──
  const files = await fs.readdir(dataDir);
  const invalidFiles = files.filter(
    (f) =>
      f.startsWith("arb_watch_invalid") &&
      f.endsWith(".jsonl"),
  );
  // Also check for legacy non-hourly file
  if (files.includes("arb_watch_invalid.jsonl")) {
    invalidFiles.push("arb_watch_invalid.jsonl");
  }

  let invalids: InvalidSample[] = [];
  for (const f of [...new Set(invalidFiles)]) {
    try {
      const raw = await fs.readFile(path.join(dataDir, f), "utf-8");
      invalids = invalids.concat(parseJsonl<InvalidSample>(raw));
    } catch {
      console.warn(`  ⚠ Could not read ${f}`);
    }
  }
  console.log(
    `  Loaded ${invalids.length} invalid samples from ${invalidFiles.length} file(s)`,
  );

  // ── Load valid samples (arb_watch_*.jsonl, excluding invalid/events) ──
  const watchFiles = files.filter(
    (f) =>
      f.startsWith("arb_watch_") &&
      f.endsWith(".jsonl") &&
      !f.includes("invalid") &&
      !f.includes("event") &&
      !f.includes("summary"),
  );
  if (files.includes("arb_watch.jsonl")) watchFiles.push("arb_watch.jsonl");

  let valids: ValidSample[] = [];
  for (const f of [...new Set(watchFiles)]) {
    try {
      const raw = await fs.readFile(path.join(dataDir, f), "utf-8");
      valids = valids.concat(parseJsonl<ValidSample>(raw));
    } catch {
      console.warn(`  ⚠ Could not read ${f}`);
    }
  }
  console.log(
    `  Loaded ${valids.length} valid samples from ${watchFiles.length} watch file(s)`,
  );

  if (valids.length === 0 && invalids.length === 0) {
    console.error(
      `\n  ✗ No data found. Run 'npm run m3:watch' first.\n`,
    );
    process.exit(1);
  }

  // ── Aggregate stats ──
  const totalInvalid = invalids.length;
  const totalValid = valids.length;
  const totalSamples = totalInvalid + totalValid;
  const validRate = totalSamples > 0 ? totalValid / totalSamples : 0;
  const invalidRate = totalSamples > 0 ? totalInvalid / totalSamples : 0;

  // ── Rule histogram ──
  const ruleCounts = new Map<InvalidRule, number>();
  for (const inv of invalids) {
    if (inv.invalidRule) {
      ruleCounts.set(
        inv.invalidRule,
        (ruleCounts.get(inv.invalidRule) ?? 0) + 1,
      );
    }
  }
  const ruleHistogram: RuleHistogram[] = Array.from(ruleCounts.entries())
    .map(([rule, count]) => ({
      rule,
      count,
      pct: totalInvalid > 0 ? count / totalInvalid : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const dominantRule =
    ruleHistogram.length > 0 ? ruleHistogram[0].rule : null;

  // ── Mint+Decimals mismatch rate (must be 0%) ──
  const mintDecimalCount =
    ruleCounts.get("MINT_OR_DECIMALS_MISMATCH") ?? 0;
  const mintDecimalMismatchRate =
    totalSamples > 0 ? mintDecimalCount / totalSamples : 0;

  // ── NoPriceMovement detection ──
  // Check if buyOutUnits vary across ticks for valid samples
  const buyOutByCombo = new Map<string, Set<string>>();
  for (const v of valids) {
    const combo = `${v.baseMint}:${v.notional}:${v.direction}`;
    if (!buyOutByCombo.has(combo)) buyOutByCombo.set(combo, new Set());
    buyOutByCombo.get(combo)!.add(v.buyOutUnits);
  }
  // NoPriceMovement is true if no combo ever saw a different quote
  const combosWithChange = Array.from(buyOutByCombo.values()).filter(
    (s) => s.size > 1,
  ).length;
  const noPriceMovement =
    valids.length > 0 && combosWithChange === 0;

  // ── PASS / FAIL (per spec) ──
  const failReasons: string[] = [];
  if (validRate < 0.2) {
    failReasons.push(
      `validRate=${(validRate * 100).toFixed(1)}% < 20%`,
    );
  }
  if (mintDecimalMismatchRate > 0) {
    failReasons.push(
      `mintDecimalMismatchRate=${(mintDecimalMismatchRate * 100).toFixed(2)}% != 0%`,
    );
  }
  if (noPriceMovement) {
    failReasons.push(
      `NoPriceMovement=true (quotes never changed — measurement likely broken)`,
    );
  }

  const verdict: "PASS" | "FAIL" =
    failReasons.length === 0 ? "PASS" : "FAIL";

  // ── Per-pair digest ──
  const pairMap = new Map<
    string,
    {
      symbol: string;
      valid: number;
      invalid: number;
      rules: InvalidRule[];
    }
  >();

  for (const inv of invalids) {
    const key = inv.baseMint ?? inv.pairId;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        symbol: inv.baseSymbol,
        valid: 0,
        invalid: 0,
        rules: [],
      });
    }
    const entry = pairMap.get(key)!;
    entry.invalid++;
    if (inv.invalidRule) entry.rules.push(inv.invalidRule);
  }

  for (const v of valids) {
    const key = v.baseMint;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        symbol: v.baseSymbol,
        valid: 0,
        invalid: 0,
        rules: [],
      });
    }
    pairMap.get(key)!.valid++;
  }

  const pairDigests: PairDigest[] = Array.from(pairMap.entries())
    .map(([baseMint, data]) => {
      const total = data.valid + data.invalid;
      const ruleCnts = new Map<InvalidRule, number>();
      for (const r of data.rules)
        ruleCnts.set(r, (ruleCnts.get(r) ?? 0) + 1);
      let domRule: InvalidRule | null = null;
      let domCount = 0;
      for (const [r, c] of ruleCnts) {
        if (c > domCount) {
          domRule = r;
          domCount = c;
        }
      }
      return {
        baseMint,
        baseSymbol: data.symbol,
        totalSamples: total,
        validSamples: data.valid,
        invalidSamples: data.invalid,
        validRate: total > 0 ? data.valid / total : 0,
        dominantRule: domRule,
      };
    })
    .sort((a, b) => b.validRate - a.validRate);

  // ── Build details string ──
  const detailLines: string[] = [];
  if (verdict === "FAIL") {
    detailLines.push("MEASUREMENT BROKEN — STOP PROJECT");
    for (const reason of failReasons) detailLines.push(reason);
  } else {
    detailLines.push("All health checks passed.");
  }

  const report: HealthReport = {
    generatedAt: new Date().toISOString(),
    verdict,
    validRate,
    invalidRate,
    totalValid,
    totalInvalid,
    totalSamples,
    mintDecimalMismatchRate,
    noPriceMovement,
    ruleHistogram,
    dominantRule,
    pairs: pairDigests,
    failReasons,
    details: detailLines.join(" | "),
  };

  // ── Write report ──
  const reportPath = path.join(dataDir, "m3_health_report.json");
  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  // ── Console summary ──
  console.log(
    `\n─── M3 Health Report ───────────────────────────────────────\n`,
  );
  console.log(
    `  HEALTH: ${verdict === "PASS" ? "✅ PASS" : "❌ FAIL"}`,
  );
  console.log(
    `  Valid rate:              ${(validRate * 100).toFixed(2)}%  (${totalValid} / ${totalSamples})`,
  );
  console.log(
    `  Invalid rate:            ${(invalidRate * 100).toFixed(2)}%  (${totalInvalid} / ${totalSamples})`,
  );
  console.log(
    `  Mint+Decimals mismatch:  ${(mintDecimalMismatchRate * 100).toFixed(2)}%  (must be 0%)`,
  );
  console.log(
    `  NoPriceMovement:         ${noPriceMovement ? "⚠ YES" : "no"}  (must be false)`,
  );
  console.log(
    `  Combos with quote change: ${combosWithChange} / ${buyOutByCombo.size}`,
  );
  console.log();

  // Rule histogram
  if (ruleHistogram.length > 0) {
    console.log(`  InvalidRule breakdown:`);
    for (const h of ruleHistogram) {
      const bar = "█".repeat(
        Math.min(40, Math.round(h.pct * 40)),
      );
      console.log(
        `    ${h.rule.padEnd(30)} ${h.count.toString().padStart(6)}  (${(h.pct * 100).toFixed(1)}%)  ${bar}`,
      );
    }
    console.log();
  }

  // Per-pair overview
  console.log(`  Per-pair digest (sorted by validRate desc):`);
  console.log(
    `    ${"Symbol".padEnd(12)} ${"Valid%".padStart(7)} ${"Valid".padStart(6)} ${"Inval".padStart(6)} ${"DomRule".padEnd(28)}`,
  );
  console.log(`    ${"─".repeat(65)}`);
  for (const p of pairDigests.slice(0, 20)) {
    console.log(
      `    ${p.baseSymbol.padEnd(12)} ${(p.validRate * 100).toFixed(1).padStart(6)}% ${p.validSamples.toString().padStart(6)} ${p.invalidSamples.toString().padStart(6)} ${(p.dominantRule ?? "-").padEnd(28)}`,
    );
  }
  console.log();

  // Verdict details
  if (verdict === "FAIL") {
    console.log(`  ❌ MEASUREMENT BROKEN — STOP PROJECT`);
    console.log(`  Fail reasons:`);
    for (const reason of failReasons) {
      console.log(`    • ${reason}`);
    }
    console.log();
    console.log(`  Do NOT proceed to 6h/24h watch.\n`);
  } else {
    console.log(`  ✅ All health checks passed.`);
    console.log(`  Proceed to 6h/24h watch.\n`);
  }

  console.log(`  Report saved: ${reportPath}\n`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
