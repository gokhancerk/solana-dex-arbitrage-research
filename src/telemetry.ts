import { BuildSimulateResult, Telemetry } from "./types.js";

export function buildTelemetry(
  build: BuildSimulateResult,
  sendSignatures: string[],
  realizedOut?: bigint
): Telemetry {
  const lastLeg = build.legs.at(-1);
  const expectedOut = lastLeg?.expectedOut ?? BigInt(0);
  const simulatedOut = lastLeg?.simulatedOut ?? expectedOut;
  const effectiveSlippageBps = lastLeg?.effectiveSlippageBps;

  const realizedStr = realizedOut ? realizedOut.toString() : undefined;
  const simulatedStr = simulatedOut.toString();

  let profitLabel: Telemetry["profitLabel"] = "flat";
  if (realizedOut && realizedOut > expectedOut) profitLabel = "profit";
  if (realizedOut && realizedOut < expectedOut) profitLabel = "loss";

  return {
    pair: "SOL/USDC",
    direction: build.direction,
    simulatedAmountOut: simulatedStr,
    realizedAmountOut: realizedStr,
    effectiveSlippageBps,
    success: true,
    failReason: undefined,
    txSignatures: sendSignatures,
    timestamp: new Date().toISOString(),
    retries: sendSignatures.length > 0 ? sendSignatures.length - 1 : 0,
    profitLabel
  };
}
