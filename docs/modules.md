# Modül Referansı

Her kaynak dosyanın sorumluluğu, dışa aktardığı fonksiyonlar ve bağımlılıkları.

---

## config.ts

Ortam değişkenlerinden uygulama konfigürasyonunu okur.

### Dışa Aktarılanlar

| İsim | Tür | Açıklama |
|---|---|---|
| `loadConfig()` | `() → AppConfig` | `.env` + ortam değişkenlerinden tam config nesnesi döner |
| `DEFAULT_SLIPPAGE_BPS` | `number` | Varsayılan slippage: 20 (0.2%) |
| `DEFAULT_NOTIONAL_CAP` | `number` | Varsayılan işlem limiti: 1000 USD |
| `DEFAULT_MAX_RETRIES` | `number` | Varsayılan yeniden deneme: 3 |
| `DEFAULT_CIRCUIT_BREAKER` | `number` | Circuit breaker eşiği: 3 |
| `DEFAULT_MIN_NET_PROFIT_USDC` | `number` | Minimum net kâr eşiği: 0.05 USDC |
| `DEFAULT_SOL_USDC_RATE` | `number` | Fee hesabı için SOL/USDC: 150 |
| `DEFAULT_API_COOLDOWN_MS` | `number` | API istekleri arası bekleme: 2000ms |

### AppConfig Arayüzü

```typescript
{
  rpc: { primary, backup?, wsPrimary?, wsBackup?, commitment?, priorityFeeMicrolamports? }
  okxBaseUrl: string
  okxProjectId?: string
  okxApiKey?: string
  okxApiSecret?: string
  okxApiPassphrase?: string
  jupiterApiKey?: string
  slippageBps: number
  notionalCapUsd: number
  maxRetries: number
  circuitBreakerThreshold: number
  tokens: Record<string, { symbol, mint, decimals }>
  minNetProfitUsdc: number   // Net kâr eşiği (USDC)
  solUsdcRate: number         // Fee hesabı için SOL/USDC
  apiCooldownMs: number       // API cooldown (ms)
}
```

---

## types.ts

Paylaşılan tip tanımları ve özel hata sınıfları.

### Tipler

| Tip | Açıklama |
|---|---|
| `Direction` | `"JUP_TO_OKX" \| "OKX_TO_JUP"` |
| `QuoteMeta` | Quote sonucu: venue, mint'ler, tutar, slippage, rota |
| `SimulationOutcome` | Simülasyon sonucu: loglar, hata, bakiyeler |
| `SimulatedLeg` | Tek bacak: TX, beklenen/simüle edilen çıktı, slippage |
| `NetProfitInfo` | Net kâr bilgisi: `grossProfitUsdc`, `feeUsdc`, `netProfitUsdc` |
| `BuildSimulateResult` | Tüm bacaklar + quote meta + `netProfit: NetProfitInfo` |
| `SendAttempt` | Tek gönderim denemesi bilgisi |
| `SendResult` | Gönderim sonucu: başarı, imza, denemeler |
| `TelemetryStatus` | Durum etiketi: `SIMULATION_SUCCESS`, `DRY_RUN_PROFITABLE`, `REJECTED_LOW_PROFIT`, vb. |
| `Telemetry` | Yapılandırılmış telemetri nesnesi |

### Hata Sınıfları

| Sınıf | Ne Zaman Atılır |
|---|---|
| `LimitBreachError` | Notional cap aşıldığında |
| `QuoteError` | Quote API'den yanıt alınamadığında |
| `SlippageError` | Slippage %0.2 eşiğini aştığında |
| `SimulationError` | TX simülasyonu başarısız olduğunda |
| `SendError` | TX gönderimi tüm denemelerde başarısız olduğunda |
| `NetProfitRejectedError` | Net kâr minimum eşiğin altında kaldığında (`netProfit` alanı taşır) |

---

## solana.ts

Solana RPC bağlantısı, TX simülasyonu ve gönderimi.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `getConnection()` | `() → Connection` | Primary RPC'ye bağlantı |
| `fallbackConnection()` | `() → Promise<Connection>` | Backup RPC'ye bağlantı |
| `simulateTx()` | `(conn, tx, commitment?) → Promise<SimulationOutcome>` | TX simülasyonu + bakiye/log çıkarımı |
| `sendVersionedWithOpts()` | `(conn, tx, opts?) → Promise<string>` | TX gönderimi (imza döner) |

---

## wallet.ts

Keypair yönetimi.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `loadKeypairFromFile()` | `(path) → Keypair` | JSON veya base64 dosyadan keypair yükler |
| `getKeypairFromEnv()` | `() → Keypair` | `WALLET_KEYPATH` env'den keypair alır |

---

## tokens.ts

Token mint ve decimal yardımcıları.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `getMintInfo()` | `(symbol) → { mint, decimals }` | Sembolden mint bilgisi |
| `toRaw()` | `(amount, decimals) → bigint` | UI tutarını raw birime çevir |
| `fromRaw()` | `(amount, decimals) → number` | Raw birimi UI tutarına çevir |
| `isSolMint()` | `(mint) → boolean` | Native SOL mint mi kontrol |

---

## jupiter.ts

Jupiter Aggregator API v6 entegrasyonu.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `fetchJupiterQuote()` | `(params) → Promise<{ route, meta }>` | Quote al, en iyi rotayı döndür |
| `buildJupiterSwap()` | `(params) → Promise<VersionedTransaction>` | Swap TX'i oluştur (henüz imzalanmamış) |
| `simulateJupiterTx()` | `(conn, tx) → Promise<SimulationOutcome>` | Jupiter TX simülasyonu |
| `computeSlippageBps()` | `(expected, simulated) → number?` | Efektif slippage hesapla |

### API Endpoint'leri
- Quote: `https://api.jup.ag/swap/v6/quote`
- Swap: `https://api.jup.ag/swap/v6/swap`
- Auth: `x-api-key` header (zorunlu)

---

## okxDex.ts

OKX DEX Aggregator API **v6** entegrasyonu (Solana).

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `fetchOkxQuote()` | `(params) → Promise<{ ctx, meta }>` | GET ile quote al |
| `buildOkxSwap()` | `(params) → Promise<VersionedTransaction>` | Swap instruction'lardan TX oluştur |
| `simulateOkxTx()` | `(conn, tx) → Promise<SimulationOutcome>` | OKX TX simülasyonu |

### API Endpoint'leri
- Quote: `GET <OKX_BASE_URL>/api/v6/dex/aggregator/quote`
- Swap: `GET <OKX_BASE_URL>/api/v6/dex/aggregator/swap-instruction`
- Auth: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN` (HMAC-SHA256), `OK-ACCESS-PASSPHRASE`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PROJECT`

### Solana Özel Parametreler
- `chainIndex: "501"` — Solana mainnet-beta
- `fromTokenAddress` / `toTokenAddress` — Token mint adresleri
- `slippagePercent` — Yüzde string (ör: `"0.2"` = %0.2)
- Address Lookup Table (ALT) desteği — TX boyutunu küçültür

> Ayrıntılı düzeltme dokümantasyonu: [docs/okx-api-fix.md](okx-api-fix.md)

---

## execution.ts

Orchestration: build → simulate → net profit gate → send döngüsü.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `buildAndSimulate()` | `({ direction, notionalUsd, owner, dryRun? }) → Promise<BuildSimulateResult>` | İki bacağı oluştur + simüle et + net profit kontrolü |
| `sendWithRetry()` | `(tx, signer, commitment?) → Promise<SendResult>` | Üssel backoff ile TX gönder |

### buildAndSimulate() Akışı
1. Notional cap kontrolü (≤ 200 USDT)
2. Yöne göre sırasıyla quote al (Jupiter/OKX)
3. Her quote için swap TX oluştur
4. Her TX'i simüle et (`dryRun: true` ise sim hatası uyarı olarak loglanır)
5. Simülasyondan çıktı tutarı ve efektif slippage hesapla
6. **Net Profit Gate** (aşağıda açıklanmıştır)
7. Slippage cap kontrolü (≤ 20 bps)
8. Simülasyon hatası kontrolü
9. `BuildSimulateResult` döndür (içinde `netProfit: NetProfitInfo`)

### Net Profit Gate (Kâr Eşiği Kontrolü)

`buildAndSimulate()` içinde her iki bacak (leg) tamamlandıktan sonra çalışır:

```
leg2.expectedOut (USDC raw)  ─  inputRaw (USDC raw)  =  grossProfitRaw
grossProfitRaw / 10^6                                 =  grossProfitUsdc
estimatedFeeUsdc  =  (baseFee + priorityFee) × legCount / 1e9 × solUsdcRate
netProfitUsdc     =  grossProfitUsdc − estimatedFeeUsdc
```

- **`leg2.expectedOut`**: Leg 2 quote'undan gelen raw USDC çıktısı (bigint)
- **`inputRaw`**: Başlangıç notional USDC (bigint, `toRaw(notionalUsd, 6)`)
- **Fee tahmini**: `BASE_FEE_LAMPORTS (5000) + priorityFee × CU (200k)` × leg sayısı, SOL cinsinden → `solUsdcRate` ile USDC'ye çevrilir
- **Karar**: `netProfitUsdc ≥ minNetProfitUsdc` ise İşlem **ONAYLANDI**, değilse `NetProfitRejectedError` fırlatılır

#### Yapılandırma

| Env Değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `MIN_NET_PROFIT_USDC` | `0.05` | Minimum net kâr eşiği (USDC) |
| `SOL_USDC_RATE` | `150` | Fee hesabı için SOL/USDC oranı |
| `PRIORITY_FEE_MICROLAMPORTS` | `undefined` | Priority fee (micro-lamports/CU) |

### `dryRun` Parametresi

`buildAndSimulate({ ..., dryRun: true })` ile çağrıldığında:
- Simülasyon hataları (ör: `"AccountNotFound"`) **throw etmez**, uyarı olarak loglanır
- Slippage aşımı da uyarı olarak loglanır
- Net Profit hesabı quote-tabanlı `expectedOut` ile yapılır
- Cüzdanında token olmasa bile akış tamamlanır

> **Not:** `PriceTicker` her zaman `dryRun: true` ile çalışır. Bu sayede cüzdan bakiyesi olmadan sürekli piyasa taraması yapabilir.

### sendWithRetry() Akışı
1. TX'i imzala
2. RPC'ye gönder
3. Başarısızsa backoff (300ms × 2^attempt) uygula
4. 3. denemede başarısızsa `SendError` at
5. 3 ardışık fail → circuit breaker tetikle

---

## telemetry.ts

Her TX için yapılandırılmış telemetri nesnesi üretir.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `buildTelemetry()` | `(build, signatures, realizedOut?) → Telemetry` | Telemetri objesi üret |

### Telemetry Nesnesi Şekli
```typescript
{
  pair: "SOL/USDC",
  direction: "JUP_TO_OKX" | "OKX_TO_JUP",
  simulatedAmountOut: string,
  realizedAmountOut?: string,
  effectiveSlippageBps?: number,
  success: boolean,
  failReason?: string,
  txSignatures: string[],
  timestamp: string,       // ISO 8601 UTC
  retries: number,
  profitLabel: "profit" | "loss" | "flat",
  netProfitUsdc: number,   // Net kâr (USDC)
  grossProfitUsdc: number, // Brüt kâr (USDC)
  feeUsdc: number,         // Tahmini fee (USDC)
  status: TelemetryStatus  // Durum etiketi
}
```

### Kalıcı Telemetri Durumları

Sadece aşağıdaki durumlar `trades.jsonl`'ye yazılır (I/O tasarrufu):

| Durum | Açıklama |
|---|---|
| `SIMULATION_SUCCESS` | Başarılı simülasyon + net profit onayı |
| `DRY_RUN_PROFITABLE` | DryRun'da sim hatası var ama net profit pozitif |
| `REJECTED_LOW_PROFIT` | Net kâr eşiğin altında |

Diğer durumlar (`SIMULATION_FAILED`, `SLIPPAGE_EXCEEDED`, `SEND_FAILED`, `LIMIT_BREACH`, `QUOTE_ERROR`) yalnızca `console.warn` ile loglanır.

---

## latency.ts

RPC tepki süresi ölçüm modülü.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `measureRpcLatency()` | `(url, label, opts?) → Promise<LatencyReport>` | Tek endpoint ölçümü |
| `measureAllEndpoints()` | `(opts?) → Promise<LatencyReport[]>` | Tüm konfigüre edilmiş endpoint'leri ölç |
| `printLatencyReport()` | `(report) → void` | Raporun formatlanmış konsol çıktısı |

### Ölçülen RPC Metodları
- `getLatestBlockhash`
- `getSlot`
- `getBlockHeight`
- `getEpochInfo`
- `getHealth`
- `getBalance` (wallet pubkey verilmişse)

### Rapor Metrikleri
- Avg, Min, Max, Median, P95 (ms)
- Başarı oranı (%)
- Metod bazlı kırılım

---

## fees.ts

Priority fee öneri mekanizması.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `suggestPriorityFee()` | `(conn) → Promise<FeeSuggestion?>` | Son fee'lere göre önerilen priority fee |

---

## dryRun.ts

Giriş noktası: latency ölçümü + swap simülasyonu.

1. `.env`'den config yükler
2. Tüm RPC endpoint'leri için latency ölçer ve raporlar
3. `buildAndSimulate()` ile swap simülasyonu yapar
4. Sonuçları konsola basar (TX göndermez)

---

## scripts/latencyTest.ts

Bağımsız latency benchmark scripti.

- Konfigüre edilmiş endpoint'ler + public devnet karşılaştırması
- 10 round (LATENCY_ROUNDS ile ayarlanır)
- Karşılaştırma tablosu çıktısı

## scripts/convertKey.ts

Keypair format dönüştürücü (base58 ↔ JSON array).

---

## stream/priceTicker.ts

Event-driven fiyat tarama ve simülasyon döngüsü.

| Sınıf/Fonksiyon | Açıklama |
|---|---|
| `PriceTicker` | Slot tabanlı periyodik quote & sim döngüsü |
| `start()` | SlotDriver'ı başlatır, `onSlot` callback'i kaydeder |
| `stop()` | SlotDriver'ı durdurur |

### Çalışma Mantığı

```
SlotDriver (WebSocket)
    │
    ▼ her N slot'ta bir (slotsPerCheck)
    │
    ▼ API cooldown kontrolü (apiCooldownMs)
    │
    ▼ buildAndSimulate({ dryRun: true })
    │
    ├── ONAYLANDI → Telemetri trades.jsonl'ye yazılır
    └── REDDEDİLDİ/HATA → Uyarı loglanır, döngü devam eder
```

### Kritik: `dryRun: true`

PriceTicker **daima** `dryRun: true` parametresiyle `buildAndSimulate()` çağırır.

**Neden:** Cüzdanda yeterli token olmadığında (çoğu dry-run/tarama senaryosu) Solana RPC simülasyonu `"AccountNotFound"` hatası verir. `dryRun: false` olduğunda bu hata doğrudan throw edilir ve PriceTicker döngüyü kırar. `dryRun: true` ile:

1. Simülasyon hataları uyarı olarak loglanır, throw **etmez**
2. Net Profit hesabı quote-tabanlı `expectedOut` ile yapılır
3. Slippage aşımı da uyarı olarak loglanır
4. PM2 altında süreç stabil kalır, sürekli piyasa taraması yapılır

### Yapılandırma

| Env Değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `DIRECTION` | `JUP_TO_OKX` | Tarama yönü |
| `TRADE_AMOUNT_USDC` | `1` | Notional tutar (USDC). Her tick'te güncel env'den okunur |
| `SLOTS_PER_CHECK` | `4` | Kaç slot'ta bir quote/sim tetikleneceği |
| `API_COOLDOWN_MS` | `2000` | Ardışık API istekleri arası minimum bekleme (ms) |

---

## stream/slotDriver.ts

Solana WebSocket ile slot stream sürücüsü.

| Sınıf/Fonksiyon | Açıklama |
|---|---|
| `SlotDriver` | Solana `slotSubscribe` WS üzerinden slot olaylarını dinler |
| `start()` | WebSocket bağlantısını başlatır |
| `stop()` | Bağlantıyı kapatır |
| `onSlot(cb)` | Yeni slot geldiğinde callback çağırır |
