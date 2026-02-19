export interface RpcConfig {
  primary: string;
  backup?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  priorityFeeMicrolamports?: number;
  wsPrimary?: string;
  wsBackup?: string;
}

/** Taranabilir tüm token sembolleri */
export type TokenSymbol = "WIF" | "JUP" | "SOL" | "BONK" | "WEN" | "PYTH";

/** Desteklenen tüm trade çiftleri */
export type TradePair = "WIF/USDC" | "JUP/USDC" | "SOL/USDC" | "BONK/USDC" | "WEN/USDC" | "PYTH/USDC";

/** Round-Robin sırasına göre taranacak target tokenlar */
export const SCANNABLE_TOKENS: readonly TokenSymbol[] = ["WIF", "JUP", "SOL", "BONK", "WEN", "PYTH"] as const;

export interface TokenConfig {
  symbol: "USDC" | TokenSymbol;
  mint: string;
  decimals: number;
}

export interface AppConfig {
  rpc: RpcConfig;
  okxBaseUrl: string;
  okxProjectId?: string;
  okxApiKey?: string;
  okxApiSecret?: string;
  okxApiPassphrase?: string;
  jupiterApiKey?: string;
  slippageBps: number;
  notionalCapUsd: number;
  maxRetries: number;
  circuitBreakerThreshold: number;
  tokens: Record<string, TokenConfig>;
  /** Minimum net profit (USDC) after fees to proceed with a trade */
  minNetProfitUsdc: number;
  /** Estimated SOL/USDC rate used to convert on-chain fees to USDC */
  solUsdcRate: number;
  /** Minimum milliseconds between consecutive API quote requests (throttle) */
  apiCooldownMs: number;
  /** Minimum milliseconds between consecutive trade executions (cooldown) */
  tradeCooldownMs: number;
  /** Taranacak token listesi (round-robin) */
  scanTokens: readonly TokenSymbol[];
  /** Dinamik priority fee aktif mi */
  dynamicPriorityFee: boolean;
  /** Dinamik fee üst sınırı (micro-lamports) */
  maxPriorityFee: number;
  /** Jito Bundle kullanılsın mı? Env: USE_JITO_BUNDLE=true */
  useJitoBundle: boolean;
  /** Jito Block Engine URL (birincil). Env: JITO_BLOCK_ENGINE_URL */
  jitoBlockEngineUrl: string;
  /** Jito Block Engine URL listesi (round-robin failover). Env: JITO_BLOCK_ENGINE_URLS */
  jitoBlockEngineUrls: string[];
  /** Jito tip miktarı (lamports). Env: JITO_TIP_LAMPORTS */
  jitoTipLamports: number;
  /** Dry-run modu: TX gönderilmez, sadece quote + simulate yapılır. Env: DRY_RUN=true */
  dryRun: boolean;
}

export const DEFAULT_SLIPPAGE_BPS = 10; // 0.1%
export const DEFAULT_NOTIONAL_CAP = 1000; // USD stable notional
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_CIRCUIT_BREAKER = 3;
export const DEFAULT_MIN_NET_PROFIT_USDC = 0.12; // 12 cents — 2-leg slippage tamponu
export const DEFAULT_SOL_USDC_RATE = 150; // conservative fallback
export const DEFAULT_API_COOLDOWN_MS = 600; // 600ms — OKX rate-limit'in altında
export const DEFAULT_TRADE_COOLDOWN_MS = 2000; // 2 seconds between trades
/** Varsayılan: yalnızca en likit 3 token. Env ile override: SCAN_TOKENS=SOL,WIF,JUP */
export const DEFAULT_SCAN_TOKENS: readonly TokenSymbol[] = ["SOL", "WIF", "JUP"] as const;
/** Dinamik priority fee kullanılsın mı? Env: DYNAMIC_PRIORITY_FEE=true */
export const DEFAULT_DYNAMIC_PRIORITY_FEE = true;
/** Dinamik fee cap — aşırı fee ödemeyi engeller (micro-lamports) */
export const DEFAULT_MAX_PRIORITY_FEE = 100_000;
/** Jito Bundle varsayılan olarak kapalı — env: USE_JITO_BUNDLE=true */
export const DEFAULT_USE_JITO_BUNDLE = false;
/** Jito Block Engine varsayılan URL */
export const DEFAULT_JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf";
/** Jito tip varsayılan: 10,000 lamports (0.00001 SOL) */
export const DEFAULT_JITO_TIP_LAMPORTS = 10_000;
/** Dry-run modu varsayılan: aktif — mainnet gönderim kapalı */
export const DEFAULT_DRY_RUN = true;

function requireEnv(name: string, optional = false): string | undefined {
  const v = process.env[name];
  if (!v && !optional) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

export function loadConfig(): AppConfig {
  const heliusKey = process.env.HELIUS_API_KEY;
  const heliusHttp = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : undefined;
  const heliusWs = heliusKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : undefined;

  const rpcPrimary = ((process.env.SOLANA_RPC_PRIMARY as string) || heliusHttp || requireEnv("SOLANA_RPC_PRIMARY")) as string;
  const rpcBackup = (process.env.SOLANA_RPC_BACKUP || heliusHttp) as string | undefined;

  // Token mints must align across venues; provide via env for explicitness.
  const usdcMint = requireEnv("USDC_MINT") as string; // e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  const wifMint  = process.env.WIF_MINT  ?? "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
  const jupMint  = process.env.JUP_MINT  ?? "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const solMint  = process.env.SOL_MINT  ?? "So11111111111111111111111111111111111111112";
  const bonkMint = process.env.BONK_MINT ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const wenMint  = process.env.WEN_MINT  ?? "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk";
  const pythMint = process.env.PYTH_MINT ?? "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3";

  const tokens: Record<string, TokenConfig> = {
    WIF:  { symbol: "WIF",  mint: wifMint,  decimals: Number(process.env.WIF_DECIMALS  ?? 6) },
    JUP:  { symbol: "JUP",  mint: jupMint,  decimals: Number(process.env.JUP_DECIMALS  ?? 6) },
    SOL:  { symbol: "SOL",  mint: solMint,  decimals: Number(process.env.SOL_DECIMALS  ?? 9) },
    BONK: { symbol: "BONK", mint: bonkMint, decimals: Number(process.env.BONK_DECIMALS ?? 5) },
    WEN:  { symbol: "WEN",  mint: wenMint,  decimals: Number(process.env.WEN_DECIMALS  ?? 5) },
    PYTH: { symbol: "PYTH", mint: pythMint, decimals: Number(process.env.PYTH_DECIMALS ?? 6) },
    USDC: { symbol: "USDC", mint: usdcMint, decimals: Number(process.env.USDC_DECIMALS ?? 6) },
  };

  return {
    rpc: {
      primary: rpcPrimary,
      backup: rpcBackup,
      wsPrimary: process.env.SOLANA_WS_PRIMARY || heliusWs,
      wsBackup: process.env.SOLANA_WS_BACKUP || heliusWs,
      commitment: (process.env.SOLANA_COMMITMENT as RpcConfig["commitment"]) ?? "confirmed",
      priorityFeeMicrolamports: process.env.PRIORITY_FEE_MICROLAMPORTS
        ? Number(process.env.PRIORITY_FEE_MICROLAMPORTS)
        : undefined
    },
    okxBaseUrl: process.env.OKX_BASE_URL ?? "https://www.okx.com",
    okxProjectId: process.env.OKX_API_PROJECT,
    okxApiKey: process.env.OKX_API_KEY,
    okxApiSecret: process.env.OKX_API_SECRET,
    okxApiPassphrase: process.env.OKX_API_PASSPHRASE,
    jupiterApiKey: process.env.JUPITER_API_KEY,
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? DEFAULT_SLIPPAGE_BPS),
    notionalCapUsd: Number(process.env.NOTIONAL_CAP_USD ?? DEFAULT_NOTIONAL_CAP),
    maxRetries: Number(process.env.MAX_RETRIES ?? DEFAULT_MAX_RETRIES),
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD ?? DEFAULT_CIRCUIT_BREAKER),
    minNetProfitUsdc: Number(process.env.MIN_NET_PROFIT_USDC ?? DEFAULT_MIN_NET_PROFIT_USDC),
    solUsdcRate: Number(process.env.SOL_USDC_RATE ?? DEFAULT_SOL_USDC_RATE),
    apiCooldownMs: Number(process.env.API_COOLDOWN_MS ?? DEFAULT_API_COOLDOWN_MS),
    tradeCooldownMs: Number(process.env.TRADE_COOLDOWN_MS ?? DEFAULT_TRADE_COOLDOWN_MS),
    scanTokens: process.env.SCAN_TOKENS
      ? (process.env.SCAN_TOKENS.split(",").map(s => s.trim()) as TokenSymbol[])
      : DEFAULT_SCAN_TOKENS,
    dynamicPriorityFee: (process.env.DYNAMIC_PRIORITY_FEE ?? "true") === "true",
    maxPriorityFee: Number(process.env.MAX_PRIORITY_FEE ?? DEFAULT_MAX_PRIORITY_FEE),
    useJitoBundle: (process.env.USE_JITO_BUNDLE ?? "false") === "true",
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL ?? DEFAULT_JITO_BLOCK_ENGINE_URL,
    jitoBlockEngineUrls: process.env.JITO_BLOCK_ENGINE_URLS
      ? process.env.JITO_BLOCK_ENGINE_URLS.split(",").map(s => s.trim()).filter(Boolean)
      : [
          process.env.JITO_BLOCK_ENGINE_URL ?? DEFAULT_JITO_BLOCK_ENGINE_URL,
          "https://amsterdam.mainnet.block-engine.jito.wtf",
          "https://frankfurt.mainnet.block-engine.jito.wtf",
          "https://ny.mainnet.block-engine.jito.wtf",
          "https://tokyo.mainnet.block-engine.jito.wtf",
        ],
    jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? DEFAULT_JITO_TIP_LAMPORTS),
    dryRun: (process.env.DRY_RUN ?? String(DEFAULT_DRY_RUN)) === "true",
    tokens
  };
}
