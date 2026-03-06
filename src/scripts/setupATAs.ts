/**
 * Setup ATAs — Create Associated Token Accounts for Route1 trading
 *
 * Creates ATAs for SOL (wSOL), mSOL, whETH if they don't exist.
 * Required for TX simulation to work properly.
 *
 * Usage:
 *   npx tsx src/scripts/setupATAs.ts
 *   npx tsx src/scripts/setupATAs.ts --dry
 */

import "dotenv/config";
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";

import { getConnection } from "../solana.js";
import { getKeypairFromEnv } from "../wallet.js";

// Token mints for Route1 pairs
const TOKEN_MINTS = {
  wSOL: new PublicKey("So11111111111111111111111111111111111111112"),
  mSOL: new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
  whETH: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
};

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Setup ATAs — Create Associated Token Accounts               ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const dryRun = process.argv.includes("--dry");
  
  const connection = getConnection();
  const owner = getKeypairFromEnv();
  const ownerPub = owner.publicKey;

  console.log(`  Owner: ${ownerPub.toBase58()}`);
  console.log(`  Dry run: ${dryRun}\n`);

  // Check SOL balance
  const solBalance = await connection.getBalance(ownerPub);
  console.log(`  SOL Balance: ${(solBalance / 1e9).toFixed(4)} SOL\n`);

  if (solBalance < 0.01 * 1e9) {
    console.error(`  ✗ Insufficient SOL balance for ATA creation (~0.002 SOL per ATA)`);
    process.exit(1);
  }

  const atasToCreate: { name: string; mint: PublicKey; ata: PublicKey }[] = [];

  console.log(`  ── Checking ATAs ──────────────────────────────────────────\n`);

  for (const [name, mint] of Object.entries(TOKEN_MINTS)) {
    const ata = await getAssociatedTokenAddress(mint, ownerPub);
    
    try {
      const accountInfo = await connection.getAccountInfo(ata);
      if (accountInfo) {
        console.log(`  ✓ ${name.padEnd(6)} ATA exists: ${ata.toBase58().slice(0, 12)}…`);
      } else {
        console.log(`  ○ ${name.padEnd(6)} ATA missing: ${ata.toBase58().slice(0, 12)}…`);
        atasToCreate.push({ name, mint, ata });
      }
    } catch {
      console.log(`  ○ ${name.padEnd(6)} ATA missing: ${ata.toBase58().slice(0, 12)}…`);
      atasToCreate.push({ name, mint, ata });
    }
  }

  if (atasToCreate.length === 0) {
    console.log(`\n  ✓ All ATAs already exist. Nothing to do.\n`);
    return;
  }

  console.log(`\n  ── Creating ${atasToCreate.length} ATA(s) ──────────────────────────────────\n`);

  if (dryRun) {
    for (const { name, ata } of atasToCreate) {
      console.log(`  [DRY] Would create ${name} ATA: ${ata.toBase58()}`);
    }
    console.log(`\n  [DRY RUN] No transactions sent.\n`);
    return;
  }

  // Build transaction with all ATA creation instructions
  const tx = new Transaction();
  
  for (const { name, mint, ata } of atasToCreate) {
    const ix = createAssociatedTokenAccountInstruction(
      ownerPub,     // payer
      ata,          // ata
      ownerPub,     // owner
      mint,         // mint
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    tx.add(ix);
    console.log(`  + Adding ${name} ATA creation instruction`);
  }

  console.log(`\n  Sending transaction…`);

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [owner], {
      commitment: "confirmed",
    });
    console.log(`  ✓ Transaction confirmed: ${sig}`);
    console.log(`  https://solscan.io/tx/${sig}\n`);
  } catch (err) {
    console.error(`  ✗ Transaction failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Verify creation
  console.log(`  ── Verifying ATAs ─────────────────────────────────────────\n`);

  for (const { name, ata } of atasToCreate) {
    const accountInfo = await connection.getAccountInfo(ata);
    if (accountInfo) {
      console.log(`  ✓ ${name} ATA created successfully`);
    } else {
      console.log(`  ✗ ${name} ATA creation may have failed`);
    }
  }

  console.log(`\n  Done.\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
