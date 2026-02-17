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
| `DEFAULT_NOTIONAL_CAP` | `number` | Varsayılan işlem limiti: 200 USDT |
| `DEFAULT_MAX_RETRIES` | `number` | Varsayılan yeniden deneme: 3 |
| `DEFAULT_CIRCUIT_BREAKER` | `number` | Circuit breaker eşiği: 3 |

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
| `BuildSimulateResult` | Tüm bacaklar + quote meta |
| `SendAttempt` | Tek gönderim denemesi bilgisi |
| `SendResult` | Gönderim sonucu: başarı, imza, denemeler |
| `Telemetry` | Yapılandırılmış telemetri nesnesi |

### Hata Sınıfları

| Sınıf | Ne Zaman Atılır |
|---|---|
| `LimitBreachError` | Notional cap (200 USDT) aşıldığında |
| `QuoteError` | Quote API'den yanıt alınamadığında |
| `SlippageError` | Slippage %0.2 eşiğini aştığında |
| `SimulationError` | TX simülasyonu başarısız olduğunda |
| `SendError` | TX gönderimi tüm denemelerde başarısız olduğunda |

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

Orchestration: build → simulate → send döngüsü.

| Fonksiyon | İmza | Açıklama |
|---|---|---|
| `buildAndSimulate()` | `({ direction, notionalUsd, owner }) → Promise<BuildSimulateResult>` | İki bacağı oluştur + simüle et |
| `sendWithRetry()` | `(tx, signer, commitment?) → Promise<SendResult>` | Üssel backoff ile TX gönder |

### buildAndSimulate() Akışı
1. Notional cap kontrolü (≤ 200 USDT)
2. Yöne göre sırasıyla quote al (Jupiter/OKX)
3. Her quote için swap TX oluştur
4. Her TX'i simüle et
5. Simülasyondan çıktı tutarı ve efektif slippage hesapla
6. Slippage cap kontrolü (≤ 20 bps)
7. Simülasyon hatası kontrolü
8. `BuildSimulateResult` döndür

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
  pair: "JUP/USDT",
  direction: "JUP_TO_OKX" | "OKX_TO_JUP",
  simulatedAmountOut: string,
  realizedAmountOut?: string,
  effectiveSlippageBps?: number,
  success: boolean,
  failReason?: string,
  txSignatures: string[],
  timestamp: string,       // ISO 8601 UTC
  retries: number,
  profitLabel: "profit" | "loss" | "flat"
}
```

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
