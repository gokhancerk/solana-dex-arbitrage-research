import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface LatencyProbe {
  method: string;
  url: string;
  durationMs: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

export interface LatencyReport {
  rpcLabel: string;
  url: string;
  probes: LatencyProbe[];
  summary: {
    avgMs: number;
    minMs: number;
    maxMs: number;
    medianMs: number;
    p95Ms: number;
    successRate: number;
    totalProbes: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarise(probes: LatencyProbe[]) {
  const durations = probes.filter((p) => p.success).map((p) => p.durationMs).sort((a, b) => a - b);
  const total = probes.length;
  const successes = durations.length;
  return {
    avgMs: successes ? Math.round(durations.reduce((a, b) => a + b, 0) / successes) : 0,
    minMs: durations[0] ?? 0,
    maxMs: durations[durations.length - 1] ?? 0,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    successRate: total ? Math.round((successes / total) * 10000) / 100 : 0,
    totalProbes: total,
  };
}

async function timedCall(method: string, url: string, fn: () => Promise<void>): Promise<LatencyProbe> {
  const t0 = performance.now();
  try {
    await fn();
    return {
      method,
      url,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      success: true,
      timestamp: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      method,
      url,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    };
  }
}

// ── Probe functions ────────────────────────────────────────────────────

async function probeGetLatestBlockhash(conn: Connection, url: string): Promise<LatencyProbe> {
  return timedCall("getLatestBlockhash", url, async () => {
    await conn.getLatestBlockhash("confirmed");
  });
}

async function probeGetSlot(conn: Connection, url: string): Promise<LatencyProbe> {
  return timedCall("getSlot", url, async () => {
    await conn.getSlot("confirmed");
  });
}

async function probeGetBlockHeight(conn: Connection, url: string): Promise<LatencyProbe> {
  return timedCall("getBlockHeight", url, async () => {
    await conn.getBlockHeight("confirmed");
  });
}

async function probeGetBalance(conn: Connection, url: string, pubkey: PublicKey): Promise<LatencyProbe> {
  return timedCall("getBalance", url, async () => {
    await conn.getBalance(pubkey, "confirmed");
  });
}

async function probeGetEpochInfo(conn: Connection, url: string): Promise<LatencyProbe> {
  return timedCall("getEpochInfo", url, async () => {
    await conn.getEpochInfo("confirmed");
  });
}

async function probeGetHealth(conn: Connection, url: string): Promise<LatencyProbe> {
  return timedCall("getHealth", url, async () => {
    // @ts-expect-error getHealth exists but not in type defs
    if (typeof conn.getHealth === "function") {
      await conn.getHealth();
    } else {
      // Manual JSON-RPC call
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────

export interface MeasureOptions {
  /** Number of rounds per method (default: 5) */
  rounds?: number;
  /** Optional pubkey for getBalance probe */
  walletPubkey?: PublicKey;
  /** Delay between rounds in ms (default: 200) */
  delayMs?: number;
}

/**
 * Measures RPC latency across multiple JSON-RPC methods.
 * Returns a full report with per-probe results and aggregate stats.
 */
export async function measureRpcLatency(
  rpcUrl: string,
  label: string,
  opts: MeasureOptions = {}
): Promise<LatencyReport> {
  const rounds = opts.rounds ?? 5;
  const delayMs = opts.delayMs ?? 200;
  const conn = new Connection(rpcUrl, "confirmed");

  const probes: LatencyProbe[] = [];

  for (let i = 0; i < rounds; i++) {
    probes.push(await probeGetLatestBlockhash(conn, rpcUrl));
    probes.push(await probeGetSlot(conn, rpcUrl));
    probes.push(await probeGetBlockHeight(conn, rpcUrl));
    probes.push(await probeGetEpochInfo(conn, rpcUrl));
    probes.push(await probeGetHealth(conn, rpcUrl));

    if (opts.walletPubkey) {
      probes.push(await probeGetBalance(conn, rpcUrl, opts.walletPubkey));
    }

    if (i < rounds - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    rpcLabel: label,
    url: rpcUrl,
    probes,
    summary: summarise(probes),
  };
}

/**
 * Measures latency for all configured RPC endpoints (primary + backup).
 */
export async function measureAllEndpoints(opts: MeasureOptions = {}): Promise<LatencyReport[]> {
  const cfg = loadConfig();
  const reports: LatencyReport[] = [];

  reports.push(await measureRpcLatency(cfg.rpc.primary, "primary", opts));

  if (cfg.rpc.backup && cfg.rpc.backup !== cfg.rpc.primary) {
    reports.push(await measureRpcLatency(cfg.rpc.backup, "backup", opts));
  }

  return reports;
}

// ── Pretty printer ────────────────────────────────────────────────────

export function printLatencyReport(report: LatencyReport): void {
  const { summary } = report;
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  RPC Latency Report: ${report.rpcLabel.padEnd(35)}║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  URL      : ${report.url.substring(0, 43).padEnd(43)}║`);
  console.log(`║  Probes   : ${String(summary.totalProbes).padEnd(43)}║`);
  console.log(`║  Success  : ${(summary.successRate + "%").padEnd(43)}║`);
  console.log(`╠──────────────────────────────────────────────────────────╣`);
  console.log(`║  Avg      : ${(summary.avgMs + " ms").padEnd(43)}║`);
  console.log(`║  Min      : ${(summary.minMs + " ms").padEnd(43)}║`);
  console.log(`║  Max      : ${(summary.maxMs + " ms").padEnd(43)}║`);
  console.log(`║  Median   : ${(summary.medianMs + " ms").padEnd(43)}║`);
  console.log(`║  P95      : ${(summary.p95Ms + " ms").padEnd(43)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // Per-method breakdown
  const methods = [...new Set(report.probes.map((p) => p.method))];
  for (const method of methods) {
    const mp = report.probes.filter((p) => p.method === method && p.success);
    const durations = mp.map((p) => p.durationMs).sort((a, b) => a - b);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const fails = report.probes.filter((p) => p.method === method && !p.success).length;
    const failStr = fails > 0 ? ` (${fails} fail)` : "";
    console.log(`  ${method.padEnd(25)} avg=${avg}ms  min=${durations[0] ?? "-"}ms  max=${durations[durations.length - 1] ?? "-"}ms${failStr}`);
  }
}
