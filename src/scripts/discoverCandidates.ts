/**
 * Discovery Script v1 — Birdeye-based mid-liquidity candidate finder
 *
 * Scans Birdeye token list API for Solana tokens that fit the Type C
 * mid-liquidity profile. Filters:
 *   - Liquidity:   $100k – $800k (default, Type A reducer)
 *   - Volume 24h:  $50k – $5M
 *   - Vol/Liq:     ≥ 0.05
 *   - Blacklist:   skip known large-cap tokens (SOL, JUP, USDC, USDT, etc.)
 *
 * Optionally runs a quick Jupiter impact probe (impact_3k) to pre-filter
 * candidates that are NOT Type A (hyper competitive).
 *
 * Output:
 *   - data/candidatePairs.json  (overwritten with discovered candidates)
 *   - Console summary
 *
 * Usage:
 *   BIRDEYE_API_KEY=xxx npx tsx src/scripts/discoverCandidates.ts
 *   BIRDEYE_API_KEY=xxx npx tsx src/scripts/discoverCandidates.ts --probe
 *
 * Options:
 *   --probe         Run Jupiter impact_3k probe (slower but higher quality)
 *   --min-liq N     Override min liquidity (default: 100000)
 *   --max-liq N     Override max liquidity (default: 800000)
 *   --min-vol N     Override min 24h volume (default: 50000)
 *   --max-vol N     Override max 24h volume (default: 5000000)
 *   --limit N       Max candidates to output (default: 150)
 *   --dry           Don't write candidatePairs.json, just print
 */

import { promises as fs } from "fs";
import path from "path";

// ── Configuration ──

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

// Blacklist: known large-cap tokens that are definitely Type A
const BLACKLISTED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",    // SOL (WSOL)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  // JTO
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
  "DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ", // DUST
  "RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a",  // RLBB
  "kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6",  // KIN
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",  // RENDER
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",  // HNT
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",   // WEN
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // POPCAT
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", // W
]);

// Blacklist symbol patterns (regex)
const BLACKLISTED_SYMBOL_PATTERNS = [
  /^USDC$/i, /^USDT$/i, /^SOL$/i, /^WSOL$/i, /^ETH$/i, /^BTC$/i,
  /^W?BTC$/i, /^WETH$/i, /^stSOL$/i, /^mSOL$/i, /^bSOL$/i,
  /^jitoSOL$/i, /^RAY$/i, /^SRM$/i,
];

// ── CLI Args ──

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: number): number {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return Number(args[idx + 1]) || defaultVal;
  return defaultVal;
}
const doProbe = args.includes("--probe");
const dryRun = args.includes("--dry");
const MIN_LIQUIDITY = getArg("--min-liq", 100_000);
const MAX_LIQUIDITY = getArg("--max-liq", 800_000);
const MIN_VOLUME_24H = getArg("--min-vol", 50_000);
const MAX_VOLUME_24H = getArg("--max-vol", 5_000_000);
const MIN_VOL_LIQ_RATIO = 0.05;
const MAX_CANDIDATES = getArg("--limit", 150);

// ── Birdeye API ──

interface BirdeyeToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidity: number;
  v24hUSD: number;
  v24hChangePercent?: number;
  logoURI?: string;
  lastTradeUnixTime?: number;
}

/**
 * Fetch top Solana tokens from Birdeye sorted by volume.
 * Uses the token list endpoint with pagination.
 */
async function fetchBirdeyeTokenList(
  offset: number,
  limit: number,
  sortBy: string = "v24hUSD",
  sortType: string = "desc",
): Promise<BirdeyeToken[]> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) throw new Error("BIRDEYE_API_KEY env var is required");

  const url = `${BIRDEYE_BASE_URL}/defi/tokenlist?sort_by=${sortBy}&sort_type=${sortType}&offset=${offset}&limit=${limit}&min_liquidity=${MIN_LIQUIDITY}`;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      const wait = (attempt + 1) * 3_000; // 3s, 6s, 9s
      console.warn(`  [Birdeye] 429 rate limited — retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s…`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Birdeye API error: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as { success: boolean; data?: { tokens?: BirdeyeToken[] } };
    if (!json.success || !json.data?.tokens) {
      return [];
    }
    return json.data.tokens;
  }

  throw new Error(`Birdeye API: 429 rate limited after ${maxRetries} retries`);
}

/**
 * Fetch detailed token overview from Birdeye (for decimals + better data).
 */
async function fetchTokenOverview(mint: string): Promise<{
  decimals: number;
  symbol: string;
  liquidity: number;
  v24hUSD: number;
} | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `${BIRDEYE_BASE_URL}/defi/token_overview?address=${mint}`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { success: boolean; data?: any };
    if (!json.success || !json.data) return null;
    return {
      decimals: json.data.decimals ?? 9,
      symbol: json.data.symbol ?? "???",
      liquidity: json.data.liquidity ?? 0,
      v24hUSD: json.data.v24hUSD ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Jupiter Impact Probe (optional) ──

interface ImpactProbeResult {
  impact3kPct: number;
  routeMarkets: number;
}

async function probeJupiterImpact(baseMint: string): Promise<ImpactProbeResult | null> {
  try {
    const amount = BigInt(Math.round(3_000 * 10 ** USDC_DECIMALS)); // 3k USDC
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${baseMint}&amount=${amount}&slippageBps=10`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      priceImpactPct?: string;
      routePlan?: { swapInfo: any }[];
    };

    return {
      impact3kPct: Math.abs(parseFloat(data.priceImpactPct ?? "0")),
      routeMarkets: data.routePlan?.length ?? 1,
    };
  } catch {
    return null;
  }
}

// ── Filtering ──

function isBlacklisted(token: BirdeyeToken): boolean {
  if (BLACKLISTED_MINTS.has(token.address)) return true;
  for (const re of BLACKLISTED_SYMBOL_PATTERNS) {
    if (re.test(token.symbol)) return true;
  }
  return false;
}

interface FilteredCandidate {
  mint: string;
  symbol: string;
  decimals: number;
  liquidity: number;
  volume24h: number;
  volLiqRatio: number;
  impact3kPct?: number;
  routeMarkets?: number;
}

// ── Main ──

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Discovery Script v1 — Mid-Liquidity Candidate Finder       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  Filters:`);
  console.log(`    Liquidity:   $${MIN_LIQUIDITY.toLocaleString()} – $${MAX_LIQUIDITY.toLocaleString()}`);
  console.log(`    Volume 24h:  $${MIN_VOLUME_24H.toLocaleString()} – $${MAX_VOLUME_24H.toLocaleString()}`);
  console.log(`    Vol/Liq:     ≥ ${MIN_VOL_LIQ_RATIO}`);
  console.log(`    Impact probe: ${doProbe ? "ENABLED" : "DISABLED (use --probe to enable)"}`);
  console.log(`    Max output:  ${MAX_CANDIDATES}`);
  console.log(`    Dry run:     ${dryRun}`);
  console.log();

  // Fetch multiple pages from Birdeye
  const allTokens: BirdeyeToken[] = [];
  const pageSize = 50;
  const maxPages = 10; // Up to 500 tokens

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    console.log(`  [Birdeye] Fetching page ${page + 1}/${maxPages} (offset=${offset})…`);

    try {
      const tokens = await fetchBirdeyeTokenList(offset, pageSize);
      if (tokens.length === 0) {
        console.log(`  [Birdeye] No more tokens at offset=${offset}. Done.`);
        break;
      }
      allTokens.push(...tokens);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  [Birdeye] Page ${page + 1} error: ${reason}`);
      if (reason.includes("429") || reason.includes("rate limit")) {
        console.log(`  [Birdeye] Rate limited — waiting 5s before next page…`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue; // try next page instead of stopping
      }
      break;
    }

    // Rate-limit: 1.5s between pages (Birdeye free tier is strict)
    await new Promise((r) => setTimeout(r, 1_500));
  }

  console.log(`\n  Total tokens fetched: ${allTokens.length}`);

  // ── Apply filters ──
  const candidates: FilteredCandidate[] = [];
  let blacklisted = 0;
  let liqFiltered = 0;
  let volFiltered = 0;
  let volLiqFiltered = 0;
  let probeFiltered = 0;
  let probeErrors = 0;

  for (const token of allTokens) {
    // Deduplicate
    if (candidates.some((c) => c.mint === token.address)) continue;

    // Blacklist check
    if (isBlacklisted(token)) {
      blacklisted++;
      continue;
    }

    // Liquidity filter
    const liq = token.liquidity ?? 0;
    if (liq < MIN_LIQUIDITY || liq > MAX_LIQUIDITY) {
      liqFiltered++;
      continue;
    }

    // Volume filter
    const vol = token.v24hUSD ?? 0;
    if (vol < MIN_VOLUME_24H || vol > MAX_VOLUME_24H) {
      volFiltered++;
      continue;
    }

    // Vol/Liq ratio
    const vlr = liq > 0 ? vol / liq : 0;
    if (vlr < MIN_VOL_LIQ_RATIO) {
      volLiqFiltered++;
      continue;
    }

    // Ensure decimals (fallback to standard)
    const decimals = token.decimals > 0 ? token.decimals : 9;

    const candidate: FilteredCandidate = {
      mint: token.address,
      symbol: token.symbol || "???",
      decimals,
      liquidity: liq,
      volume24h: vol,
      volLiqRatio: vlr,
    };

    // Optional: Jupiter impact probe
    if (doProbe) {
      const probe = await probeJupiterImpact(token.address);
      if (probe) {
        candidate.impact3kPct = probe.impact3kPct;
        candidate.routeMarkets = probe.routeMarkets;

        // Skip Type A (impact_3k < 0.2%) — too competitive
        if (probe.impact3kPct < 0.2) {
          probeFiltered++;
          continue;
        }
        // Skip if routeMarkets > 5 (too fragmented for now)
        if (probe.routeMarkets > 5) {
          probeFiltered++;
          continue;
        }
      } else {
        probeErrors++;
        // Keep candidate even if probe fails — will be classified at scan time
      }

      // Rate-limit between probes
      await new Promise((r) => setTimeout(r, 300));
    }

    candidates.push(candidate);

    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // Sort by vol/liq ratio descending (higher activity relative to liquidity = more opportunity)
  candidates.sort((a, b) => b.volLiqRatio - a.volLiqRatio);
  const finalCandidates = candidates.slice(0, MAX_CANDIDATES);

  // ── Summary ──
  console.log(`\n─── Filter Summary ──────────────────────────────────────────\n`);
  console.log(`  Input tokens:     ${allTokens.length}`);
  console.log(`  Blacklisted:      ${blacklisted}`);
  console.log(`  Liq filtered:     ${liqFiltered} (outside $${MIN_LIQUIDITY.toLocaleString()}–$${MAX_LIQUIDITY.toLocaleString()})`);
  console.log(`  Vol filtered:     ${volFiltered} (outside $${MIN_VOLUME_24H.toLocaleString()}–$${MAX_VOLUME_24H.toLocaleString()})`);
  console.log(`  Vol/Liq filtered: ${volLiqFiltered} (< ${MIN_VOL_LIQ_RATIO})`);
  if (doProbe) {
    console.log(`  Probe filtered:   ${probeFiltered} (Type A or fragmented)`);
    console.log(`  Probe errors:     ${probeErrors} (kept as candidates)`);
  }
  console.log(`  ─────────────────`);
  console.log(`  Final candidates: ${finalCandidates.length}`);

  if (finalCandidates.length === 0) {
    console.log(`\n  ⚠ No candidates found. Try relaxing filters (--min-liq, --max-liq, etc.)`);
    return;
  }

  // ── Print top candidates ──
  console.log(`\n─── Top ${Math.min(finalCandidates.length, 30)} Candidates ───────────────────────────────\n`);
  console.log(`  ${"#".padStart(3)}  ${"Symbol".padEnd(12)} ${"Liq ($)".padStart(12)} ${"Vol ($)".padStart(12)} ${"V/L".padStart(8)} ${doProbe ? "Impact3k Rts" : ""}`);
  console.log(`  ${"─".repeat(3)}  ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(8)} ${doProbe ? "──────── ───" : ""}`);

  for (let i = 0; i < Math.min(finalCandidates.length, 30); i++) {
    const c = finalCandidates[i];
    let line = `  ${String(i + 1).padStart(3)}  ${c.symbol.padEnd(12)} ${("$" + c.liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(12)} ${("$" + c.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(12)} ${c.volLiqRatio.toFixed(3).padStart(8)}`;
    if (doProbe && c.impact3kPct !== undefined) {
      line += ` ${c.impact3kPct.toFixed(4).padStart(8)}% ${String(c.routeMarkets ?? "?").padStart(3)}`;
    }
    console.log(line);
  }

  // ── Write candidatePairs.json ──
  if (dryRun) {
    console.log(`\n  [DRY RUN] Not writing candidatePairs.json. Use without --dry to save.`);
  } else {
    const output = {
      _comment: `Auto-generated by discoverCandidates.ts at ${new Date().toISOString()}. ${finalCandidates.length} mid-liquidity candidates for EXPERIMENT_D_READY.`,
      quoteMint: USDC_MINT,
      quoteSymbol: "USDC",
      quoteDecimals: USDC_DECIMALS,
      candidates: finalCandidates.map((c) => ({
        mint: c.mint,
        symbol: c.symbol,
        decimals: c.decimals,
      })),
    };

    const outPath = path.resolve(process.cwd(), "data", "candidatePairs.json");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
    console.log(`\n  ✓ Written ${finalCandidates.length} candidates to ${outPath}`);

    // Also write a detailed report
    const reportPath = path.resolve(process.cwd(), "data", "telemetry", "discovery_report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      filters: { MIN_LIQUIDITY, MAX_LIQUIDITY, MIN_VOLUME_24H, MAX_VOLUME_24H, MIN_VOL_LIQ_RATIO, doProbe },
      summary: {
        inputTokens: allTokens.length,
        blacklisted,
        liqFiltered,
        volFiltered,
        volLiqFiltered,
        probeFiltered: doProbe ? probeFiltered : null,
        probeErrors: doProbe ? probeErrors : null,
        finalCandidates: finalCandidates.length,
      },
      candidates: finalCandidates,
    }, null, 2) + "\n", "utf-8");
    console.log(`  ✓ Discovery report saved to ${reportPath}`);
  }

  console.log();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
