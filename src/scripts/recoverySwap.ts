/**
 * recoverySwap.ts
 * Stuck inventory'yi USDC'ye çevirir
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { getKeypairFromEnv } from "../wallet.js";
import { fetchJupiterQuote, buildJupiterSwap } from "../jupiter.js";
import { getConnection } from "../solana.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RECOVERY SWAP: mSOL → USDC");
  console.log("═══════════════════════════════════════════════════════════\n");

  const connection = getConnection();
  const wallet = getKeypairFromEnv();
  const rpcUrl = process.env.SOLANA_RPC_PRIMARY!;

  // Get mSOL balance
  const msolMint = new PublicKey(MSOL_MINT);
  const msolAta = await getAssociatedTokenAddress(msolMint, wallet.publicKey);
  const msolAcc = await getAccount(connection, msolAta);
  const msolBalance = msolAcc.amount;

  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`  mSOL balance: ${(Number(msolBalance) / 1e9).toFixed(6)} mSOL`);

  if (msolBalance === 0n) {
    console.log("\n  ✓ No mSOL to recover.");
    return;
  }

  // Get priority fee
  const feeResp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "fee",
      method: "getPriorityFeeEstimate",
      params: [{ options: { priorityLevel: "High" } }],
    }),
  });
  const feeResult = await feeResp.json();
  const priorityFee = Math.ceil(feeResult.result?.priorityFeeEstimate || 50000);

  console.log(`  Priority fee: ${priorityFee} micro-lamports`);

  // Get quote
  console.log("\n  Fetching quote...");
  const quote = await fetchJupiterQuote({
    inputMint: MSOL_MINT,
    outputMint: USDC_MINT,
    amount: msolBalance,
    slippageBps: 100, // 1% slippage
  });

  const expectedOut = Number(quote.meta.expectedOut) / 1e6;
  console.log(`  Expected output: $${expectedOut.toFixed(4)} USDC`);

  // Build swap TX
  console.log("  Building transaction...");
  const tx = await buildJupiterSwap({
    route: quote.route,
    userPublicKey: wallet.publicKey,
    priorityFeeMicroLamports: priorityFee,
  });

  // Sign and send
  tx.sign([wallet]);
  console.log("  Sending transaction...");

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  console.log(`  TX sent: ${signature}`);

  // Wait for confirmation
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) {
    console.log(`\n  ❌ FAILED: ${JSON.stringify(confirmation.value.err)}`);
    return;
  }

  console.log(`\n  ✅ SUCCESS!`);
  console.log(`  🔗 https://solscan.io/tx/${signature}`);

  // Check final balance
  const usdcMint = new PublicKey(USDC_MINT);
  const usdcAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
  const usdcAcc = await getAccount(connection, usdcAta);
  console.log(`\n  Final USDC balance: $${(Number(usdcAcc.amount) / 1e6).toFixed(4)}`);
}

main().catch(console.error);
