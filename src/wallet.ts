import { Keypair } from "@solana/web3.js";
import fs from "fs";

export function loadKeypairFromFile(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf-8");
  try {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (jsonErr) {
    // Fallback: treat as base58 string (not recommended for storage).
    try {
      const cleaned = raw.trim();
      return Keypair.fromSecretKey(Buffer.from(cleaned, "base64"));
    } catch (e) {
      throw new Error(`Failed to parse keypair file ${path}: ${jsonErr}`);
    }
  }
}

export function getKeypairFromEnv(): Keypair {
  const keypath = process.env.WALLET_KEYPATH;
  if (!keypath) {
    throw new Error("Missing WALLET_KEYPATH env; please point to an encrypted keypair file");
  }
  return loadKeypairFromFile(keypath);
}
