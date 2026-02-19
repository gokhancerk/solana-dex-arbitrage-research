/**
 * Candidate Pair Provider — EXPERIMENT_D_READY
 *
 * Reads base token mints from data/candidatePairs.json and forms
 * BASE/USDC pairs for the research scanner. No reliance on TokenSymbol.
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

export interface CandidatePair {
  /** Stable identifier: `${baseMint}_${quoteMint}` */
  pairId: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  baseDecimals: number;
  quoteDecimals: number;
}

interface CandidatePairsFile {
  quoteMint: string;
  quoteSymbol?: string;
  quoteDecimals: number;
  candidates: CandidateToken[];
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

  _cachedPairs = data.candidates.map((c) => ({
    pairId: `${c.mint}_${data.quoteMint}`,
    baseMint: c.mint,
    quoteMint: data.quoteMint,
    baseSymbol: c.symbol,
    quoteSymbol: data.quoteSymbol ?? "USDC",
    baseDecimals: c.decimals,
    quoteDecimals: data.quoteDecimals,
  }));

  console.log(
    `[CandidatePairProvider] ${_cachedPairs.length} pair yüklendi: ` +
      _cachedPairs.map((p) => p.baseSymbol ?? p.baseMint.slice(0, 8)).join(", ")
  );

  return _cachedPairs;
}

/**
 * Clear the in-memory candidate pair cache.
 */
export function clearCandidateCache(): void {
  _cachedPairs = undefined;
}
