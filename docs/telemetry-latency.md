# Telemetri, Latency ve Gözlemlenebilirlik

## 1. Telemetri Sistemi

Her işlem (trade) sonunda `buildTelemetry()` fonksiyonu yapılandırılmış bir `Telemetry` nesnesi üretir. Kayıtlar `logs/trades.jsonl` dosyasına JSONL formatında yazılır ve Express API (`/api/logs`) üzerinden dashboard tarafından sorgulanır.

### Telemetri Alanları

| Alan | Tip | Açıklama |
|---|---|---|
| `pair` | `"SOL/USDC"` | İşlem çifti |
| `direction` | `Direction` | Arbitraj yönü |
| `simulatedAmountOut` | `string` | Simülasyonda beklenen çıktı (raw) |
| `realizedAmountOut` | `string?` | Gerçekleşen çıktı (canlı modda) |
| `effectiveSlippageBps` | `number?` | Efektif slippage (bps) |
| `success` | `boolean` | İşlem başarılı mı |
| `failReason` | `string?` | Başarısızlık sebebi |
| `txSignatures` | `string[]` | TX imzaları |
| `timestamp` | `string` | ISO 8601 UTC |
| `retries` | `number` | Yeniden deneme sayısı |
| `profitLabel` | `"profit" \| "loss" \| "flat"` | P/L sınıflandırma |
| `netProfitUsdc` | `number` | Fee sonrası net kâr/zarar (USDC) |
| `grossProfitUsdc` | `number` | Fee öncesi brüt kâr (USDC) |
| `feeUsdc` | `number` | Tahmini ağ ücreti (USDC) |
| `status` | `TelemetryStatus` | Makine-okunabilir durum etiketi |

### Kullanım Örneği

```typescript
import { buildTelemetry, appendTradeLog } from "./telemetry.js";

const telemetry = buildTelemetry({
  build: buildResult,
  direction: "JUP_TO_OKX",
  success: true,
  status: "SIMULATION_SUCCESS",
  netProfit: { grossProfitUsdc: 0.12, feeUsdc: 0.03, netProfitUsdc: 0.09 },
});
await appendTradeLog(telemetry);
```

### Örnek Çıktı

```json
{
  "pair": "SOL/USDC",
  "direction": "JUP_TO_OKX",
  "simulatedAmountOut": "50234000",
  "realizedAmountOut": "50180000",
  "effectiveSlippageBps": 11,
  "success": true,
  "txSignatures": ["5xF3...abc"],
  "timestamp": "2026-02-17T09:46:45.000Z",
  "retries": 0,
  "profitLabel": "profit",
  "netProfitUsdc": 0.09,
  "grossProfitUsdc": 0.12,
  "feeUsdc": 0.03,
  "status": "SIMULATION_SUCCESS"
}
```

### TelemetryStatus Değerleri

| Status | Açıklama | Dosyaya Yazılır? |
|---|---|---|
| `SIMULATION_SUCCESS` | Simülasyon başarılı | ✅ Evet |
| `REJECTED_LOW_PROFIT` | Net kâr eşiğin altında | ✅ Evet |
| `SIMULATION_FAILED` | Simülasyon hatası | ❌ Sadece console.warn |
| `SLIPPAGE_EXCEEDED` | Slippage aşımı | ❌ Sadece console.warn |
| `SEND_FAILED` | TX gönderim hatası | ❌ Sadece console.warn |
| `LIMIT_BREACH` | Notional limit aşımı | ❌ Sadece console.warn |
| `QUOTE_ERROR` | Quote alınamadı | ❌ Sadece console.warn |
| `UNKNOWN_ERROR` | Bilinmeyen hata | ❌ Sadece console.warn |

> **Not:** Sadece `SIMULATION_SUCCESS` ve `REJECTED_LOW_PROFIT` status'ları `logs/trades.jsonl` dosyasına yazılır. Diğerleri I/O yükünü azaltmak için `console.warn` üzerinden loglanır.

### JSONL Dosyası ve API

Telemetri kayıtları `logs/trades.jsonl` dosyasına satır satır eklenir (append-only). Express API bu dosyayı parse edip JSON dizisi olarak sunar:

```
GET /api/logs  →  Authorization: Bearer <DASHBOARD_PASSWORD>
→ 200 OK  [
    { pair, direction, netProfitUsdc, status, timestamp, ... },
    ...
  ]
```

---

## 2. Latency Ölçüm Sistemi

RPC endpoint'lerinin tepki süresini ölçmek için `latency.ts` modülü kullanılır. Devnet veya mainnet'te çalışır.

### Ölçülen Metrikler

| Metrik | Açıklama |
|---|---|
| **Avg** | Tüm başarılı çağrıların ortalaması |
| **Min / Max** | En hızlı / en yavaş çağrı |
| **Median** | Ortanca değer (P50) |
| **P95** | 95. yüzdelik dilim |
| **Başarı Oranı** | Başarılı/toplam çağrı yüzdesi |

### Test Edilen RPC Metodları

| Metod | Ağırlık | Neden |
|---|---|---|
| `getLatestBlockhash` | Kritik | Her TX öncesi çağrılır |
| `getSlot` | Yüksek | Slot takibi ve simülasyon context'i |
| `getBlockHeight` | Orta | TX geçerlilik kontrolü |
| `getEpochInfo` | Düşük | Epoch bilgisi |
| `getHealth` | Düşük | RPC sağlık kontrolü |
| `getBalance` | Yüksek | Bakiye doğrulama |

### Bağımsız Test

```bash
# Varsayılan: 10 round, 150ms delay
npm run latency

# Özelleştirilmiş:
LATENCY_ROUNDS=20 LATENCY_DELAY_MS=100 npm run latency
```

### Örnek Çıktı

```
╔══════════════════════════════════════════════════════════╗
║  RPC Latency Report: primary                            ║
╠══════════════════════════════════════════════════════════╣
║  URL      : https://devnet.helius-rpc.com/?api-key=...  ║
║  Probes   : 30                                          ║
║  Success  : 100%                                        ║
╠──────────────────────────────────────────────────────────╣
║  Avg      : 265 ms                                      ║
║  Min      : 57 ms                                       ║
║  Max      : 890 ms                                      ║
║  Median   : 226 ms                                      ║
║  P95      : 433 ms                                      ║
╚══════════════════════════════════════════════════════════╝
  getLatestBlockhash        avg=376ms  min=180ms  max=890ms
  getSlot                   avg=288ms  min=187ms  max=362ms
  getBlockHeight            avg=247ms  min=184ms  max=290ms
  getEpochInfo              avg=275ms  min=193ms  max=420ms
  getHealth                 avg=74ms   min=57ms   max=94ms
  getBalance                avg=331ms  min=209ms  max=433ms
```

### Karşılaştırma Tablosu (latencyTest.ts)

`npm run latency` komutu, konfigüre edilmiş endpoint'leri public devnet ile karşılaştırır:

```
┌────────────────────┬────────┬────────┬────────┬────────┬─────────┐
│ Endpoint           │ Avg ms │ Min ms │ Max ms │ P95 ms │ Success │
├────────────────────┼────────┼────────┼────────┼────────┼─────────┤
│ primary            │    265 │     57 │    890 │    433 │   100%  │
│ public-devnet      │    412 │    105 │   1200 │    980 │    98%  │
└────────────────────┴────────┴────────┴────────┴────────┴─────────┘
```

---

## 3. Hata Tipleri ve Gözlemlenebilirlik

### Hata Akış Şeması

```
İşlem Başlangıcı
    │
    ├─ Notional > 200 USDT? ──► LimitBreachError
    │
    ├─ Quote alınamadı? ──────► QuoteError (fetch hatası)
    │
    ├─ Simülasyon başarısız? ──► SimulationError
    │
    ├─ Slippage > 0.2%? ──────► SlippageError
    │
    ├─ TX gönderilemedi? ──────► SendError (3 deneme sonrası)
    │
    └─ 3 ardışık fail? ───────► SendError + circuit breaker flag
```

### Yapılandırılmış Log Formatı

Tüm loglar JSON uyumlu olarak tasarlanmıştır:

```typescript
// Başarılı işlem logu
{
  event: "trade_complete",
  direction: "JUP_TO_OKX",
  notional: 50,
  simulatedOut: "50234000",
  slippageBps: 11,
  signature: "5xF3...abc",
  durationMs: 2340,
  timestamp: "2026-02-16T16:37:00Z"
}

// Hata logu
{
  event: "trade_failed",
  direction: "JUP_TO_OKX",
  errorType: "SlippageError",
  message: "Effective slippage 35bps exceeds cap 20",
  retries: 0,
  timestamp: "2026-02-16T16:37:00Z"
}
```

---

## 4. dry-run Modunun Çıktısı

`npm run dry-run` komutu sırasıyla:

1. **Latency raporu** — tüm RPC endpoint'leri için (yukarıdaki format)
2. **Swap simülasyonu** — her bacak için:
   - `venue` (JUPITER / OKX)
   - `expectedOut` (beklenen çıktı)
   - `simulatedOut` (simüle edilen çıktı)
   - `slippageBps` (efektif slippage)
   - Simülasyon hatası (varsa)

Devnet'te swap rotaları bulunamadığında zarif bir uyarı verilir:
```
Swap dry-run atlandı (devnet'te beklenir): Jupiter quote failed: 404 Not Found – Route not found
```
