/**
 * heliusLandingTest.ts
 * Basit SOL self-transfer ile Helius Priority Fee API + sendTransaction test eder.
 * Edge beklemeden landing başarısını doğrular.
 */

import { 
  Connection,
  Keypair, 
  SystemProgram, 
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY!;
const RPC_URL = process.env.SOLANA_RPC_PRIMARY!;
const TRANSFER_LAMPORTS = 1000; // 0.000001 SOL - minimal test

interface TestResult {
  attempt: number;
  success: boolean;
  signature?: string;
  error?: string;
  latencyMs: number;
  priorityFee: number;
  timestamp: string;
}

async function loadWallet(): Promise<Keypair> {
  const keyPath = path.resolve(process.cwd(), '.key/keypair.json');
  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(keyData));
}

// Helius Priority Fee API
async function getPriorityFee(): Promise<number> {
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'priority-fee',
        method: 'getPriorityFeeEstimate',
        params: [{
          options: {
            priorityLevel: 'High'
          }
        }]
      })
    });
    
    const result = await response.json();
    if (result.result?.priorityFeeEstimate) {
      return Math.ceil(result.result.priorityFeeEstimate);
    }
    return 50000; // fallback
  } catch {
    return 50000; // fallback
  }
}

async function runTest(attempt: number, connection: Connection, wallet: Keypair): Promise<TestResult> {
  const timestamp = new Date().toISOString();
  const start = Date.now();
  
  try {
    // Get optimal priority fee from Helius
    const priorityFee = await getPriorityFee();
    console.log(`  Priority fee: ${priorityFee} micro-lamports`);
    
    // Build instructions with priority fee
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee
    });
    
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 200_000
    });
    
    // Self-transfer instruction
    const transferIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: TRANSFER_LAMPORTS
    });
    
    // Build versioned transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, computeLimitIx, transferIx]
    }).compileToV0Message();
    
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);
    
    // Send via Helius RPC
    console.log(`\n  [Attempt ${attempt}] Sending via Helius RPC...`);
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed'
    });
    
    // Wait for confirmation
    console.log(`  Waiting for confirmation...`);
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');
    
    const latencyMs = Date.now() - start;
    
    if (confirmation.value.err) {
      throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log(`  ✅ SUCCESS | Signature: ${signature}`);
    console.log(`  ⏱ Latency: ${latencyMs}ms`);
    console.log(`  🔗 https://solscan.io/tx/${signature}`);
    
    return {
      attempt,
      success: true,
      signature,
      latencyMs,
      priorityFee,
      timestamp
    };
    
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const errorMsg = err.message || String(err);
    console.log(`  ❌ FAILED | Error: ${errorMsg}`);
    console.log(`  ⏱ Latency: ${latencyMs}ms`);
    
    return {
      attempt,
      success: false,
      error: errorMsg,
      latencyMs,
      priorityFee: 0,
      timestamp
    };
  }
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  HELIUS Priority Fee API + sendTransaction LANDING TEST');
  console.log('════════════════════════════════════════════════════════════');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = await loadWallet();
  
  console.log(`\n  Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`  Transfer: ${TRANSFER_LAMPORTS} lamports (self-transfer)`);
  console.log(`  Helius API: ${HELIUS_API_KEY.slice(0, 8)}...`);
  
  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  
  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.log('\n  ⚠️ Low balance! Need at least 0.01 SOL for test.');
    return;
  }
  
  const results: TestResult[] = [];
  const TEST_COUNT = 3;
  
  for (let i = 1; i <= TEST_COUNT; i++) {
    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`  TEST ${i}/${TEST_COUNT}`);
    console.log(`────────────────────────────────────────────────────────────`);
    
    const result = await runTest(i, connection, wallet);
    results.push(result);
    
    // Wait between attempts
    if (i < TEST_COUNT) {
      console.log(`\n  Waiting 2s before next attempt...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  // Summary
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  
  const successes = results.filter(r => r.success);
  const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;
  
  console.log(`\n  Total attempts: ${results.length}`);
  console.log(`  Successes: ${successes.length} (${((successes.length / results.length) * 100).toFixed(0)}%)`);
  console.log(`  Avg latency: ${avgLatency.toFixed(0)}ms`);
  
  if (successes.length === results.length) {
    console.log('\n  ✅ VERDICT: Helius sendSmartTransaction WORKING');
    console.log('  → Altyapı hazır, arbitrage execution için kullanılabilir.');
  } else if (successes.length > 0) {
    console.log('\n  ⚠️ VERDICT: PARTIAL SUCCESS');
    console.log(`  → ${successes.length}/${results.length} landed. Reliability questionable.`);
  } else {
    console.log('\n  ❌ VERDICT: Helius sendSmartTransaction FAILED');
    console.log('  → Altyapı çalışmıyor veya konfigürasyon hatası var.');
  }
  
  // Save results
  const reportPath = 'data/telemetry/helius_landing_test.json';
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    testDate: new Date().toISOString(),
    wallet: wallet.publicKey.toBase58(),
    transferLamports: TRANSFER_LAMPORTS,
    results,
    summary: {
      total: results.length,
      successes: successes.length,
      successRate: successes.length / results.length,
      avgLatencyMs: avgLatency
    },
    verdict: successes.length === results.length ? 'PASS' : 
             successes.length > 0 ? 'PARTIAL' : 'FAIL'
  }, null, 2));
  
  console.log(`\n  📁 Results saved to ${reportPath}`);
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
