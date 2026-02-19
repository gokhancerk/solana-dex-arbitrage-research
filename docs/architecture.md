# Mimari Genel Bakış

## Sistem Amacı

Jupiter (jup.ag) ve OKX DEX arasında **çoklu token / USDC** paritelerinde fiyat farklarından kâr elde eden bir arbitraj botu. Solana mainnet-beta üzerinde çalışır. React tabanlı bir monitoring dashboard'u ve Express API sunucusu içerir. Tüm bileşenler tek bir port (3001) üzerinden sunulur.

Desteklenen token çiftleri: **SOL/USDC, WIF/USDC, JUP/USDC, BONK/USDC, WEN/USDC, PYTH/USDC**

## Üst Düzey Akış

```
┌──────────────┐     ┌────────────────────┐     ┌───────────────┐
│  Jupiter API │◄───►│                    │◄───►│   OKX DEX API │
│  (quote/swap)│     │    Orchestrator    │     │  (quote/swap) │
└──────────────┘     │   (execution.ts)   │     └───────────────┘
                     │                    │
                     │  ┌──────────────┐  │
                     │  │   Wallet     │  │
                     │  │   Signer     │  │
                     │  └──────────────┘  │
                     │                    │
                     │  ┌──────────────┐  │     ┌─────────────────┐
                     │  │  Solana RPC  │──┼────►│ Jito Block      │
                     │  │  (Helius)    │  │     │ Engine (bundle) │
                     │  └──────────────┘  │     └─────────────────┘
                     │                    │
                     │  ┌──────────────┐  │
                     │  │  TradeLock   │  │
                     │  │  (mutex)     │  │
                     │  └──────────────┘  │
                     └────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────────┐
        │Telemetry │   │ Balance  │   │  Dashboard   │
        │ (JSONL)  │   │ Snapshot │   │  (React SPA) │
        └──────────┘   └──────────┘   └──────────────┘
```

---

## Çalışma Modları

### 1. Live Mod (`DRY_RUN=false`)
Quote → Build TX → Simulate (opsiyonel) → Zincire gönder (Jito veya Sequential)

### 2. Dry-Run Modu (`DRY_RUN=true`) — **Varsayılan**
Quote → Build TX → Simulate → Telemetri yaz → **TX gönderilmez**
- Başlangıçta `★ DRY-RUN MODU AKTİF` banner'ı gösterilir
- `DRY_RUN_SIM_OK` status'ü ile telemetri kaydı yapılır
- Simülasyon hataları uyarı olarak loglanır, akış devam eder
- Canlıya geçmek için `.env` dosyasında `DRY_RUN=false` yapılır

### 3. Standalone Dry-Run (`npm run dry-run`)
Tek seferlik build+simulate testi. `src/dryRun.ts` → RPC latency ölçümü + tek yönlü swap simülasyonu.

---

## İki Yönlü Arbitraj Akışı

### Yön 1: `JUP_TO_OKX`
1. USDC → \<token\> swap (Jupiter üzerinden)
2. \<token\> → USDC swap (OKX DEX üzerinden)
3. Net USDC farkı = kâr/zarar

### Yön 2: `OKX_TO_JUP`
1. USDC → \<token\> swap (OKX DEX üzerinden)
2. \<token\> → USDC swap (Jupiter üzerinden)
3. Net USDC farkı = kâr/zarar

### Round-Robin Multi-Token Tarama

```
Tick 1 → SOL/USDC  (JUP_TO_OKX ∥ OKX_TO_JUP — paralel)
Tick 2 → WIF/USDC  (JUP_TO_OKX ∥ OKX_TO_JUP — paralel)
Tick 3 → JUP/USDC  (JUP_TO_OKX ∥ OKX_TO_JUP — paralel)
         ↻ (döngü devam eder)
```

- Her tick'te **tek token**, **iki yön PARALEL** taranır
- `SCAN_TOKENS` env değişkeni ile yapılandırılır (varsayılan: `SOL,WIF,JUP`)
- Jupiter ve OKX farklı API'lar olduğundan aynı anda çağrılabilir

---

## Event-Driven Tarama: PriceTicker + SlotDriver

```
   ┌──────────────┐
   │  Solana RPC   │ (WebSocket: slotsUpdatesSubscribe)
   │  (Helius WS)  │
   └──────┬───────┘
          │ slot event
          ▼
   ┌──────────────┐
   │  SlotDriver   │  Her yeni slot geldiğinde listener'ları tetikler
   └──────┬───────┘
          │ onSlot(callback)
          ▼
   ┌──────────────────────────────────────────────────┐
   │  PriceTicker                                      │
   │                                                   │
   │  slotCounter % slotsPerCheck === 0?  ─── hayır → skip
   │       │ evet                                      │
   │       ▼                                           │
   │  API Cooldown geçti mi?  ─── hayır → skip         │
   │       │ evet                                      │
   │       ▼                                           │
   │  TradeLock.tryAcquire()  ─── false → skip         │
   │       │ true (mutex alındı)                       │
   │       ▼                                           │
   │  ADIM 0: resolvePriorityFee() (dinamik, cache'li)│
   │  ADIM 1: Paralel quote (iki yön aynı anda)       │
   │  ADIM 2: En kârlı rotayı seç (spread buffer)     │
   │  ADIM 3: buildAndSimulate() (tam TX oluştur)     │
   │  DRY-RUN? → Telemetri yaz, return                 │
   │  ADIM 4: LIVE EXECUTION                           │
   │     ├── Jito aktif? → executeAtomicArbitrage()    │
   │     └── Sequential  → sendWithRetry(Leg1→Leg2)   │
   │  ADIM 5: Post-trade snapshot, realized PnL hesabı│
   │       │                                           │
   │  finally: advanceRoundRobin() + tradeLock.release│
   └──────────────────────────────────────────────────┘
```

### SlotDriver (`stream/slotDriver.ts`)
- Solana RPC WebSocket'e bağlanarak `slotsUpdatesSubscribe` yapılır
- Her slot event'inde kayıtlı listener'lar tetiklenir
- Bağlantı koptuğunda 1 saniye sonra otomatik reconnect

### PriceTicker (`stream/priceTicker.ts`)
- **Slot-tabanlı:** Her `SLOTS_PER_CHECK` slot'ta bir kontrol yapar (~0.8s varsayılan)
- **API Cooldown:** `API_COOLDOWN_MS` ile ardışık API çağrılarını throttle eder
- **TradeLock:** Global mutex — eşzamanlı trade'i engeller + cooldown uygular
- **Spread Buffer:** Estimate aşamasında `1.5x minNetProfitUsdc` gerekli (MEV/slippage tamponu)
- **Quote Caching:** `estimateDirectionProfit` cache'i `buildAndSimulate`'a aktarılır (re-quote atlanır)

---

## Net Profit Hesaplama Akışı

Her `buildAndSimulate()` çağrısında iki bacak tamamlandıktan sonra:

```
inputRaw = toRaw(notionalUsd, 6)        // Başlangıç USDC (raw bigint)
         │
Leg 1:   USDC → <token>  (quote: expectedOut = token raw)
         │
Leg 2:   <token> → USDC  (quote: expectedOut = USDC raw)
         │
grossProfitRaw  = leg2.expectedOut − inputRaw
grossProfitUsdc = grossProfitRaw / 10^6
         │
feeSol  = (BASE_FEE + priorityFee × CU) × legCount / 1e9
feeUsdc = feeSol × solUsdcRate
         │
netProfitUsdc = grossProfitUsdc − feeUsdc
         │
         ├── ≥ minNetProfitUsdc × buffer  →  İşlem ONAYLANDI
         └── < minNetProfitUsdc × buffer  →  NetProfitRejectedError
```

### Spread Buffer Mekanizması

| Aşama | Buffer | Açıklama |
|---|---|---|
| `estimateDirectionProfit` | 1.5x | Tahmini kâr daima gerçek kârdan ~%50 iyi çıkar |
| `buildAndSimulate` (live) | 1.5x | On-chain slippage + gas koruma tamponu |
| `buildAndSimulate` (dry-run) | 1.0x | Simülasyon amaçlı, buffer yok |

### Örnek Hesaplama (240 USDC, JUP_TO_OKX, SOL/USDC)

| Adım | Değer |
|---|---|
| inputRaw | 240,000,000 (240 USDC) |
| Leg 1 (Jupiter USDC→SOL) | expectedOut = 2,832,716,434 lamports (~2.83 SOL) |
| Leg 2 (OKX SOL→USDC) | expectedOut = 240,192,647 (~240.19 USDC) |
| grossProfitRaw | 192,647 |
| grossProfitUsdc | +0.192647 USDC |
| feeUsdc | −0.002100 USDC (2 TX × 5000 lamports base + priority) |
| **netProfitUsdc** | **+0.190547 USDC → ONAYLANDI** |

---

## Jito Bundle Entegrasyonu

### Atomik 2-Leg Execution

Jito bundle'ları tüm TX'lerin **aynı blokta** yer almasını garanti eder. Sequential mod'daki Leg1→Leg2 arası bekleme riski ortadan kalkar.

```
┌─────────────────────────────────────────────────┐
│  Jito Bundle (tek blokta atomik)                │
│                                                  │
│  TX Sırası:                                      │
│    1. Leg 1 (swap TX — örn. Jupiter USDC→SOL)   │
│    2. Leg 2 (swap TX — örn. OKX SOL→USDC)       │
│    3. Tip TX (SOL transfer → Jito tip hesabı)   │
│                                                  │
│  Hepsi aynı blockhash + aynı blok               │
└─────────────────────────────────────────────────┘
```

### Jito Avantajları
- **Atomik:** Her iki bacak aynı blokta, ardışık olarak çalışır
- **MEV koruması:** Bundle validatör tarafından önceliklendirilir
- **Sequential risk yok:** Leg1→Leg2 arası saniye cinsinden bekleme yok
- **Tek atomik işlem:** Ya ikisi de çalışır ya hiçbiri (çoğunlukla)

### Jito Akış Diyagramı

```
executeAtomicArbitrage()
         │
         ▼
prepareAtomicBundle()
  ├── Taze blockhash al (getLatestBlockhash)
  ├── Leg1 + Leg2 TX'lerin blockhash'ini eşitle (replaceBlockhash)
  ├── Tip TX oluştur (buildTipTransaction → rastgele tip hesabı)
  ├── Tüm TX'leri imzala (tek signer)
  └── TX imzalarını çıkar (serializeTxBase58)
         │
         ▼
sendJitoBundle()  → JSON-RPC: sendBundle([Leg1, Leg2, Tip])
         │
         ▼
waitForBundleLanding()  → Polling: getBundleStatuses
  ├── "Landed" (confirmed/finalized) → ✓ BAŞARILI
  ├── "Failed" → on-chain doğrulama (checkBundleTxResults)
  ├── "Invalid" → format hatası, retry anlamsız
  └── "Timeout" → on-chain doğrulama (checkBundleTxResults)
         │
         ▼
checkBundleTxResults()
  ├── bothSucceeded  → ✓ her iki TX de on-chain
  ├── leg1Only       → ⚠ INVENTORY EXPOSURE → emergencyUnwind()
  ├── neitherLanded  → temiz başarısızlık (kayıp yok)
  └── bothFailed     → beklenmedik durum
```

### Jito Rate-Limiting & Cooldown

```
429 HTTP veya RPC -32097 alındığında:
  │
  ├── activateJitoCooldown() → 60s boyunca Jito devre dışı
  ├── advanceJitoEndpoint()  → Round-robin sonraki bölgeye geç
  └── PriceTicker otomatik sequential mode'a düşer
      (isJitoAvailable() false döner)
```

| Parametre | Değer | Açıklama |
|---|---|---|
| `JITO_429_MAX_RETRIES` | 1 | Fast-fail: fazla retry yapılmaz |
| `JITO_429_BACKOFF_BASE_MS` | 1,000ms | Exponential backoff temeli |
| `JITO_MIN_CALL_SPACING_MS` | 3,000ms | Ardışık API çağrıları arası min bekleme |
| `JITO_COOLDOWN_MS` | 60,000ms | Rate-limit sonrası cooldown süresi |
| `JITO_FETCH_TIMEOUT_MS` | 10,000ms | HTTP fetch timeout |
| `BUNDLE_POLL_INTERVAL_MS` | 2,000ms | Landing durumu polling aralığı |
| `BUNDLE_LANDING_TIMEOUT_MS` | 30,000ms | Landing varsayılan timeout |
| `MAX_BUNDLE_ATTEMPTS` | 3 | Atomik bundle max retry |

### Jito Tip Hesapları

- Block Engine API'den çekilir (`/api/v1/bundles/tip_accounts`)
- 5 dakika cache'lenir (`TIP_CACHE_TTL_MS`)
- API erişilemezse 6 bilinen fallback hesabından rastgele seçilir
- Her bundle farklı tip hesabına gönderilir (yük dağılımı)
- Varsayılan tip: `10,000 lamports` (0.00001 SOL) — `JITO_TIP_LAMPORTS` ile yapılandırılır

### Jito Block Engine Endpoint'leri (Round-Robin)

```
1. mainnet.block-engine.jito.wtf      (birincil)
2. amsterdam.mainnet.block-engine.jito.wtf
3. frankfurt.mainnet.block-engine.jito.wtf
4. ny.mainnet.block-engine.jito.wtf
5. tokyo.mainnet.block-engine.jito.wtf
```
Her 429 hatasında sonraki endpoint'e geçilir. `JITO_BLOCK_ENGINE_URLS` env ile override edilebilir.

### Jito Fallback → Sequential Mode

Jito kullanılamadığında (rate-limit, hata) otomatik olarak sequential mode'a düşülür:

```
Jito rate-limited veya devre dışı?
  │
  ├── Evet → Sequential Path
  │     ├── Leg1: sendWithRetry() → waitForConfirmation()
  │     ├── buildFreshLeg2() (taze quote + blockhash)
  │     ├── Leg2: sendWithRetry()
  │     └── Başarısızlıkta: emergencyUnwind()
  │
  └── Hayır → Jito Atomic Path (yukarıda açıklanan)
```

Jito fallback sonrası Leg1 TX'inin blockhash'i `refreshLeg1ForSequential()` ile tazelenir (~200ms). Tam rebuild (`buildAndSimulate`) 3-5 saniye sürer ve spread kapanabilir.

---

## Execution Katmanı

### `estimateDirectionProfit()`
- **Lightweight quote-only** — TX build veya simülasyon yapmaz
- İki bacağın quote'unu alıp tahmini net kâr hesaplar
- PriceTicker her iki yönü paralel tarar, en kârlısını seçer
- Jupiter route ve OKX meta'yı cache'ler → `buildAndSimulate`'a aktarır

### `buildAndSimulate()`
- Quote al (veya cache'den kullan) → TX oluştur → Simulate → Net Profit Gate
- **Live mod:** Leg 1 simülasyonu atlanır (hız optimizasyonu; on-chain slippage koruması aktif)
- **Dry-run mod:** Her iki leg de simüle edilir (`simulateLegSafe` ile hata-toleranslı)
- Cache-hit durumunda Jupiter re-quote atlanır (stale fiyat riski önlenir)

### `sendWithRetry()`
- Exponential backoff ile max 3 deneme
- Her denemede TX imzalanır ve gönderilir
- RPC error dönse bile **on-chain doğrulama** (`verifyTxOnChain`) yapılır — TX zincirde başarılı olmuş olabilir
- Circuit breaker: ardışık `circuitBreakerThreshold` başarısız gönderimde `SendError` fırlatılır

### `buildFreshLeg2()`
- Leg 1 on-chain confirm olduktan sonra Leg 2'yi tamamen yeniden oluşturur
- Taze quote + taze blockhash + Leg 1'den gelen **gerçek miktar** kullanılır
- **OKX 429 Fallback:** OKX rate-limited ise Leg 2 Jupiter ile denenir (unwind'i engeller)
- SOL token için `resolveSolBalance()` ile wSOL ATA vs native SOL tespiti yapılır

### `emergencyUnwind()`
Leg 2 başarısız olduğunda cüzdandaki takılı token'ı USDC'ye çevirir (sermaye kurtarma):

```
emergencyUnwind()
  │
  ├── 1. checkLeg2AlreadySucceeded()
  │     └── Token balance ~0 + USDC artmış → unwind GEREKSİZ (false alarm)
  │
  ├── 2. On-chain bakiye okuma (SOL: ATA vs native; SPL: ATA balance)
  │
  └── 3. Jupiter ile token → USDC swap (5 retry, 1% slippage tolerance)
        ├── Başarılı → EMERGENCY_UNWIND_SUCCESS + circuit breaker reset
        └── Başarısız → EMERGENCY_UNWIND_FAILED + "MANUAL INTERVENTION REQUIRED"
```

---

## Realized PnL (Gerçek Kâr/Zarar) Hesaplama

### Balance Snapshot Mekanizması

```
Pre-trade snapshot    ──────────    Post-trade snapshot
(USDC + SOL bakiye)                (USDC + SOL bakiye)
        │                                   │
        └───────── computeRealizedPnl() ────┘
                          │
                ┌─────────┴──────────┐
                │  deltaUsdc         │ = Post_USDC − Pre_USDC
                │  deltaSol          │ = Pre_SOL − Post_SOL (gas/fee)
                │  solCostUsdc       │ = deltaSol × solUsdcRate
                │  realizedNetPnL    │ = deltaUsdc − solCostUsdc
                └────────────────────┘
```

- **Pre-trade snapshot:** Trade öncesi USDC + native SOL bakiyesi okunur
- **Post-trade snapshot:** Tüm leg'ler tamamlandıktan sonra bakiye tekrar okunur
- Fark hesaplanarak **gerçek** (tahmini değil) kâr/zarar bulunur
- Telemetri kaydına `realizedPnl` olarak eklenir

---

## Dinamik Priority Fee

```
suggestPriorityFee(connection, maxFee)
  │
  ├── Cache aktif (10s TTL)? → Stale fee döndür
  │
  └── getRecentPrioritizationFees() → sıfır olmayanları filtrele → p50 (median) al
        │
        ├── Cap uygula (MAX_PRIORITY_FEE)
        └── Cache'e yaz (10s TTL)

resolvePriorityFee() — execution.ts
  │
  ├── DYNAMIC_PRIORITY_FEE=true  → suggestPriorityFee()
  └── DYNAMIC_PRIORITY_FEE=false → sabit PRIORITY_FEE_MICROLAMPORTS
```

- Zincirden güncel median priority fee çeker (p50)
- `MAX_PRIORITY_FEE` ile cap'lenir — aşırı fee ödemeyi engeller
- 30 saniye execution-level cache (tick içinde tek RPC çağrısı)
- 10 saniye fee-level cache (RPC throttle koruması)

---

## TradeLock (Mutex & Cooldown)

```
PriceTicker tick
      │
      ▼
tradeLock.tryAcquire()
  │
  ├── isExecuting?  → SKIP (başka trade sürüyor)
  ├── Cooldown aktif? → SKIP (TRADE_COOLDOWN_MS henüz geçmedi)
  └── ✓ Lock alındı → trade flow başlar
      │
      └── finally: tradeLock.release()
            (lastTradeTime güncellenir, cooldown başlar)
```

- **Mutex:** Eşzamanlı trade execution'ı engeller
- **Cooldown:** `TRADE_COOLDOWN_MS` (varsayılan 2000ms) arası zorunlu bekleme
- **Senkron:** `tryAcquire()` async değildir — race condition riski yok

---

## Güvenlik Katmanları

| Katman | Mekanizma | Değer | Modül |
|---|---|---|---|
| Slippage Cap | Simülasyonda kontrol (`computeSlippageBps`) | ≤ 10 bps (0.1%) | `execution.ts` |
| Notional Cap | İşlem öncesi kontrol (`enforceNotional`) | NOTIONAL_CAP_USD (varsayılan 1000) | `execution.ts` |
| **Net Profit Gate** | **Brüt kâr − tahmini fee ≥ eşik × buffer** | **≥ 0.12 USDC × 1.5 (live)** | `execution.ts` |
| **Spread Buffer** | Estimate aşamasında ek filtre | 1.5× minNetProfitUsdc | `priceTicker.ts` |
| Retry + Backoff | Üssel geri çekilme (300ms base) | Maks 3 deneme | `execution.ts` |
| Circuit Breaker | Ardışık başarısız gönderim sayacı | 3 → `SendError` fırlat | `execution.ts` |
| Trade Mutex | Global lock — eşzamanlı trade'i engelle | TradeLock singleton | `tradeLock.ts` |
| Trade Cooldown | Ardışık trade arası zorunlu bekleme | 2000ms | `tradeLock.ts` |
| API Cooldown | Ardışık API çağrıları arası throttle | 600ms | `priceTicker.ts` |
| Priority Fee | Dinamik — zincirden güncel median + cap | MAX_PRIORITY_FEE cap | `fees.ts` |
| OKX Rate-Limit | 429 alındığında 60s cooldown + skip | isOkxAvailable() | `okxDex.ts` |
| Jito Rate-Limit | 429/RPC error → 60s cooldown → sequential | isJitoAvailable() | `jito.ts` |
| On-Chain Verify | RPC error sonrası TX zincirde mi kontrol | verifyTxOnChain() | `execution.ts` |
| Emergency Unwind | Leg2 fail → token'ı USDC'ye çevir (5 retry) | emergencyUnwind() | `execution.ts` |
| Leg2 Pre-Check | Token balance ~0 → Leg2 zaten başarılı mı? | checkLeg2AlreadySucceeded() | `execution.ts` |
| SOL Balance Resolve | wSOL ATA vs native SOL tespiti | resolveSolBalance() | `solana.ts` |
| DryRun Modu | TX gönderilmez, sadece quote + simulate | `DRY_RUN=true` | `config.ts` |

---

## Telemetri & Logging

### Telemetri Yapısı (`Telemetry` interface)

| Alan | Tip | Açıklama |
|---|---|---|
| `pair` | TradePair | İşlem çifti (ör. `SOL/USDC`) |
| `direction` | Direction | `JUP_TO_OKX` veya `OKX_TO_JUP` |
| `targetToken` | TokenSymbol | Takas edilen token (ör. `SOL`) |
| `simulatedAmountOut` | string | Simülasyondan beklenen çıktı (raw) |
| `realizedAmountOut` | string? | Gerçek çıktı (varsa) |
| `effectiveSlippageBps` | number? | Etkin kayma (bps) |
| `success` | boolean | İşlem başarılı mı |
| `failReason` | string? | Başarısızlık nedeni |
| `txSignatures` | string[] | TX imzaları |
| `timestamp` | string | UTC ISO zaman damgası |
| `retries` | number | Tekrar deneme sayısı |
| `profitLabel` | "profit" / "loss" / "flat" | Kâr/zarar etiketi |
| `netProfitUsdc` | number | Tahmini veya gerçek net kâr (USDC) |
| `grossProfitUsdc` | number | Brüt kâr (USDC) |
| `feeUsdc` | number | Tahmini ağ ücreti (USDC) |
| `status` | TelemetryStatus | Makine-okunur durum etiketi |
| `realizedPnl` | RealizedPnlInfo? | On-chain gerçek bakiye deltası |

### TelemetryStatus Değerleri

| Status | Açıklama | Dosyaya yazılır |
|---|---|---|
| `SIMULATION_SUCCESS` | Simülasyon başarılı (dry-run) | ✓ |
| `DRY_RUN_PROFITABLE` | Dry-run kârlı ama sim hatası var | ✓ |
| `DRY_RUN_SIM_OK` | PriceTicker dry-run sim tamamlandı | — |
| `REJECTED_LOW_PROFIT` | Kâr minimum eşiğin altında | ✓ |
| `SEND_SUCCESS` | TX başarıyla gönderildi | ✓ |
| `JITO_BUNDLE_LANDED` | Jito bundle landed | ✓ (implicit) |
| `JITO_BUNDLE_FAILED` | Jito bundle başarısız | ✓ (implicit) |
| `EMERGENCY_UNWIND_SUCCESS` | Acil sermaye kurtarma başarılı | ✓ |
| `EMERGENCY_UNWIND_FAILED` | Acil sermaye kurtarma başarısız | ✓ |
| `LEG2_REFRESH_FAILED` | Leg2 rebuild/send başarısız | ✓ |
| `SIMULATION_FAILED` | Simülasyon hatası | — (console.warn) |
| `SLIPPAGE_EXCEEDED` | Kayma limiti aşıldı | — (console.warn) |
| `SEND_FAILED` | Gönderim başarısız | — (console.warn) |
| `LIMIT_BREACH` | Notional/miktar limiti aşıldı | — (console.warn) |
| `QUOTE_ERROR` | Quote alma hatası | — (console.warn) |
| `UNKNOWN_ERROR` | Bilinmeyen hata | — (console.warn) |

### JSONL Logging
- Dosya: `logs/trades.jsonl` — her satır bir JSON nesnesi
- Sadece `PERSISTABLE_STATUSES` setine dahil olan status'ler dosyaya yazılır
- Diğer durumlar `console.warn` ile loglanır (I/O maliyeti azaltılır)
- `logs/` dizini ilk yazımda otomatik oluşturulur

### Hata Sınıfları

| Sınıf | Tetiklenme | Modül |
|---|---|---|
| `LimitBreachError` | Notional cap aşıldığında | `types.ts` |
| `QuoteError` | Quote API hatası | `types.ts` |
| `SlippageError` | Slippage cap'i aştığında | `types.ts` |
| `SimulationError` | TX simülasyonu başarısız | `types.ts` |
| `SendError` | TX gönderimi başarısız / circuit breaker | `types.ts` |
| `NetProfitRejectedError` | Net kâr eşiğin altında | `types.ts` |
| `JitoBundleError` | Jito bundle API veya format hatası | `jito.ts` |

---

## Dosya Yapısı

```
src/
├── config.ts            # Ortam değişkenleri, AppConfig arayüzü, loadConfig()
├── types.ts             # Paylaşılan tip tanımları, arayüzler, hata sınıfları
├── solana.ts            # RPC bağlantısı, simulateTx(), sendVersionedWithOpts(),
│                        #   waitForConfirmation(), deriveATA(), resolveSolBalance()
├── wallet.ts            # Keypair yükleme (dosya veya env'den)
├── tokens.ts            # Token mint/decimal yardımcıları (toRaw, fromRaw)
├── jupiter.ts           # Jupiter API v6: fetchJupiterQuote(), buildJupiterSwap(),
│                        #   simulateJupiterTx(), computeSlippageBps()
├── okxDex.ts            # OKX DEX API: fetchOkxQuote(), buildOkxSwap(),
│                        #   simulateOkxTx(), isOkxAvailable(), rate-limit cooldown
├── execution.ts         # buildAndSimulate(), estimateDirectionProfit(),
│                        #   sendWithRetry(), buildFreshLeg2(), emergencyUnwind(),
│                        #   executeAtomicArbitrage(), net profit gate, circuit breaker
├── jito.ts              # Jito Block Engine: prepareAtomicBundle(), sendJitoBundle(),
│                        #   waitForBundleLanding(), checkBundleTxResults(),
│                        #   tip hesapları, rate-limit cooldown, round-robin endpoint
├── balanceSnapshot.ts   # takeBalanceSnapshot(), computeRealizedPnl()
│                        #   Pre/Post trade bakiye deltası ile gerçek kâr/zarar
├── telemetry.ts         # buildTelemetry(), appendTradeLog() (JSONL),
│                        #   persistable status filtresi
├── server.ts            # Express API sunucusu (:3001) + Dashboard static
├── start.ts             # Birleşik entrypoint: API + PriceTicker
├── latency.ts           # RPC latency ölçüm modülü
├── fees.ts              # suggestPriorityFee() — dinamik median fee + cache
├── tradeLock.ts         # TradeLock singleton — mutex + cooldown guard
├── dryRun.ts            # Standalone dry-run giriş noktası (tek seferlik sim)
├── airdrop.ts           # Devnet airdrop yardımcısı
├── scripts/
│   ├── convertKey.ts    # Keypair format dönüştürücü
│   └── latencyTest.ts   # Bağımsız latency test scripti
└── stream/
    ├── priceTicker.ts   # Event-driven slot-tabanlı trade döngüsü:
    │                    #   round-robin multi-token, bi-directional paralel scan,
    │                    #   Jito atomic / sequential execution, realized PnL
    └── slotDriver.ts    # WebSocket slot stream sürücüsü (auto-reconnect)

dashboard/               # React monitoring dashboard
├── src/
│   ├── App.tsx          # Ana uygulama (auth gate + layout)
│   ├── types.ts         # Frontend tip tanımları
│   ├── components/
│   │   ├── LoginScreen.tsx   # Şifre giriş ekranı
│   │   ├── TradesTable.tsx   # İşlem tablosu (filtrelenebilir)
│   │   ├── StatsCards.tsx    # Özet metrik kartları
│   │   └── SpreadChart.tsx   # Spread grafiği (recharts)
│   └── hooks/
│       ├── useAuth.ts        # Auth state yönetimi
│       └── useTradeLogs.ts   # API polling hook (/api/logs)
└── dist/                # Production build çıktısı (express.static)

logs/
└── trades.jsonl         # Telemetri kayıtları (JSONL format)

ecosystem.config.cjs     # PM2 süreç yapılandırması
.env                     # Ortam değişkenleri (gitignore'd)
```

---

## Veri Akışı — Tam Çevrim

```
.env → loadConfig() → AppConfig
                          │
                ┌─────────┴──────────┐
                ▼                    ▼
  SlotDriver (WS)         PriceTicker
  slot event ──────────►  onSlot()
                              │
                ┌─────────────┴─────────────────────┐
                ▼                                   ▼
   estimateDirectionProfit(JUP_TO_OKX)   estimateDirectionProfit(OKX_TO_JUP)
      │ fetchJupiterQuote()                 │ fetchOkxQuote()
      │ fetchOkxQuote()                     │ fetchJupiterQuote()
      ▼                                    ▼
   QuoteEstimate (cache'li)          QuoteEstimate (cache'li)
                │                           │
                └─────────┬─────────────────┘
                          ▼
                  En kârlı rotayı seç
                  (spread buffer kontrolü)
                          │
                          ▼
                buildAndSimulate() (cache-hit: re-quote atlanır)
                  ├── TX build (Jupiter/OKX)
                  ├── Simulate (dry-run only)
                  └── Net Profit Gate
                          │
                ┌─────────┴──────────┐
                ▼                    ▼
          DRY-RUN?            LIVE MODE
          Telemetri yaz       │
          Return              ▼
                        Jito aktif?
                        ├── Evet → executeAtomicArbitrage()
                        │     └── sendJitoBundle() → waitForBundleLanding()
                        └── Hayır → Sequential
                              ├── sendWithRetry(Leg1)
                              ├── waitForConfirmation()
                              ├── buildFreshLeg2()
                              └── sendWithRetry(Leg2)
                                    │
                                    ▼
                          Post-trade balance snapshot
                          computeRealizedPnl()
                                    │
                                    ▼
                          buildTelemetry() → appendTradeLog()
                          → logs/trades.jsonl
```

---

## Tek Port Mimarisi

Frontend ve backend tek bir Express sunucusu üzerinden (port 3001) sunulur:

```
:3001 (0.0.0.0)
├── GET  /api/logs       → JSONL parse → JSON array (auth required)
├── POST /api/logs/clear → trades.jsonl temizle (auth required)
├── /assets/*            → express.static (dashboard/dist)
└── /* (GET, non-api)    → Catch-all → index.html (React SPA routing)
```

**Auth:** `Authorization: Bearer <DASHBOARD_PASSWORD>` header'ı gerekli.

---

## Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DRY_RUN` | `true` | Dry-run modu: TX gönderilmez |
| `HELIUS_API_KEY` | — | Helius RPC/WS otomatik URL oluşturma |
| `SOLANA_RPC_PRIMARY` | Helius | Birincil RPC endpoint |
| `SOLANA_RPC_BACKUP` | Helius | Yedek RPC endpoint |
| `SOLANA_WS_PRIMARY` | Helius | WebSocket endpoint (slot stream) |
| `SOLANA_COMMITMENT` | `confirmed` | RPC commitment seviyesi |
| `WALLET_KEYPATH` | — | Keypair JSON dosya yolu |
| `OKX_API_KEY` | — | OKX API anahtarı |
| `OKX_API_SECRET` | — | OKX API secret |
| `OKX_API_PASSPHRASE` | — | OKX API passphrase |
| `OKX_API_PROJECT` | — | OKX proje adı |
| `JUPITER_API_KEY` | — | Jupiter API anahtarı |
| `USDC_MINT` | — | USDC token mint adresi (**zorunlu**) |
| `SOL_MINT` | `So111...112` | SOL (wSOL) mint adresi |
| `TRADE_AMOUNT_USDC` | `1` | Her trade'de kullanılacak USDC miktarı |
| `SLIPPAGE_BPS` | `10` | Slippage toleransı (bps, 10 = %0.1) |
| `NOTIONAL_CAP_USD` | `1000` | Maksimum trade miktarı (USDC) |
| `MIN_NET_PROFIT_USDC` | `0.12` | Minimum net kâr eşiği (USDC) |
| `SOL_USDC_RATE` | `150` | SOL/USDC tahmini kuru (fee hesabı için) |
| `MAX_RETRIES` | `3` | TX gönderimi max deneme |
| `CIRCUIT_BREAKER_THRESHOLD` | `3` | Circuit breaker eşiği |
| `API_COOLDOWN_MS` | `600` | API çağrıları arası min bekleme |
| `TRADE_COOLDOWN_MS` | `2000` | Trade'ler arası min bekleme |
| `SCAN_TOKENS` | `SOL,WIF,JUP` | Round-robin tarama token listesi |
| `SLOTS_PER_CHECK` | `2` | Kaç slot'ta bir kontrol (~0.8s) |
| `DYNAMIC_PRIORITY_FEE` | `true` | Dinamik fee aktif mi |
| `MAX_PRIORITY_FEE` | `100000` | Dinamik fee üst sınırı (micro-lamports) |
| `PRIORITY_FEE_MICROLAMPORTS` | `50000` | Sabit fallback fee |
| `USE_JITO_BUNDLE` | `false` | Jito bundle kullanılsın mı |
| `JITO_BLOCK_ENGINE_URL` | mainnet | Birincil Jito endpoint |
| `JITO_BLOCK_ENGINE_URLS` | 5 bölge | Virgülle ayrılmış endpoint listesi |
| `JITO_TIP_LAMPORTS` | `10000` | Jito tip miktarı (lamports) |
| `DASHBOARD_PASSWORD` | — | Dashboard auth şifresi |
| `API_PORT` | `3001` | Express sunucu portu |

---

## PM2 Süreç Yönetimi

```javascript
// ecosystem.config.cjs
{
  name: "arb-server",
  script: "npx",
  args: "tsx src/start.ts",
  max_restarts: 10,
  restart_delay: 3000,
  exp_backoff_restart_delay: 1000,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  error_file: "logs/pm2-error.log",
  out_file: "logs/pm2-out.log",
}
```

- `.env` dosyası okunup env değişkenleri process'e aktarılır
- Crash durumunda exponential backoff ile yeniden başlatılır (max 10 restart)

---

## Teknoloji Yığını

| Bileşen | Teknoloji |
|---|---|
| Runtime | Node.js 20+ |
| Dil | TypeScript (ES2022, NodeNext) |
| Blockchain | Solana (mainnet-beta) |
| SDK | @solana/web3.js ^1.95 |
| DEX 1 | Jupiter Aggregator API v6 |
| DEX 2 | OKX DEX Aggregator API v6 |
| Bundle Engine | Jito Block Engine (JSON-RPC) |
| Backend | Express 5, CORS |
| Frontend | React 19, Vite, Tailwind CSS, shadcn/ui, recharts |
| Çevre Değişkenleri | dotenv |
| WS Desteği | ws ^8.18 |
| TS Runner | tsx |
| Süreç Yönetimi | PM2 |
| Encoding | bs58 (base58 TX serialization) |
