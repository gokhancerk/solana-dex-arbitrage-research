/**
 * Candidate Pair Provider — EXPERIMENT_D_READY
 *
 * Reads base token mints from data/candidatePairs.json and forms
 * BASE/USDC pairs for the research scanner. No reliance on TokenSymbol.
 *
 * Supports both:
 *   - v1 format (Birdeye-based: {quoteMint, candidates: [{mint,symbol,decimals}]})
 *   - v2 format (Pool/DEX-based: {version:"discovery_v2", candidates: [{baseMint,sourceDex,poolId,...,mint,decimals}]})
 *
 * Usage:
 *   const pairs = await loadCandidatePairs();
 *   for (const pair of pairs) { ... }
 */

import { promises as fs } from "fs";
import path from "path";

// ── Types ──

export interface CandidateToken {
  mint: string;
  symbol?: string;
  decimals: number;
}

/** V2 pool metadata — attached when discovery_v2 file is loaded */
export interface PoolMeta {
  sourceDex: string;
  poolId: string;
  poolType: string;
  poolLiquidityUsd: number;
  poolVolume24hUsd: number;
  feeBps: number;
  tickSpacing: number | null;
  notes: string[];
  /** true when pool is a direct baseMint↔USDC pool (C1 candidate) */
  isDirectUsdcPool: boolean;
}

export interface CandidatePair {
  /** Stable identifier: `${baseMint}_${quoteMint}` */
  pairId: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Present when loaded from discovery_v2 */
  poolMeta?: PoolMeta;
}

/** Superset file shape that covers both v1 and v2 */
interface CandidatePairsFile {
  version?: string;
  quoteMint: string;
  quoteSymbol?: string;
  quoteDecimals: number;
  candidates: Array<CandidateToken & Partial<PoolMeta> & { baseMint?: string }>;
}

// ── Loader ──

const DATA_DIR = path.resolve(process.cwd(), "data");
const CANDIDATE_FILE = path.join(DATA_DIR, "candidatePairs.json");

let _cachedPairs: CandidatePair[] | undefined;

/**
 * Load candidate pairs from `data/candidatePairs.json`.
 * Caches result in memory — call `clearCandidateCache()` to force reload.
 */
export async function loadCandidatePairs(): Promise<CandidatePair[]> {
  if (_cachedPairs) return _cachedPairs;

  const raw = await fs.readFile(CANDIDATE_FILE, "utf-8");
  const data = JSON.parse(raw) as CandidatePairsFile;

  if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    throw new Error(`[CandidatePairProvider] No candidates in ${CANDIDATE_FILE}`);
  }

  const isV2 = data.version === "discovery_v2";

  _cachedPairs = data.candidates.map((c) => {
    // v2 uses baseMint field; v1 uses mint
    const baseMint = c.baseMint ?? c.mint;

    const pair: CandidatePair = {
      pairId: `${baseMint}_${data.quoteMint}`,
      baseMint,
      quoteMint: data.quoteMint,
      baseSymbol: c.symbol,
      quoteSymbol: data.quoteSymbol ?? "USDC",
      baseDecimals: c.decimals,
      quoteDecimals: data.quoteDecimals,
    };

    // Attach pool metadata for v2 candidates
    if (isV2 && c.sourceDex && c.poolId) {
      pair.poolMeta = {
        sourceDex: c.sourceDex,
        poolId: c.poolId,
        poolType: c.poolType ?? "unknown",
        poolLiquidityUsd: c.poolLiquidityUsd ?? 0,
        poolVolume24hUsd: c.poolVolume24hUsd ?? 0,
        feeBps: c.feeBps ?? 0,
        tickSpacing: c.tickSpacing ?? null,
        notes: c.notes ?? [],
        isDirectUsdcPool: (c as any).isDirectUsdcPool ?? true,
      };
    }

    return pair;
  });

  const versionTag = isV2 ? "v2 (pool-based)" : "v1 (token-based)";
  console.log(
    `[CandidatePairProvider] ${_cachedPairs.length} pair yüklendi [${versionTag}]: ` +
      _cachedPairs.slice(0, 10).map((p) => p.baseSymbol ?? p.baseMint.slice(0, 8)).join(", ") +
      (_cachedPairs.length > 10 ? ` … (+${_cachedPairs.length - 10} more)` : "")
  );

  return _cachedPairs;
}

/**
 * Clear the in-memory candidate pair cache.
 */
export function clearCandidateCache(): void {
  _cachedPairs = undefined;
}
