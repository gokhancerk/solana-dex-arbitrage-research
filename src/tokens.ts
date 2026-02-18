import { PublicKey } from "@solana/web3.js";
import { loadConfig, type TokenSymbol } from "./config.js";

export interface MintAmount {
  mint: string;
  decimals: number;
}

export function getMintInfo(symbol: "USDC" | TokenSymbol): MintAmount {
  const cfg = loadConfig();
  const token = cfg.tokens[symbol];
  if (!token) {
    throw new Error(`Missing token config for ${symbol}`);
  }
  return { mint: token.mint, decimals: token.decimals };
}

export function toRaw(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

export function fromRaw(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function isSolMint(mint: string): boolean {
  return mint === PublicKey.default.toBase58();
}
