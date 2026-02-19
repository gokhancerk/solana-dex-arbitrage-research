# Market Type Classification & Telemetry System

## Overview

Bu sistem, arbitraj botuna üç kritik yetenek ekler:

1. **Market Type Classification** — Token çiftlerini likidite profiline göre Type A/B/C olarak sınıflandırır
2. **Latency Telemetry** — Her döngüde quote→build→send latency breakdown kaydeder
3. **Jito Bundle Telemetry** — Bundle gönderim/landing slot farkı ve MEV race analizi

Tüm değişiklikler **non-invasive**: mevcut execution pipeline'a dokunmaz, sadece veri toplar ve pre-trade filtre uygular.

---

## Market Type Model

### Type A — Deep & Hyper Competitive

| Metrik | Değer |
|--------|-------|
| `impact_3k` | < 0.2% |
| Likidite | Çok yüksek |
| Spread | Ultra düşük |
| MEV rekabeti | Extreme |

**Örnekler:** SOL/USDC, JUP/USDC

**Sonuç:** Sub-slot latency (~400ms) gerektirir. Mevcut slot-gated mimari bu marketlerde yapısal dezavantajlıdır. Sık unwind beklenir.

---

### Type B — Shallow Liquidity

| Metrik | Değer |
|--------|-------|
| `impact_3k` | > 1.2% |
| Slippage eğrisi | Nonlineer |
| Route segmentleri | ≥ 4 |
| Volume/Liquidity | < 0.05 |

**Örnekler:** Düşük hacimli tokenlar, fragmented pool'lar

**Sonuç:** Simülasyon kârı ≠ gerçek kâr. Self-price-impact nedeniyle yüksek unwind riski.

---

### Type C — Mid Liquidity Sweet Spot (TARGET)

| Metrik | Kabul Aralığı |
|--------|---------------|
| `impact_3k` | 0.2% – 1.0% |
| Volume/Liquidity | 0.05 – 1.0 |
| Route segmentleri | ≤ 3 |
| 24h Volume | ≥ $50,000 |
| Slippage curve ratio | impact_5k / impact_1k < 3 |

**Sadece Type C marketler live execution için uygundur.**

---

## Dosya Yapısı

```
src/
  marketFilter.ts      ← Type C market filter modülü (YENİ)
  types.ts             ← MarketClassification, LatencyMetrics, JitoBundleTelemetry (EKLENDİ)
  telemetry.ts         ← buildTelemetry yeni alanları destekler (GÜNCELLENDİ)
  stream/
    priceTicker.ts     ← Latency hook'ları + market filter gate (GÜNCELLENDİ)
```

---

## Impact Sampling

Her token çifti için Jupiter Quote API üzerinden üç farklı notional ile price impact ölçülür:

```
$1,000 → impact_1k
$3,000 → impact_3k   ← PRIMARY karar metriği
$5,000 → impact_5k
```

**Karar metriği `impact_3k`'dir** (impact_1k değil). Küçük miktarlarda impact düşük çıkabilir ama gerçek trade miktarında farklılık gösterir.

**Slippage curve ratio** = `impact_5k / impact_1k`. Bu oran 4'ü aşarsa likidite uçurumu (cliff) var demektir — reject edilir.

---

## Hard Reject Kuralları

Aşağıdakilerden **herhangi biri** sağlanırsa çift reddedilir:

| Kural | Eşik | Sebep |
|-------|------|-------|
| `impact_3k > 1.2%` | Shallow liquidity | Self-impact riski |
| `volume/liquidity < 0.05` | Düşük aktivite | Stale fiyat riski |
| `routeMarkets > 3` | Fragmented routing | Slippage birikimi |
| `24h volume < $50k` | Düşük hacim | Güvenilmez fiyatlama |
| `impact_5k / impact_1k > 4` | Liquidity cliff | Büyük trade'lerde ani slippage |
| `liquidity < $100k` | Yetersiz derinlik | Reliable execution garantisi yok |

---

## Kullanım

### Tek token sınıflandırma

```typescript
import { classifyMarket, isMarketEligible } from "./marketFilter.js";

// Detaylı sınıflandırma
const mc = await classifyMarket("WIF");
console.log(mc.type);       // "A" | "B" | "C" | "UNKNOWN"
console.log(mc.eligible);   // true = Type C, trade edilebilir
console.log(mc.impact3k);   // 0.45 (%)
console.log(mc.rejectReasons); // [] veya ["impact_3k=..."]

// Pre-trade gate (aynı fonksiyon, convenience wrapper)
const eligible = await isMarketEligible("SOL");
if (!eligible.eligible) {
  console.log("Skip — not Type C");
}
```

### Toplu sınıflandırma

```typescript
import { classifyAllScanTokens } from "./marketFilter.js";

const results = await classifyAllScanTokens();
for (const [token, mc] of results) {
  console.log(`${token}: Type ${mc.type} (eligible=${mc.eligible})`);
}
```

### Cache yönetimi

```typescript
import { getCachedClassification, clearMarketFilterCache } from "./marketFilter.js";

// Cache'den oku (type-based TTL: A=60s, C=30s, B=15s, UNKNOWN=10s)
const cached = getCachedClassification("JUP");

// Cache temizle (config değişikliğinde)
clearMarketFilterCache();
```

---

## PriceTicker Entegrasyonu

Market filter, PriceTicker'ın her tick'inde **ADIM 0.5** olarak çalışır:

```
ADIM 0   → Priority fee resolve
ADIM 0.5 → Market filter gate (Type C check)  ← YENİ
ADIM 1   → Quote fetch (iki yön paralel)
ADIM 2   → En iyi rota seçimi
ADIM 3   → Build + simulate
ADIM 4   → Live execution (Jito veya Sequential)
```

Type C olmayan tokenlar **ADIM 0.5'te** atlanır — quote API çağrısı bile yapılmaz. Classification type-based TTL ile cache'lenir (Type A: 60s, Type C: 30s, Type B: 15s, UNKNOWN: 10s), overhead < 5ms (cache hit).

### Detection Point

`detectSlot` ve `detectTimestamp` artık cycle başında değil, **viable fırsat (best route) seçildikten sonra** kaydedilir. Bu sayede D2S (detect-to-send) latency metriği gerçek fırsat tespiti anını yansıtır, yapay şişirme önlenir.

---

## Telemetry Schema v1

### Latency Metrics

Her trade cycle'ında kaydedilir:

```json
{
  "latencyMetrics": {
    "detectSlot": 245123456,
    "detectTimestamp": 1740000000000,
    "quoteLatencyMs": 342,
    "buildLatencyMs": 1205,
    "simulationLatencyMs": 1205,
    "detectToSendLatencyMs": 1890,
    "executionMode": "JITO",
    "quoteReceivedTimestamp": 1740000000342,
    "quoteToSendLatencyMs": 1548
  }
}
```

| Alan | Açıklama |
|------|----------|
| `detectSlot` | Fırsatın tespit edildiği Solana slot'u |
| `detectTimestamp` | Detection anının epoch ms timestamp'i (best route seçimi sonrası) |
| `quoteLatencyMs` | Her iki yönde quote fetch süresi |
| `buildLatencyMs` | TX build + simulate süresi |
| `simulationLatencyMs` | Simülasyon süresi (build içinde) |
| `detectToSendLatencyMs` | Tespit → gönderim arası toplam süre |
| `executionMode` | `"JITO"` veya `"SEQUENTIAL"` |
| `quoteReceivedTimestamp` | Quote yanıtının alındığı epoch ms |
| `quoteToSendLatencyMs` | Quote alımı → TX gönderim arası süre (stale quote riski) |

**Kritik eşik:** `detectToSendLatencyMs > 800ms` → Type A marketlerde MEV race kaybedilir. Console'da `[LATENCY-WARN]` uyarısı verilir.

### Jito Bundle Telemetry

Jito bundle kullanıldığında eklenir:

```json
{
  "jitoBundleTelemetry": {
    "bundleSendSlot": 245123456,
    "bundleSendTimestamp": 1740000001890,
    "bundleLandingSlot": 245123458,
    "bundleStatus": "LANDED",
    "bundleLatencyMs": 1200,
    "bundleInclusionDelaySlots": 2
  }
}
```

| Alan | Açıklama |
|------|----------|
| `bundleSendSlot` | Bundle gönderim anındaki slot |
| `bundleSendTimestamp` | Gönderim epoch ms |
| `bundleLandingSlot` | Landing slot (`null` = land etmedi) |
| `bundleStatus` | `"LANDED"` / `"FAILED"` / `"TIMEOUT"` |
| `bundleLatencyMs` | Gönderim → landing arası süre |
| `bundleInclusionDelaySlots` | Landing slot - send slot farkı |

**Kritik eşik:** `bundleInclusionDelaySlots > 1` → MEV race kaybediliyor. Console'da `[JITO-MEV]` uyarısı verilir.

### Market Classification

Trade anındaki market sınıflandırması:

```json
{
  "marketClassification": {
    "type": "C",
    "impact1k": 0.12,
    "impact3k": 0.45,
    "impact5k": 0.98,
    "routeMarkets": 2,
    "volume24h": 125000,
    "liquidity": 450000,
    "volumeLiquidityRatio": 0.278,
    "slippageCurveRatio": 8.17,
    "rejectReasons": [],
    "eligible": true
  }
}
```

### Profit Drift Telemetry

Her trade'de beklenen vs. gerçekleşen kâr karşılaştırması:

```json
{
  "expectedNetProfitUsdc": 0.42,
  "profitDriftUsdc": -0.15
}
```

| Alan | Açıklama |
|------|----------|
| `expectedNetProfitUsdc` | Quote anında hesaplanan tahmini net kâr (USDC) |
| `profitDriftUsdc` | `realizedPnlUsdc - expectedNetProfitUsdc` — negatif = spread kapandı / frontrun |

Bu veriler ile spread kapanması ve MEV frontrun arasında ayrım yapılabilir.

---

## JSONL Uyumluluğu

Tüm yeni alanlar **opsiyoneldir**. Mevcut `trades.jsonl` dosyasındaki eski kayıtlar sorunsuz parse edilir. Yeni kayıtlarda ek alanlar bulunur:

```jsonl
{"pair":"SOL/USDC","direction":"JUP_TO_OKX","success":true,"status":"JITO_BUNDLE_LANDED","latencyMetrics":{...},"jitoBundleTelemetry":{...},"marketClassification":{...},...}
```

`JITO_BUNDLE_LANDED` ve `JITO_BUNDLE_FAILED` statüleri artık persistable — `trades.jsonl`'e yazılır.

---

## Birdeye API (Opsiyonel)

Volume ve liquidity verileri için Birdeye API kullanılır. API key yoksa impact-based heuristic ile fallback yapılır.

```env
# .env dosyasına ekle (opsiyonel)
BIRDEYE_API_KEY=your_api_key_here
```

Birdeye olmadan sistem çalışır ama classification doğruluğu düşer (volume/liquidity tahmine dayalı olur).

---

## Latency Diagnostic Özetleri

Her tick sonunda console'a detaylı latency logu yazılır:

```
[LATENCY] Slot: 245123456 | Pair: SOL/USDC | E2E Cycle: 2340ms | Quote: 342ms | Build: 1205ms | D2S: 1890ms | Mode: JITO | Sonraki: WIF/USDC | Tokens: [SOL,WIF,JUP]
```

Eğer `detectToSendLatencyMs > 800ms`:

```
[LATENCY-WARN] detectToSend 1890ms > 800ms — Type A markets'ta MEV race kaybedilir. Pair: SOL/USDC
```

---

## Cache Stratejisi

Classification cache artık **type-based TTL** kullanır:

| Type | TTL | Sebep |
|------|-----|-------|
| Type A | 60s | Derin & stabil; sık değişmez |
| Type C | 30s | Sweet spot; makul yenileme |
| Type B | 15s | Volatile / shallow; hızlı değişim |
| UNKNOWN | 10s | Bilinmeyen; hızlı re-probe |

Önceki flat 60s TTL, volatile Type B tokenlar için stale classification riski yaratıyordu.

---

## Implementation Priority

| Faz | Durum | Açıklama |
|-----|-------|----------|
| Phase 1 | ✅ Tamamlandı | Telemetry instrumentation (latency + Jito metrics) |
| Phase 2 | ✅ Tamamlandı | Type C market filter (pre-trade gate) |
| Phase 3 | Gelecek | Execution optimization (Rust / parallel simulation) |

> **Kural:** Phase 3'e telemetri tamamlanmadan geçilmez. Önce veri toplanmalı, sonra optimize edilmelidir.
