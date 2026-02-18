import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { QuoteMeta, SimulationOutcome } from "./types.js";
import { simulateTx } from "./solana.js";

const JUP_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

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
}

export interface JupiterSwapParams {
  route: JupiterRouteInfo;
  userPublicKey: PublicKey;
  asLegacy?: boolean;
}

export async function fetchJupiterQuote(params: JupiterQuoteParams): Promise<{ route: JupiterRouteInfo; meta: QuoteMeta }> {
  const { inputMint, outputMint, amount, slippageBps } = params;
  const url = new URL(JUP_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());
  url.searchParams.set("onlyDirectRoutes", "false");
  url.searchParams.set("restrictIntermediateTokens", "true");

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
    wrapAndUnwrapSol: true,
    asLegacyTransaction: params.asLegacy ?? false,
    useSharedAccounts: true,
    computeUnitPriceMicroLamports: cfg.rpc.priorityFeeMicrolamports
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
