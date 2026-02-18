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

// ── OKX Rate Limiter ────────────────────────────────────────────────
/** Ardışık OKX API çağrıları arasında minimum bekleme süresi (ms) */
const OKX_MIN_CALL_SPACING_MS = 1200;
/** 429 hatası alındığında max retry sayısı */
const OKX_429_MAX_RETRIES = 2;
/** 429 retry backoff base (ms) — exponential: base * 2^(attempt-1) */
const OKX_429_BACKOFF_BASE_MS = 2000;

/** Son OKX API çağrısının TAMAMLANMA timestamp'i */
let lastOkxCallTimestamp = 0;

/**
 * Tam seri OKX kuyruğu — throttle + HTTP isteğinin tamamını kapsar.
 * Bir önceki OKX çağrısı (fetch dahil) bitmeden sonraki BAŞLAMAZ.
 * Promise.all() ile paralel çağrılsa bile istekler %100 sıralı gider.
 */
let _okxQueueTail: Promise<void> = Promise.resolve();

function enqueueOkxCall<T>(fn: () => Promise<T>): Promise<T> {
  const job = _okxQueueTail.then(async () => {
    // Önceki çağrının TAMAMLANMASINDAN bu yana geçen süreyi kontrol et
    const now = Date.now();
    const elapsed = now - lastOkxCallTimestamp;
    if (elapsed < OKX_MIN_CALL_SPACING_MS) {
      const waitMs = OKX_MIN_CALL_SPACING_MS - elapsed;
      console.log(`[OKX-RATE] ${waitMs}ms bekleniyor (spacing koruması)…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    // İsteğin kendisini çalıştır (fetch dahil)
    const result = await fn();
    // Timestamp'i çağrı TAMAMLANDIKTAN sonra güncelle
    lastOkxCallTimestamp = Date.now();
    return result;
  });
  // Kuyruk zincirini güncelle (hata olursa bile sonraki çağrılar devam etsin)
  _okxQueueTail = job.then(() => {}, () => { lastOkxCallTimestamp = Date.now(); });
  return job;
}

/**
 * 429 "Too Many Requests" hatasına karşı retry + exponential backoff.
 * Yalnızca 429 HTTP status'unda tekrar dener, diğer hatalarda doğrudan throw eder.
 */
async function fetchWithOkx429Retry(
  url: string,
  headers: Record<string, string>,
  label: string
): Promise<Response> {
  for (let attempt = 0; attempt <= OKX_429_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = OKX_429_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[OKX-RETRY] ${label} — 429 retry ${attempt}/${OKX_429_MAX_RETRIES}, ` +
        `${backoffMs}ms backoff bekleniyor…`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      // Retry öncesi yeni HMAC timestamp gerekli olabilir, ancak
      // kısa backoff süreleri OKX timestamp tolerance (30s) içinde kalır.
      lastOkxCallTimestamp = Date.now();
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(OKX_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `OKX ${label} fetch failed (timeout=${OKX_FETCH_TIMEOUT_MS}ms): ${reason}`
      );
    }

    if (res.status === 429) {
      const bodyText = await res.text().catch(() => "");
      console.warn(
        `[OKX-RATE] ${label} HTTP 429 alındı (attempt ${attempt + 1}/${OKX_429_MAX_RETRIES + 1}): ${bodyText}`
      );
      if (attempt === OKX_429_MAX_RETRIES) {
        throw new Error(
          `OKX ${label} rate-limited: 429 Too Many Requests — ` +
          `${OKX_429_MAX_RETRIES + 1} deneme sonrası başarısız`
        );
      }
      continue; // retry
    }

    return res;
  }

  // TypeScript exhaustiveness — buraya ulaşılmamalı
  throw new Error(`OKX ${label}: unexpected retry loop exit`);
}

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
  /** Override priority fee (micro-lamports). Dynamic fee from fees.ts */
  priorityFeeMicroLamports?: number;
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
  return enqueueOkxCall(async () => {
    const cfg = loadConfig();

    const slippagePercent = (params.slippageBps / 100).toString();

    const qs = new URLSearchParams({
      chainIndex: "501",
      fromTokenAddress: params.inputMint,
      toTokenAddress: params.outputMint,
      amount: params.amount.toString(),
      slippagePercent,
    });

    const requestPath = `${OKX_QUOTE_PATH}?${qs.toString()}`;
    const fullUrl = `${cfg.okxBaseUrl}${requestPath}`;

    const headers = buildOkxHeaders("GET", requestPath);
    const res = await fetchWithOkx429Retry(fullUrl, headers, "quote");

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(body okunamadı)");
      throw new Error(`OKX quote failed: ${res.status} ${res.statusText} — ${bodyText}`);
    }

    const json = (await res.json()) as OkxQuoteResponse;
    if (json.code !== "0" || !json.data?.length) {
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
  });
}

// ── Swap Instruction (Solana-specific) ──────────────────────────────
export interface OkxSwapResult {
  tx: VersionedTransaction;
  meta: QuoteMeta;
}

export async function buildOkxSwap(
  params: OkxSwapParams
): Promise<OkxSwapResult> {
  return enqueueOkxCall(async () => {
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

    // Optional: priority fee (dynamic öncelikli, config fallback)
    const effectiveFee = params.priorityFeeMicroLamports ?? cfg.rpc.priorityFeeMicrolamports;
    if (effectiveFee != null) {
      qsParams.computeUnitPrice = effectiveFee.toString();
    }

    const qs = new URLSearchParams(qsParams);
    const requestPath = `${OKX_SWAP_INSTRUCTION_PATH}?${qs.toString()}`;
    const fullUrl = `${cfg.okxBaseUrl}${requestPath}`;

    const headers = buildOkxHeaders("GET", requestPath);

    // 429 retry mekanizmalı fetch
    const res = await fetchWithOkx429Retry(fullUrl, headers, "swap-instruction");

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
    const tx = await assembleOkxTransaction(json.data, params.userPublicKey);

    // Extract QuoteMeta from swap-instruction routerResult (ayrı quote isteği gereksiz)
    const routerResult = json.data.routerResult;
    const meta: QuoteMeta = {
      venue: "OKX",
      inMint: params.inputMint,
      outMint: params.outputMint,
      inAmount: params.amount,
      expectedOut: BigInt(routerResult.toTokenAmount),
      slippageBps: params.slippageBps,
      routeContext: routerResult.dexRouterList,
    };

    return { tx, meta };
  });
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
