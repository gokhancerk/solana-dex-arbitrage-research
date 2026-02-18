export interface TradeLog {
  pair: string;
  direction: string;
  simulatedAmountOut: string;
  success: boolean;
  failReason: string;
  txSignatures: string[];
  timestamp: string;
  retries: number;
  profitLabel: "profit" | "loss" | "flat";
  netProfitUsdc: number;
  grossProfitUsdc: number;
  feeUsdc: number;
  status: string;
  /** On-chain gerçek bakiye deltasına dayalı kâr/zarar (varsa) */
  realizedPnl?: {
    deltaUsdc: number;
    deltaSol: number;
    solCostUsdc: number;
    realizedNetProfitUsdc: number;
    solUsdcRate: number;
    preUsdcRaw: string;
    postUsdcRaw: string;
    preSolLamports: string;
    postSolLamports: string;
  };
}

export interface HourlyBucket {
  hour: string;
  grossSpread: number;
  netSpread: number;
  count: number;
}
