# Solana ↔ OKX DEX Arbitrage (Backend-Only)

TypeScript (Node 18) scaffolding for JUP/USDT arbitrage across Jupiter and OKX DEX on Solana mainnet-beta. Safety defaults: 0.2% slippage cap, ≤200 USDT notional, full simulation before send, retries with exponential backoff, and circuit breaker after three failed sends.

## Setup

1. Install deps: `npm install`
2. Create `.env` with required values (examples):
   ```env
  HELIUS_API_KEY=your_helius_key
  SOLANA_RPC_PRIMARY=https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
  SOLANA_RPC_BACKUP=https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
  SOLANA_WS_PRIMARY=wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
  SOLANA_WS_BACKUP=wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}
   SOLANA_COMMITMENT=confirmed
   PRIORITY_FEE_MICROLAMPORTS=10000
   USDT_MINT=Es9vMFrzaCERWf9qgX9NybmMtXJgpNNLeebv12qVDZr
   USDT_DECIMALS=6
   JUP_MINT=<official JUP mint>
   JUP_DECIMALS=6
   OKX_BASE_URL=https://www.okx.com
   OKX_API_KEY=...
   OKX_API_SECRET=...
   OKX_API_PASSPHRASE=...
   OKX_API_PROJECT=...
  WALLET_KEYPATH=/absolute/path/to/your/encrypted-keypair.json
  # Net profit gate (USDC). Trades with net profit below this are skipped.
  MIN_NET_PROFIT_USDC=0.05
  # Estimated SOL/USDC rate for fee conversion (safe fallback)
  SOL_USDC_RATE=150
  # Optional: dry-run helpers
  DIRECTION=JUP_TO_OKX
  NOTIONAL_USD=50
   ```

## Key Modules

- [src/config.ts](src/config.ts): env-driven config (RPCs, slippage, limits, OKX creds, token mints/decimals).
- [src/jupiter.ts](src/jupiter.ts): Jupiter quotes + swap transaction builder with ALT support and simulation helper.
- [src/okxDex.ts](src/okxDex.ts): OKX DEX quotes + swap transaction builder (uses Wallet/Dex API advanced control) with simulation helper.
- [src/execution.ts](src/execution.ts): orchestrates `buildAndSimulate` for both directions and `sendWithRetry` with backoff + circuit breaker.
- [src/telemetry.ts](src/telemetry.ts): produce structured telemetry objects for downstream analytics.
- [src/wallet.ts](src/wallet.ts): load keypairs from `WALLET_KEYPATH` (JSON array preferred).
- [src/fees.ts](src/fees.ts): fetch recent priority fee suggestion.
- [src/stream/slotDriver.ts](src/stream/slotDriver.ts): Helius WebSocket slot subscription for event-driven triggers.
- [src/stream/priceTicker.ts](src/stream/priceTicker.ts): sample event-driven loop that builds+sims every N slots instead of polling.

## Usage

```ts
import { buildAndSimulate, sendWithRetry } from "./src/execution.js";
import { buildTelemetry } from "./src/telemetry.js";
import { Direction } from "./src/types.js";
import { getKeypairFromEnv } from "./src/wallet.js";

async function run(direction: Direction, notionalUsd: number) {
  const owner = getKeypairFromEnv();

  const build = await buildAndSimulate({ direction, notionalUsd, owner: owner.publicKey });

  // Send legs sequentially; stop on first failure.
  const signatures: string[] = [];
  for (const leg of build.legs) {
    const send = await sendWithRetry(leg.tx, owner);
    signatures.push(send.finalSignature!);
  }

  const telemetry = buildTelemetry(build, signatures);
  console.log(JSON.stringify(telemetry));
}

run("JUP_TO_OKX", 50).catch(console.error);
```

### Dry-run (simulate only)

Populate env (including `WALLET_KEYPATH`, `DIRECTION`, `NOTIONAL_USD`) then run:

```
npm run dry-run
```
This builds both legs for the chosen direction, simulates, and prints expected vs simulated out amounts and slippage. No transactions are sent.

### Event-driven trigger (Helius WebSocket)

Instead of polling quotes, hook into Solana slots via Helius WebSocket and trigger sims on a cadence:

```
import { PriceTicker } from "./src/stream/priceTicker.js";

// every 4 slots (~2s) run bi-directional quote scan (JUP↔OKX) and execute the best route
new PriceTicker({ slotsPerCheck: 4 }).start();
```
Set `SOLANA_WS_PRIMARY` / `SOLANA_WS_BACKUP` (Helius URLs) in `.env`. The ticker automatically scans both JUP→OKX and OKX→JUP directions in parallel and picks the most profitable route.

## Telemetry Shape

```ts
{
  pair: "JUP/USDT",
  direction: "JUP_TO_OKX" | "OKX_TO_JUP",
  simulatedAmountOut: string,        // raw units
  realizedAmountOut?: string,
  effectiveSlippageBps?: number,
  success: boolean,
  failReason?: string,
  txSignatures: string[],
  timestamp: string,
  retries: number,
  profitLabel: "profit" | "loss" | "flat"
}
```

## Safety Checklist

- Keep notional ≤200 USDT and slippage ≤0.2%.
- Require all OKX creds before sending mainnet transactions.
- Simulate every swap; abort on sim error or slippage breach.
- Watch the circuit breaker (3 failed sends) before retrying.
- Prefer ALTs and set priority fees via `PRIORITY_FEE_MICROLAMPORTS`.
- Store wallet keys in an encrypted file referenced by `WALLET_KEYPATH`; avoid keeping raw keys in `.env`.
