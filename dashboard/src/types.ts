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
}

export interface HourlyBucket {
  hour: string;
  grossSpread: number;
  netSpread: number;
  count: number;
}
