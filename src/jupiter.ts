import { VersionedTransaction, PublicKey, TransactionInstruction, AddressLookupTableAccount } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { QuoteMeta, SimulationOutcome } from "./types.js";
import { simulateTx } from "./solana.js";

const JUP_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP_URL = "https://api.jup.ag/swap/v1/swap";
const JUP_SWAP_INSTRUCTIONS_URL = "https://api.jup.ag/swap/v1/swap-instructions";

export interface JupiterRouteInfo {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint; // raw units
  slippageBps: number;
  /** Optional: filter to specific DEX protocols (e.g., "Whirlpool", "Raydium,RaydiumCLMM") */
  dexes?: string;
  /** Optional: only direct routes (no intermediate tokens) */
  onlyDirectRoutes?: boolean;
}

export interface JupiterSwapParams {
  route: JupiterRouteInfo;
  userPublicKey: PublicKey;
  asLegacy?: boolean;
  /**
   * true (default): Jupiter wraps native SOL → wSOL before swap, unwraps after.
   * false: Jupiter uses existing wSOL token account directly.
   * Set to false when selling wSOL that already sits in a token account
   * (e.g. received from OKX Leg 1) to avoid "insufficient lamports" errors.
   */
  wrapAndUnwrapSol?: boolean;
  /** Override priority fee (micro-lamports). Dynamic fee from fees.ts */
  priorityFeeMicroLamports?: number;
}

export async function fetchJupiterQuote(params: JupiterQuoteParams): Promise<{ route: JupiterRouteInfo; meta: QuoteMeta }> {
  const { inputMint, outputMint, amount, slippageBps, dexes, onlyDirectRoutes } = params;
  const url = new URL(JUP_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());
  url.searchParams.set("onlyDirectRoutes", onlyDirectRoutes === true ? "true" : "false");
  url.searchParams.set("restrictIntermediateTokens", "true");
  if (dexes) {
    url.searchParams.set("dexes", dexes);
  }

  const cfg = loadConfig();
  if (!cfg.jupiterApiKey) {
    throw new Error(
      "JUPITER_API_KEY env var is required. Get a free key at https://station.jup.ag/docs/apis/swap-api and add JUPITER_API_KEY=<key> to your .env file."
    );
  }
  const headers: Record<string, string> = {
    "x-api-key": cfg.jupiterApiKey
  };

  console.log("[DEBUG] Jupiter Request URL:", url.toString());
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jupiter quote failed: ${res.status} ${res.statusText} – ${body}`);
  }
  const route = (await res.json()) as JupiterRouteInfo;
  if (!route.outAmount) {
    throw new Error("No Jupiter route returned or empty outAmount");
  }
  const meta: QuoteMeta = {
    venue: "JUPITER",
    inMint: inputMint,
    outMint: outputMint,
    inAmount: amount,
    expectedOut: BigInt(route.outAmount),
    slippageBps,
    routeContext: route
  };

  return { route, meta };
}

export async function buildJupiterSwap(params: JupiterSwapParams): Promise<VersionedTransaction> {
  const cfg = loadConfig();
  const body = {
    quoteResponse: params.route,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    asLegacyTransaction: params.asLegacy ?? false,
    useSharedAccounts: true,
    computeUnitPriceMicroLamports: params.priorityFeeMicroLamports ?? cfg.rpc.priorityFeeMicrolamports
  };

  const swapHeaders: Record<string, string> = { "content-type": "application/json" };
  if (cfg.jupiterApiKey) {
    swapHeaders["x-api-key"] = cfg.jupiterApiKey;
  }

  const res = await fetch(JUP_SWAP_URL, {
    method: "POST",
    headers: swapHeaders,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Jupiter swap build failed: ${res.status} ${res.statusText} – ${errBody}`);
  }

  const json = (await res.json()) as JupiterSwapResponse;
  const raw = Buffer.from(json.swapTransaction, "base64");
  return VersionedTransaction.deserialize(raw);
}

export async function simulateJupiterTx(
  connection: Parameters<typeof simulateTx>[0],
  tx: VersionedTransaction
): Promise<SimulationOutcome> {
  return simulateTx(connection, tx);
}

export function computeSlippageBps(expectedOut: bigint, simulatedOut?: bigint): number | undefined {
  if (!simulatedOut || expectedOut === BigInt(0)) return undefined;
  const delta = Number(expectedOut - simulatedOut);
  return Math.max(0, Math.round((delta * 10000) / Number(expectedOut)));
}

// ══════════════════════════════════════════════════════════════
//  Swap Instructions API (for atomic multi-swap TX)
// ══════════════════════════════════════════════════════════════

interface SerializedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: SerializedInstruction;
  computeBudgetInstructions: SerializedInstruction[];
  setupInstructions: SerializedInstruction[];
  swapInstruction: SerializedInstruction;
  cleanupInstruction?: SerializedInstruction;
  otherInstructions: SerializedInstruction[];
  addressLookupTableAddresses: string[];
}

export interface JupiterSwapInstructionsParams {
  route: JupiterRouteInfo;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean;
  /** Skip compute budget - we'll add our own unified budget */
  skipComputeBudget?: boolean;
}

/**
 * Deserialize a Jupiter serialized instruction into a TransactionInstruction
 */
export function deserializeInstruction(ix: SerializedInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/**
 * Fetch swap instructions from Jupiter (instead of a full transaction).
 * This allows merging multiple swaps into a single atomic transaction.
 */
export async function fetchJupiterSwapInstructions(
  params: JupiterSwapInstructionsParams
): Promise<{
  setupInstructions: TransactionInstruction[];
  swapInstruction: TransactionInstruction;
  cleanupInstruction?: TransactionInstruction;
  addressLookupTableAddresses: string[];
}> {
  const cfg = loadConfig();
  const body = {
    quoteResponse: params.route,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    useSharedAccounts: true,
    // We don't want Jupiter's compute budget - we'll set our own
    dynamicComputeUnitLimit: false,
    prioritizationFeeLamports: 0,
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.jupiterApiKey) {
    headers["x-api-key"] = cfg.jupiterApiKey;
  }

  const res = await fetch(JUP_SWAP_INSTRUCTIONS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Jupiter swap-instructions failed: ${res.status} ${res.statusText} – ${errBody}`);
  }

  const json = (await res.json()) as JupiterSwapInstructionsResponse;

  // Deserialize instructions
  const setupInstructions = json.setupInstructions.map(deserializeInstruction);
  const swapInstruction = deserializeInstruction(json.swapInstruction);
  const cleanupInstruction = json.cleanupInstruction
    ? deserializeInstruction(json.cleanupInstruction)
    : undefined;

  return {
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    addressLookupTableAddresses: json.addressLookupTableAddresses,
  };
}
