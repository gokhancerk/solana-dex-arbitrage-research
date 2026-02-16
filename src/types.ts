import type { VersionedTransaction } from "@solana/web3.js";

export type Direction = "JUP_TO_OKX" | "OKX_TO_JUP";

/*
 * JUP_TO_OKX  = Leg1: Jupiter USDC→SOL, Leg2: OKX SOL→USDC
 * OKX_TO_JUP  = Leg1: OKX USDC→SOL,     Leg2: Jupiter SOL→USDC
 */

export interface QuoteMeta {
  venue: "JUPITER" | "OKX";
  inMint: string;
  outMint: string;
  inAmount: bigint; // raw units
  expectedOut: bigint; // raw units
  slippageBps: number;
  routeContext?: unknown; // opaque route or path data for reuse
}

export interface SimulationOutcome {
  logs: string[];
  unitsConsumed?: number;
  error?: string;
  accountsLoaded?: number;
  postBalances?: bigint[];
  postTokenBalances?: Array<{
    mint: string;
    owner: string;
    rawAmount: string;
    uiAmount?: string;
    decimals?: number;
  }>;
}

export interface SimulatedLeg {
  venue: "JUPITER" | "OKX";
  tx: VersionedTransaction;
  outMint?: string;
  owner?: string;
  simulatedOut?: bigint;
  expectedOut: bigint;
  effectiveSlippageBps?: number;
  simulation: SimulationOutcome;
}

export interface BuildSimulateResult {
  direction: Direction;
  legs: SimulatedLeg[];
  quoteMeta: QuoteMeta[];
}

export interface SendAttempt {
  signature?: string;
  error?: string;
  attempt: number;
  backoffMs: number;
  timestamp: string;
}

export interface SendResult {
  success: boolean;
  finalSignature?: string;
  attempts: SendAttempt[];
  failReason?: string;
}

export interface Telemetry {
  pair: "SOL/USDC";
  direction: Direction;
  simulatedAmountOut: string;
  realizedAmountOut?: string;
  effectiveSlippageBps?: number;
  success: boolean;
  failReason?: string;
  txSignatures: string[];
  timestamp: string;
  retries: number;
  profitLabel: "profit" | "loss" | "flat";
}

export class LimitBreachError extends Error {}
export class QuoteError extends Error {}
export class SlippageError extends Error {}
export class SimulationError extends Error {}
export class SendError extends Error {}
