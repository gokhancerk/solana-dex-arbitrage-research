                     ┌──────────────────────────┐
                     │      Market Data         │
                     │  Solana DEX Pools        │
                     │  (Orca / Raydium)        │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │   Quote Measurement      │
                     │                          │
                     │  • Quote sampling        │
                     │  • Edge detection        │
                     │  • Session analysis      │
                     │  • Event logging         │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │   Opportunity Filter     │
                     │                          │
                     │  • Threshold checks      │
                     │  • Edge validation       │
                     │  • Trigger decision      │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │  Simulation Layer        │
                     │                          │
                     │  • simulateTransaction   │
                     │  • Slippage estimation   │
                     │  • Feasibility check     │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │  Atomic Execution Engine │
                     │                          │
                     │  VersionedTransaction    │
                     │  ├─ Orca swap            │
                     │  └─ Raydium swap         │
                     │                          │
                     │  Single TX atomic arb    │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │   Transaction Submit     │
                     │                          │
                     │  Helius RPC              │
                     │  sendSmartTransaction    │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │   Execution Analysis     │
                     │                          │
                     │  • Latency measurement   │
                     │  • Realized PnL          │
                     │  • MEV competition       │
                     │  • Postmortem analysis   │
                     └──────────────────────────┘

# SOLANA ARBITRAGE PROJECT — FINAL VERDICT / POSTMORTEM

## 1. Nihai Karar

VERDICT: HARD KILL (product thesis)
STATUS: Research artifact kept, trading thesis closed

Bu proje:
- kârlı ve sürdürülebilir bir Solana DEX arbitrage ürünü olarak devam ETMEYECEK
- araştırma / execution engineering çıktısı olarak arşivlenecek

---

## 2. Neden Kapatıldı?

Ana neden:
- Sorun artık implementation değil
- Sorun battlefield / market structure

Net olarak doğrulananlar:
- Quote measurement pipeline çalıştı
- Edge detection çalıştı
- Simulation çalıştı
- Dust execution çalıştı
- Atomic execution çalıştı
- Helius landing çalıştı

Buna rağmen:
- realized PnL negatif kaldı
- atomic single-TX execution bile route’u ekonomik olarak kurtarmadı

Sonuç:
- Route matematiksel olarak edge gösterse de
- gerçek execution ortamında edge capture edilemedi
- dolayısıyla ürün tezi başarısız oldu

---

## 3. Kanıtlanan Teknik Bulgular

### 3.1 Measurement
- M3 quote-only pipeline başarıyla çalıştı
- Edge event’leri tespit edildi
- Session/workability ölçümü anlamlı veri üretti

### 3.2 Simulation
- Stage3 / sim katmanı çalıştı
- Execution feasibility kağıt üzerinde pozitif sinyal verdi

### 3.3 Real Execution
- Sequential execution:
  - stale quote problemi
  - ekonomik olarak başarısız

- Jito public bundle:
  - landing zayıf / timeout / rate-limit
  - public route doygunluğu işareti

- Helius send path:
  - landing stabil
  - submit path doğrulandı

- Atomic single-TX execution:
  - inventory riski çözüldü
  - execution modeli doğrulandı
  - buna rağmen median realized negatif kaldı

Kritik bulgu:
- Atomic execution sonrası bile realized bps ≤ 0
- Bu, sorunun artık “execution modeli eksikliği” değil
  “route economics / competition saturation” olduğunu gösterir

---

## 4. Fail Mekanizması

Route:
- Orca ↔ Raydium
- özellikle mSOL / SOL benzeri obvious surface’ler

Fail mekanizması:
- quote-to-execution delay
- MEV / searcher competition
- execution slippage
- public surface saturation

Pratik sonuç:
- quote edge görüldü
- fakat edge execution sırasında alındı / eritildi
- işlem zincire inse bile ekonomi negatif kaldı

Özet:
- problem code bug değil
- problem route’un rekabet altında ekonomik olarak ölmesi

---

## 5. Neden Devam Edilmedi?

Devam edilmedi çünkü:

1. Aynı route üzerinde temel teknik hipotezler test edildi
- sequential
- bundle
- helius send path
- atomic execution

2. En güçlü execution modeli bile net pozitiflik üretmedi
- “belki atomic kurtarır” hipotezi test edildi
- kurtarmadı

3. Yeni denemeler artık düşük kaldıraçlı olurdu
- daha fazla aynı route test etmek
- aynı problemi yeniden görmekten öte değer üretmezdi

4. Kapital büyütmek çözüm değildir
- execution negatifken notional artırmak sadece kaybı büyütür

5. Private relay / paid infra bu aşamada garanti çözüm değildir
- route ekonomisi zaten zayıfsa
- daha iyi infra sadece daha hızlı negatif sonuç üretir

6. New pool / sniper benzeri alanlar farklı ürün hipotezidir
- bu route’un continuation’ı değildir
- yeni proje / yeni hypothesis sayılır

Sonuç:
- mevcut tez yeterince test edildi
- yeni efor aynı product thesis için rasyonel değil

---

## 6. Neden “Soft Kill” Değil “Hard Kill”?

Soft kill değil çünkü:
- execution modeli artık yeterince ileri seviyede test edildi
- atomic TX başarıyla çalıştı
- landing tarafı çalıştı
- buna rağmen ekonomi negatif kaldı

Yani eksik kalan şey:
- küçük bir bug
- ufak bir infra düzeltmesi
- threshold tuning

değil.

Eksik kalan şey:
- bu route’ta gerçek ekonomik edge

Bu yüzden:
- route/product thesis için verdict = HARD KILL

Not:
- Framework / engine için kill yok
- Sadece bu ticari tez için kill var

---

## 7. Projeden Geriye Kalan Değer

Bu proje başarısız bir ürün olabilir ama başarısız bir mühendislik çalışması değildir.

Çıktılar:
- deterministic quote measurement pipeline
- session/workability framework
- execution feasibility test katmanı
- simulation modülü
- dust execution modülü
- atomic single-TX arb execution
- landing / infra test disiplini
- kill-switch ve staged validation yaklaşımı

Bu nedenle proje:
- trading product olarak kapandı
- research / infra artifact olarak değerlidir

---

## 8. Gelecekte Ne Ancak “Yeni Proje” Sayılır?

Aşağıdakiler continuation değil, yeni hypothesis olur:
- farklı surface
- farklı DEX kombinasyonu
- less-contested route
- new pool discovery
- different market microstructure
- CLOB / DLMM / non-obvious route
- private relay ile tamamen yeni edge testi

Yani:
- mevcut route kapandı
- yeni denenecek her şey yeni araştırma başlığıdır

---

## 9. Operasyonel Kapanış

Yapılacaklar:
- repo silinmez
- archive korunur
- final summary yazılır
- çalışan modüller not edilir
- fail nedeni açıkça belgelenir

Arşiv etiketi:
- route1_hard_kill
- atomic_engine_pass_route_fail

---

## 10. Tek Cümlelik Nihai Özet

Bu proje,
“Solana public obvious DEX arbitrage route’u retail-access infra ile kârlı şekilde capture edilebilir mi?”
sorusunu test etti.

Cevap:
HAYIR.

Sebep:
Execution altyapısı sonunda çalışsa bile route ekonomisi rekabet altında negatif kaldı.



# Solana Arbitrage Bot (Backend-Only)

TypeScript (Node 20+) ile Solana mainnet-beta üzerinde çalışan çok katmanlı arbitraj botu. İki bağımsız arbitraj katmanı barındırır. Güvenlik varsayılanları: ≤0.1% slippage cap, yapılandırılabilir notional cap, tam simülasyon, exponential backoff retry ve circuit breaker.

---

## İki Arbitraj Katmanı

Sistemde birbirinden bağımsız çalışabilen **iki farklı arbitraj katmanı** mevcuttur:

### Katman 0 — Aggregator Arbitrage (Jupiter ↔ OKX DEX)

İki farklı DEX aggregator'ı (Jupiter Aggregator ve OKX DEX Aggregator) arasındaki fiyat farklarını kullanır.

| Özellik | Detay |
|---|---|
| **Venue'ler** | Jupiter Aggregator API v6 ↔ OKX DEX Aggregator API v6 |
| **Token çiftleri** | SOL/USDC, WIF/USDC, JUP/USDC, BONK/USDC, WEN/USDC, PYTH/USDC |
| **Yönler** | `JUP_TO_OKX` (Jup'tan al, OKX'te sat) / `OKX_TO_JUP` (OKX'ten al, Jup'ta sat) |
| **Execution** | Jito Bundle (atomik, 2-leg aynı blokta) veya Sequential (Leg1→confirm→buildFreshLeg2→Leg2) |
| **Tetikleme** | Slot-tabanlı event-driven (Helius WebSocket → PriceTicker), round-robin multi-token |
| **Notional** | Yapılandırılabilir ($1–$1000 USDC aralığı) |
| **Durum** | **Live — aktif çalışıyor** (dry-run/live modlar ile) |

**Akış:**
```
USDC → <token> (Venue A) → <token> → USDC (Venue B) → Net kâr = fark − fee
```

### Katman 1 — Cross-DEX Pool Arbitrage (Orca Whirlpool ↔ Raydium CPMM)

Aynı token/USDC çifti için Orca Whirlpool (CLMM) ve Raydium CPMM havuzları arasındaki doğrudan fiyat farkını kullanır. Model/TVL tahmini yerine **gerçek quote çıktılarına** dayanır.

| Özellik | Detay |
|---|---|
| **Venue'ler** | Orca Whirlpools (CLMM, Jupiter `dexes=Whirlpool` kısıtlı) ↔ Raydium CPMM (on-chain reserve + constant-product) |
| **Token çiftleri** | Orca+Raydium'da eşleşen tüm USDC havuzları (~20 çift whitelist) |
| **Yönler** | `O_TO_R` (Orca'dan al, Raydium'da sat) / `R_TO_O` (Raydium'dan al, Orca'da sat) |
| **Notional bantları** | Micro: $30–$100 / Scale: $1k–$3k |
| **Tetikleme** | Quote-only watch döngüsü (1s poll, yapılandırılabilir süre) |
| **Durum** | **Research/Observation** — M3 quote-only watch + event detection aktif, execution henüz bağlanmadı |

**Pipeline:**
```
1. Pool Discovery (discoverOrcaPools + discoverRaydiumCpmmPools)
2. Pool Matching (matchRoute1Pools — baseMint eşleştirme)
3. Arb Scoring (scoreRoute1Arb — deterministic edge hesaplama)
4. Live Watch (arbWatch — gerçek zamanlı quote izleme + event detection)
5. [Bekliyor] Execution bağlantısı (Katman 0 altyapısı kullanılacak)
```

### Katman Karşılaştırması

| | Katman 0 (Aggregator) | Katman 1 (Cross-DEX Pool) |
|---|---|---|
| Veri kaynağı | Aggregator REST API quote | Gerçek on-chain reserve / DEX-native quote |
| Execution risk | MEV, arada fiyat kayması | Aynı + havuz likiditesi yetersizliği |
| Atomik execution | Jito bundle destekli | Henüz yok (planlanan) |
| Latency profili | ~600ms (API cooldown dahil) | ~1s (poll-based, optimize edilebilir) |
| Canlı trade | ✅ Evet | ❌ Henüz değil — observation modunda |

---

## Yol Haritası: Live Micro


Planlanan geçiş:
1. **Micro validation:** Katman 1'de $30–$100 bandında düşük riskli canlı trade'ler, winrate ve net PnL metriklerinin toplanması
2. **Execution entegrasyonu:** Katman 0'ın Jito/sequential altyapısının Katman 1'e bağlanması
3. **Scale-up:** Katman 1 scale bandına ($1k–$3k) geçiş, yeni DEX/havuz entegrasyonları

Micro pass'in başarı kriterleri: pozitif winrate (>%55), tutarlı net kâr, kabul edilebilir slippage drift (<5 bps).

---

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
   USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   OKX_BASE_URL=https://www.okx.com
   OKX_API_KEY=...
   OKX_API_SECRET=...
   OKX_API_PASSPHRASE=...
   OKX_API_PROJECT=...
   WALLET_KEYPATH=/absolute/path/to/your/encrypted-keypair.json
   MIN_NET_PROFIT_USDC=0.12
   SOL_USDC_RATE=150
   SCAN_TOKENS=SOL,WIF,JUP
   DRY_RUN=true
   ```

## Key Modules

### Katman 0 (Aggregator Arb)
- [src/config.ts](src/config.ts): env-driven config (RPCs, slippage, limits, OKX creds, token mints/decimals).
- [src/jupiter.ts](src/jupiter.ts): Jupiter quotes + swap transaction builder with ALT support and simulation helper.
- [src/okxDex.ts](src/okxDex.ts): OKX DEX quotes + swap transaction builder (uses Wallet/Dex API advanced control) with simulation helper.
- [src/execution.ts](src/execution.ts): orchestrates `buildAndSimulate` for both directions and `sendWithRetry` with backoff + circuit breaker.
- [src/jito.ts](src/jito.ts): Jito Block Engine integration — atomic 2-leg bundles, tip yönetimi, rate-limit cooldown.
- [src/telemetry.ts](src/telemetry.ts): produce structured telemetry objects for downstream analytics.
- [src/wallet.ts](src/wallet.ts): load keypairs from `WALLET_KEYPATH` (JSON array preferred).
- [src/fees.ts](src/fees.ts): fetch recent priority fee suggestion (dynamic median + cap).
- [src/stream/slotDriver.ts](src/stream/slotDriver.ts): Helius WebSocket slot subscription for event-driven triggers.
- [src/stream/priceTicker.ts](src/stream/priceTicker.ts): slot-based event-driven trade loop — round-robin multi-token, bi-directional parallel scan.

### Katman 1 (Cross-DEX Pool Arb)
- [src/scripts/discoverOrcaPools.ts](src/scripts/discoverOrcaPools.ts): Orca Whirlpool havuz keşfi ve skorlama.
- [src/scripts/discoverRaydiumCpmmPools.ts](src/scripts/discoverRaydiumCpmmPools.ts): Raydium CPMM havuz keşfi.
- [src/scripts/matchRoute1Pools.ts](src/scripts/matchRoute1Pools.ts): Orca+Raydium havuzlarını baseMint üzerinden eşleştirme.
- [src/scripts/scoreRoute1Arb.ts](src/scripts/scoreRoute1Arb.ts): Deterministic arb edge hesaplama (micro/scale whitelist üretimi).
- [src/scripts/arbWatch.ts](src/scripts/arbWatch.ts): M3 gerçek zamanlı quote-only watch — event detection, JSONL telemetri.
- [src/scripts/m3Health.ts](src/scripts/m3Health.ts): M3 sağlık kontrolü (10-dakika health run).

## Usage (Katman 0)

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

```ts
import { PriceTicker } from "./src/stream/priceTicker.js";

// every 2 slots (~0.8s) run bi-directional quote scan (JUP↔OKX) and execute the best route
new PriceTicker({ slotsPerCheck: 2 }).start();
```
Set `SOLANA_WS_PRIMARY` / `SOLANA_WS_BACKUP` (Helius URLs) in `.env`. The ticker automatically scans both JUP→OKX and OKX→JUP directions in parallel and picks the most profitable route.

## Usage (Katman 1 — Observation Pipeline)

```bash
# 1. Havuz keşfi
npx tsx src/scripts/discoverOrcaPools.ts
npx tsx src/scripts/discoverRaydiumCpmmPools.ts

# 2. Havuz eşleştirme
npx tsx src/scripts/matchRoute1Pools.ts

# 3. Deterministic scoring
npm run score:arb

# 4. Gerçek zamanlı quote izleme (60 dk varsayılan)
npm run m3:watch
npm run m3:watch:6h     # 6 saat
npm run m3:watch:24h    # 24 saat
```

Output: `data/arb_watch_*.jsonl` (sample telemetri), `data/arb_events.jsonl` (event detection).

## Telemetry Shape

```ts
// Katman 0 — Aggregator Arb
{
  pair: "SOL/USDC",
  direction: "JUP_TO_OKX" | "OKX_TO_JUP",
  simulatedAmountOut: string,
  realizedAmountOut?: string,
  effectiveSlippageBps?: number,
  success: boolean,
  failReason?: string,
  txSignatures: string[],
  timestamp: string,
  retries: number,
  profitLabel: "profit" | "loss" | "flat",
  netProfitUsdc: number,
  status: TelemetryStatus,
  realizedPnl?: RealizedPnlInfo,
  latencyMetrics?: LatencyMetrics,
  jitoBundleTelemetry?: JitoBundleTelemetry
}

// Katman 1 — Cross-DEX Pool Watch
{
  ts: number,
  tickId: number,
  pairId: string,
  baseMint: string,
  baseSymbol: string,
  notional: number,
  direction: "O_TO_R" | "R_TO_O",
  netProfitBps: number,
  netProfitUsdc: number,
  quoteOrca: { inUsdc: number, outTokenRaw: bigint },
  quoteRaydium: { inTokenRaw: bigint, outUsdc: number }
}
```

## Safety Checklist

- Slippage cap ≤0.1% (10 bps) — aşıldığında trade iptal edilir.
- Notional cap yapılandırılabilir (varsayılan 1000 USDC).
- Net Profit Gate: brüt kâr − tahmini fee ≥ eşik × 1.5 buffer (live mod).
- Simulate every swap; abort on sim error or slippage breach.
- Circuit breaker: 3 ardışık başarısız gönderimde `SendError` fırlatılır.
- Emergency Unwind: Leg2 başarısız → takılı token'ı USDC'ye çevir (5 retry).
- Prefer ALTs and set priority fees via `DYNAMIC_PRIORITY_FEE=true` + `MAX_PRIORITY_FEE`.
- Jito atomic bundles for MEV protection (optional, `USE_JITO_BUNDLE=true`).
- Store wallet keys in an encrypted file referenced by `WALLET_KEYPATH`; avoid keeping raw keys in `.env`.

## Sources

[Understanding Slots, Blocks, and Epochs on Solana](https://www.helius.dev/blog/solana-slots-blocks-and-epochs)
