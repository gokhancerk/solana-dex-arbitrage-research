import { config as loadEnv } from "dotenv";
import { clusterApiUrl, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getKeypairFromEnv } from "./wallet.js";

loadEnv();

async function main() {
  const rpc = process.env.DEVNET_RPC ?? clusterApiUrl("devnet");
  const amountSol = Number(process.env.AIRDROP_SOL ?? "1");
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error(`Invalid AIRDROP_SOL amount: ${process.env.AIRDROP_SOL}`);
  }

  const connection = new Connection(rpc, { commitment: "confirmed" });
  const payer = getKeypairFromEnv();

  console.log(`Requesting ${amountSol} SOL airdrop to ${payer.publicKey.toBase58()} on devnet via ${rpc}`);
  const sig = await connection.requestAirdrop(payer.publicKey, Math.round(amountSol * LAMPORTS_PER_SOL));
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");

  const balance = await connection.getBalance(payer.publicKey, "confirmed");
  console.log(`Airdrop complete. Signature=${sig}`);
  console.log(`New balance: ${balance / LAMPORTS_PER_SOL} SOL (devnet)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
