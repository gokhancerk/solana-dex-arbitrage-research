import {
  Commitment,
  Connection,
  PublicKey,
  SendOptions,
  SimulatedTransactionResponse,
  VersionedTransaction
} from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { SimulationOutcome } from "./types.js";

// ── ATA (Associated Token Account) helpers ───────────────────────────
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * Derive the Associated Token Account (ATA) address for a given owner + mint.
 * Uses the same PDA derivation as @solana/spl-token without requiring that package.
 */
export function deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

export interface SolBalanceInfo {
  /** wSOL balance in the ATA (raw lamports). 0 if ATA doesn't exist. */
  wsolAtaBalance: bigint;
  /** Native SOL balance in lamports (includes rent, fees etc.) */
  nativeLamports: bigint;
  /** Usable native SOL after reserving ~0.01 SOL for rent+fees */
  usableNativeLamports: bigint;
  /** Whether the wSOL ATA holds enough to swap */
  useAta: boolean;
  /** Actual amount to swap (raw lamports) */
  swapAmount: bigint;
  /** Whether to set wrapAndUnwrapSol in Jupiter */
  wrapAndUnwrapSol: boolean;
}

/** Minimum SOL to reserve for rent + fee (~0.01 SOL) */
const SOL_RENT_RESERVE_LAMPORTS = BigInt(10_000_000);

/**
 * For SOL token: queries on-chain to determine whether wSOL sits in
 * the user's ATA or as native lamports, and returns the correct swap
 * amount + wrapAndUnwrapSol flag.
 *
 * This is needed because OKX may unwrap wSOL → native SOL after Leg 1.
 */
export async function resolveSolBalance(
  owner: PublicKey,
  wsolMint: PublicKey,
  expectedAmount: bigint
): Promise<SolBalanceInfo> {
  const connection = getConnection();

  // Read both balances in parallel
  const ata = deriveATA(owner, wsolMint);
  const [ataInfo, nativeLamports] = await Promise.all([
    connection.getTokenAccountBalance(ata).catch(() => null),
    connection.getBalance(owner).then(b => BigInt(b)),
  ]);

  const wsolAtaBalance = ataInfo ? BigInt(ataInfo.value.amount) : BigInt(0);
  const usableNative = nativeLamports > SOL_RENT_RESERVE_LAMPORTS
    ? nativeLamports - SOL_RENT_RESERVE_LAMPORTS
    : BigInt(0);

  console.log(
    `[SOL-BALANCE] wSOL ATA: ${wsolAtaBalance.toString()} lamports | ` +
    `Native: ${nativeLamports.toString()} lamports (usable: ${usableNative.toString()}) | ` +
    `Expected: ${expectedAmount.toString()}`
  );

  // Decision: use ATA if it has ≥80% of expected amount (slippage tolerance)
  const threshold = (expectedAmount * BigInt(80)) / BigInt(100);
  if (wsolAtaBalance >= threshold && wsolAtaBalance > BigInt(0)) {
    return {
      wsolAtaBalance,
      nativeLamports,
      usableNativeLamports: usableNative,
      useAta: true,
      swapAmount: wsolAtaBalance,       // use exact ATA balance
      wrapAndUnwrapSol: false,          // use existing wSOL ATA
    };
  }

  // ATA is empty/low → SOL is native, Jupiter must wrap
  if (usableNative >= threshold && usableNative > BigInt(0)) {
    return {
      wsolAtaBalance,
      nativeLamports,
      usableNativeLamports: usableNative,
      useAta: false,
      swapAmount: usableNative > expectedAmount ? expectedAmount : usableNative,
      wrapAndUnwrapSol: true,           // wrap native SOL
    };
  }

  // Neither has enough — try whatever is bigger
  const bigger = wsolAtaBalance >= usableNative ? "ata" : "native";
  const swapAmount = bigger === "ata" ? wsolAtaBalance : usableNative;
  console.warn(
    `[SOL-BALANCE] ⚠ Yetersiz bakiye! ATA=${wsolAtaBalance.toString()}, ` +
    `native usable=${usableNative.toString()}, expected=${expectedAmount.toString()}. ` +
    `En büyük kaynak (${bigger}) ile deneniyor: ${swapAmount.toString()}`
  );

  return {
    wsolAtaBalance,
    nativeLamports,
    usableNativeLamports: usableNative,
    useAta: bigger === "ata",
    swapAmount,
    wrapAndUnwrapSol: bigger !== "ata",
  };
}

export function getConnection(): Connection {
  const cfg = loadConfig();
  return new Connection(cfg.rpc.primary, {
    commitment: cfg.rpc.commitment ?? "confirmed"
  });
}

export async function fallbackConnection(): Promise<Connection> {
  const cfg = loadConfig();
  if (!cfg.rpc.backup) {
    return getConnection();
  }
  return new Connection(cfg.rpc.backup, {
    commitment: cfg.rpc.commitment ?? "confirmed"
  });
}

export async function simulateTx(
  connection: Connection,
  tx: VersionedTransaction,
  commitment: Commitment = "confirmed"
): Promise<SimulationOutcome> {
  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment
  });

  type TokenBalanceEntry = {
    mint: string;
    owner: string;
    uiTokenAmount: {
      amount: string;
      decimals: number;
      uiAmount?: number | null;
      uiAmountString?: string | null;
    };
  };

  type ExtendedSimValue = SimulatedTransactionResponse & {
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  };

  const value = sim.value as ExtendedSimValue;

  const mapTokenBalances = (arr?: TokenBalanceEntry[]) =>
    arr?.map((b) => ({
      mint: b.mint,
      owner: b.owner,
      rawAmount: b.uiTokenAmount.amount,
      uiAmount: b.uiTokenAmount.uiAmountString ?? undefined,
      decimals: b.uiTokenAmount.decimals
    }));

  return {
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed,
    error: value.err ? JSON.stringify(value.err) : undefined,
    accountsLoaded: value.accounts?.length,
    preBalances: value.preBalances?.map((b: number) => BigInt(b)),
    postBalances: value.postBalances?.map((b: number) => BigInt(b)),
    preTokenBalances: mapTokenBalances(value.preTokenBalances),
    postTokenBalances: mapTokenBalances(value.postTokenBalances)
  };
}

export async function sendVersionedWithOpts(
  connection: Connection,
  tx: VersionedTransaction,
  opts?: SendOptions
): Promise<string> {
  return connection.sendTransaction(tx, opts);
}

/**
 * Bir TX signature'ının on-chain confirm olmasını bekler.
 * Blockhash stratejisi kullanır — sonsuz beklemeyi engeller.
 *
 * Bu, sendTransaction() sonrası çağrılmalıdır. sendTransaction sadece
 * signature döndürür, TX'in zincirde yer aldığını GARANTİ ETMEZ.
 *
 * Kullanım alanı: Leg 1 gönderildikten sonra bakiye güncellenene kadar
 * beklemek (resolveSolBalance'ın doğru bakiye okuması için).
 */
export async function waitForConfirmation(
  signature: string,
  commitment: Commitment = "confirmed",
  timeoutMs: number = 60_000
): Promise<void> {
  const connection = getConnection();
  const t0 = Date.now();

  console.log(
    `[CONFIRM] TX onay bekleniyor (${commitment}): ${signature.slice(0, 12)}…`
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);

  const result = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    commitment
  );

  const elapsed = Date.now() - t0;

  if (result.value.err) {
    console.error(
      `[CONFIRM] TX on-chain HATA ile confirm oldu (${elapsed}ms): ${JSON.stringify(result.value.err)}`
    );
    throw new Error(
      `TX confirmed with error: ${JSON.stringify(result.value.err)}`
    );
  }

  console.log(
    `[CONFIRM] TX on-chain confirm ✓ (${elapsed}ms): ${signature.slice(0, 12)}…`
  );
}
