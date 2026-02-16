import { Connection } from "@solana/web3.js";

export interface FeeSuggestion {
  priorityFeeMicrolamports: number;
  source: "recent";
}

export async function suggestPriorityFee(connection: Connection): Promise<FeeSuggestion | undefined> {
  try {
    // getRecentPrioritizationFees returns lamports per CU; convert to micro-lamports for Jupiter/OKX params.
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return undefined;
    const mid = fees[Math.floor(fees.length / 2)].prioritizationFee; // lamports per CU
    const microLamports = Math.max(0, Math.round(mid * 1_000_000));
    return { priorityFeeMicrolamports: microLamports, source: "recent" };
  } catch (err) {
    return undefined;
  }
}
