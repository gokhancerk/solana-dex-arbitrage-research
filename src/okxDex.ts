import {
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  PublicKey,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { createHmac } from "node:crypto";
import { loadConfig } from "./config.js";
import { QuoteMeta, SimulationOutcome } from "./types.js";
import { simulateTx, getConnection } from "./solana.js";

/** OKX API istekleri için varsayılan timeout (ms) */
const OKX_FETCH_TIMEOUT_MS = 15_000;

// ── OKX DEX Aggregator v6 endpoints (GET) ───────────────────────────
const OKX_QUOTE_PATH = "/api/v6/dex/aggregator/quote";
const OKX_SWAP_INSTRUCTION_PATH = "/api/v6/dex/aggregator/swap-instruction";

// ── Response types ──────────────────────────────────────────────────
interface OkxQuoteRouterResult {
  toTokenAmount: string;
  fromTokenAmount: string;
  dexRouterList: unknown;
  estimateGasFee?: string;
  priceImpactPercent?: string;
  tradeFee?: string;
}

interface OkxQuoteResponse {
  code: string;
  msg: string;
  data?: OkxQuoteRouterResult[];
}

interface OkxSwapInstructionAccount {
  isSigner: boolean;
  isWritable: boolean;
  pubkey: string;
}

interface OkxSwapInstruction {
  data: string;
  accounts: OkxSwapInstructionAccount[];
  programId: string;
}

interface OkxSwapInstructionData {
  addressLookupTableAccount?: string[];
  instructionLists: OkxSwapInstruction[];
  routerResult: OkxQuoteRouterResult;
  tx: {
    from: string;
    to: string;
    minReceiveAmount: string;
    slippagePercent: string;
  };
}

interface OkxSwapInstructionResponse {
  code: string;
  msg: string;
  data?: OkxSwapInstructionData;
}

// ── Params ──────────────────────────────────────────────────────────
export interface OkxQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint; // raw units
  slippageBps: number;
  userPublicKey: string;
}

export interface OkxSwapParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  userPublicKey: string;
}

// ── HMAC Signature (OKX requires OK-ACCESS-SIGN) ───────────────────
function buildOkxHeaders(method: string, requestPath: string) {
  const cfg = loadConfig();
  const timestamp = new Date().toISOString();

  // Sign = Base64(HMAC-SHA256(secret, timestamp + method + requestPath + body))
  // For GET requests body is empty string
  const preHash = timestamp + method.toUpperCase() + requestPath;
  const sign = createHmac("sha256", cfg.okxApiSecret ?? "")
    .update(preHash)
    .digest("base64");

  return {
    "OK-ACCESS-KEY": cfg.okxApiKey ?? "",
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": cfg.okxApiPassphrase ?? "",
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PROJECT": cfg.okxProjectId ?? "",
  };
}

// ── Quote ───────────────────────────────────────────────────────────
export async function fetchOkxQuote(
  params: OkxQuoteParams
): Promise<{ ctx: OkxQuoteRouterResult; meta: QuoteMeta }> {
  const cfg = loadConfig();

  // Slippage: OKX expects a percentage string (e.g. "0.2" = 0.2%)
  const slippagePercent = (params.slippageBps / 100).toString();

  // Build query string — OKX DEX Aggregator uses GET with query params
  const qs = new URLSearchParams({
    chainIndex: "501", // Solana mainnet-beta
    fromTokenAddress: params.inputMint,
    toTokenAddress: params.outputMint,
    amount: params.amount.toString(),
    slippagePercent,
  });

  const requestPath = `${OKX_QUOTE_PATH}?${qs.toString()}`;
  const fullUrl = `${cfg.okxBaseUrl}${requestPath}`;
  console.log(`[DEBUG] OKX Quote Request URL: ${fullUrl}`);

  const headers = buildOkxHeaders("GET", requestPath);

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(OKX_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] OKX quote fetch hatası: ${reason}`);
    throw new Error(
      `OKX quote fetch failed (timeout=${OKX_FETCH_TIMEOUT_MS}ms): ${reason}`
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(body okunamadı)");
    console.error(`[ERROR] OKX quote HTTP ${res.status}: ${bodyText}`);
    throw new Error(
      `OKX quote failed: ${res.status} ${res.statusText} — ${bodyText}`
    );
  }

  const json = (await res.json()) as OkxQuoteResponse;
  if (json.code !== "0" || !json.data?.length) {
    console.error(
      `[ERROR] OKX quote API hatası: code=${json.code}, msg=${json.msg}`
    );
    throw new Error(`OKX quote error: code=${json.code}, msg=${json.msg}`);
  }

  const route = json.data[0];
  const meta: QuoteMeta = {
    venue: "OKX",
    inMint: params.inputMint,
    outMint: params.outputMint,
    inAmount: params.amount,
    expectedOut: BigInt(route.toTokenAmount),
    slippageBps: params.slippageBps,
    routeContext: route.dexRouterList,
  };

  return { ctx: route, meta };
}

// ── Swap Instruction (Solana-specific) ──────────────────────────────
export async function buildOkxSwap(
  params: OkxSwapParams
): Promise<VersionedTransaction> {
  const cfg = loadConfig();

  const slippagePercent = (params.slippageBps / 100).toString();

  const qsParams: Record<string, string> = {
    chainIndex: "501",
    fromTokenAddress: params.inputMint,
    toTokenAddress: params.outputMint,
    amount: params.amount.toString(),
    slippagePercent,
    userWalletAddress: params.userPublicKey,
  };

  // Optional: priority fee
  if (cfg.rpc.priorityFeeMicrolamports != null) {
    qsParams.computeUnitPrice = cfg.rpc.priorityFeeMicrolamports.toString();
  }

  const qs = new URLSearchParams(qsParams);
  const requestPath = `${OKX_SWAP_INSTRUCTION_PATH}?${qs.toString()}`;
  const fullUrl = `${cfg.okxBaseUrl}${requestPath}`;
  console.log(`[DEBUG] OKX Swap-Instruction Request URL: ${fullUrl}`);

  const headers = buildOkxHeaders("GET", requestPath);

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(OKX_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] OKX swap-instruction fetch hatası: ${reason}`);
    throw new Error(
      `OKX swap-instruction fetch failed (timeout=${OKX_FETCH_TIMEOUT_MS}ms): ${reason}`
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(body okunamadı)");
    console.error(`[ERROR] OKX swap-instruction HTTP ${res.status}: ${bodyText}`);
    throw new Error(
      `OKX swap-instruction failed: ${res.status} ${res.statusText} — ${bodyText}`
    );
  }

  const json = (await res.json()) as OkxSwapInstructionResponse;
  if (json.code !== "0" || !json.data) {
    console.error(
      `[ERROR] OKX swap-instruction API hatası: code=${json.code}, msg=${json.msg}`
    );
    throw new Error(
      `OKX swap-instruction error: code=${json.code}, msg=${json.msg}`
    );
  }

  // Build VersionedTransaction from individual instructions
  return assembleOkxTransaction(json.data, params.userPublicKey);
}

// ── Assemble instructions into VersionedTransaction ─────────────────
async function assembleOkxTransaction(
  data: OkxSwapInstructionData,
  userWallet: string
): Promise<VersionedTransaction> {
  const connection = getConnection();

  // Convert OKX instruction list to Solana TransactionInstructions
  const instructions: TransactionInstruction[] = data.instructionLists.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.accounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
        data: Buffer.from(ix.data, "base64"),
      })
  );

  // Resolve Address Lookup Tables (ALTs) if provided
  let addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  if (data.addressLookupTableAccount?.length) {
    console.log(
      `[DEBUG] OKX: ${data.addressLookupTableAccount.length} ALT hesabı çözümleniyor...`
    );
    const altResults = await Promise.all(
      data.addressLookupTableAccount.map((addr) =>
        connection.getAddressLookupTable(new PublicKey(addr))
      )
    );
    addressLookupTableAccounts = altResults
      .map((r) => r.value)
      .filter((v): v is AddressLookupTableAccount => v !== null);
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(userWallet),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  return new VersionedTransaction(messageV0);
}

// ── Simulate ────────────────────────────────────────────────────────
export async function simulateOkxTx(
  connection: Parameters<typeof simulateTx>[0],
  tx: VersionedTransaction
): Promise<SimulationOutcome> {
  return simulateTx(connection, tx);
}
