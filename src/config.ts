export interface RpcConfig {
  primary: string;
  backup?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  priorityFeeMicrolamports?: number;
  wsPrimary?: string;
  wsBackup?: string;
}

export interface TokenConfig {
  symbol: "USDC" | "SOL";
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
}

export const DEFAULT_SLIPPAGE_BPS = 20; // 0.2%
export const DEFAULT_NOTIONAL_CAP = 1000; // USD stable notional
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_CIRCUIT_BREAKER = 3;
export const DEFAULT_MIN_NET_PROFIT_USDC = 0.05; // 5 cents
export const DEFAULT_SOL_USDC_RATE = 150; // conservative fallback
export const DEFAULT_API_COOLDOWN_MS = 2000; // 2 seconds between API calls

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
  const solMint = process.env.SOL_MINT ?? "So11111111111111111111111111111111111111112";
  const usdcMint = requireEnv("USDC_MINT") as string; // e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

  const tokens: Record<string, TokenConfig> = {
    SOL: { symbol: "SOL", mint: solMint, decimals: Number(process.env.SOL_DECIMALS ?? 9) },
    USDC: { symbol: "USDC", mint: usdcMint, decimals: Number(process.env.USDC_DECIMALS ?? 6) }
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
    tokens
  };
}
