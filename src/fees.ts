import { Connection } from "@solana/web3.js";

export interface FeeSuggestion {
  priorityFeeMicrolamports: number;
  source: "recent" | "cached";
}

/** Cache: son başarılı fee suggestion + TTL */
let cachedFee: FeeSuggestion | undefined;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000; // 10 saniye cache

/**
 * Zincirden güncel median priority fee'yi çeker.
 * Cache kullanır (10s TTL) — her tick'te RPC çağrısı yapmaz.
 * maxFee ile cap'lenir — aşırı fee ödemesini engeller.
 */
export async function suggestPriorityFee(
  connection: Connection,
  maxFee?: number
): Promise<FeeSuggestion | undefined> {
  const now = Date.now();
  if (cachedFee && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedFee;
  }

  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return cachedFee; // stale cache dön

    // Sıfır olmayan fee'leri filtrele, median al
    const nonZero = fees
      .map(f => f.prioritizationFee)
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    if (!nonZero.length) {
      // Tüm fee'ler 0 — minimum fee kullan
      const result: FeeSuggestion = { priorityFeeMicrolamports: 1000, source: "recent" };
      cachedFee = result;
      cacheTimestamp = now;
      return result;
    }

    // p50 (median) al — agresif olmadan makul fee
    const medianIdx = Math.floor(nonZero.length / 2);
    let microLamports = nonZero[medianIdx];

    // Cap uygula
    if (maxFee && microLamports > maxFee) {
      microLamports = maxFee;
    }

    const result: FeeSuggestion = { priorityFeeMicrolamports: microLamports, source: "recent" };
    cachedFee = result;
    cacheTimestamp = now;
    console.log(`[FEE] Dinamik priority fee: ${microLamports} micro-lamports (median of ${nonZero.length} samples)`);
    return result;
  } catch (err) {
    // RPC hatası — stale cache varsa onu dön
    return cachedFee;
  }
}

/** Cache'i sıfırla (test için) */
export function resetFeeCache(): void {
  cachedFee = undefined;
  cacheTimestamp = 0;
}
