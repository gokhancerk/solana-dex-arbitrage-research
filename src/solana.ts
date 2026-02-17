import {
  Commitment,
  Connection,
  SendOptions,
  SimulatedTransactionResponse,
  VersionedTransaction
} from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { SimulationOutcome } from "./types.js";

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
