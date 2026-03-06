import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import 'dotenv/config';

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_PRIMARY!);
  const wallet = new PublicKey('DDW5GAa4TRTfyyTSgKyoos7nDXM98dJdqUh1q2qyGBdu');

  console.log('Wallet:', wallet.toBase58());

  // USDC
  const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const usdcAta = await getAssociatedTokenAddress(usdcMint, wallet);
  const usdcAcc = await getAccount(conn, usdcAta);
  console.log('USDC:', (Number(usdcAcc.amount) / 1e6).toFixed(4));

  // mSOL
  const msolMint = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
  const msolAta = await getAssociatedTokenAddress(msolMint, wallet);
  try {
    const msolAcc = await getAccount(conn, msolAta);
    console.log('mSOL:', (Number(msolAcc.amount) / 1e9).toFixed(6));
  } catch { console.log('mSOL: 0'); }

  // SOL
  const sol = await conn.getBalance(wallet);
  console.log('SOL:', (sol / 1e9).toFixed(4));
}

main().catch(console.error);
