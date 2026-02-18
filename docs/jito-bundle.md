# Jito Bundle Entegrasyonu

## Genel Bakış

Jito Bundle entegrasyonu, 2-leg arbitraj işlemlerinin (Leg1 + Leg2) aynı Solana blokunda atomik olarak çalışmasını sağlar. Sequential (sıralı) çalışma yerine her iki bacak tek bundle'da gönderilir.

### Sequential vs Jito Bundle

| Özellik | Sequential | Jito Bundle |
|---|---|---|
| Çalışma | Leg1 → confirm → Leg2 | Leg1 + Leg2 aynı blokta |
| Toplam süre | ~12-15 saniye | ~2-4 saniye |
| Fiyat kayması riski | Yüksek (2. quote stale olabilir) | Çok düşük (aynı an) |
| Emergency unwind | Sık gerekli | Çok nadir |
| MEV koruması | Yok | Tip ile önceliklendirme |

## Ortam Değişkenleri (.env)

```env
# Jito Bundle aktif et
USE_JITO_BUNDLE=true

# Jito Block Engine URL (opsiyonel, varsayılan: mainnet)
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf

# Jito tip miktarı (lamports) — validatöre ödenen ücret
# 10,000 = 0.00001 SOL ≈ $0.0015
JITO_TIP_LAMPORTS=10000
```

### Block Engine URL Alternatifleri

Gecikmeye göre en yakın bölgeyi seçin:

| Bölge | URL |
|---|---|
| Global (varsayılan) | `https://mainnet.block-engine.jito.wtf` |
| Amsterdam | `https://amsterdam.mainnet.block-engine.jito.wtf` |
| Frankfurt | `https://frankfurt.mainnet.block-engine.jito.wtf` |
| New York | `https://ny.mainnet.block-engine.jito.wtf` |
| Tokyo | `https://tokyo.mainnet.block-engine.jito.wtf` |

## Mimari

### Akış (Jito Bundle Aktif)

```
1. estimateDirectionProfit (her iki yön, PARALEL)
2. Spread buffer filtresi (1.5x)
3. buildAndSimulate (kazanan yön — Leg1 + Leg2 TX oluştur)
4. prepareAtomicBundle:
   a. Ortak blockhash al
   b. Tüm TX'lerin blockhash'ini eşitle
   c. Tip TX oluştur (SOL transfer → Jito tip hesabı)
   d. Tüm TX'leri imzala
5. sendJitoBundle → Block Engine'e gönder
6. waitForBundleLanding → 30s polling
7. Sonuç:
   ✓ Landed → Her iki TX aynı blokta başarılı
   ✗ Failed → Hiçbir TX zincirde değil (temiz başarısızlık)
   ⚠ Leg1Only → Emergency unwind (çok nadir)
```

### Dosya Yapısı

```
src/
├── jito.ts             # Jito Block Engine API, tip TX, bundle hazırlama
├── config.ts           # AppConfig.useJitoBundle, jitoBlockEngineUrl, jitoTipLamports
├── types.ts            # TelemetryStatus += JITO_BUNDLE_LANDED | JITO_BUNDLE_FAILED
├── execution.ts        # executeAtomicArbitrage() — build + bundle + verify
└── stream/
    └── priceTicker.ts  # if(useJito) → atomik path | else → sequential path
```

## Kullanım Örnekleri

### 1. Atomik Bundle Çalıştırma (execution.ts)

```typescript
import { buildAndSimulate, executeAtomicArbitrage } from "./execution.js";
import { getKeypairFromEnv } from "./wallet.js";

const signer = getKeypairFromEnv();

// 1. Her iki bacağı oluştur
const result = await buildAndSimulate({
  direction: "JUP_TO_OKX",
  notionalUsd: 500,
  owner: signer.publicKey,
  targetToken: "SOL",
});

// 2. Atomik bundle ile gönder
const atomicResult = await executeAtomicArbitrage({
  buildResult: result,
  signer,
  targetToken: "SOL",
});

if (atomicResult.success) {
  console.log("Bundle landed!", atomicResult.signatures);
} else if (atomicResult.leg1OnChainButLeg2Failed) {
  console.warn("Emergency unwind needed!");
} else {
  console.log("Clean failure, no risk:", atomicResult.failReason);
}
```

### 2. Low-Level Bundle API (jito.ts)

```typescript
import {
  prepareAtomicBundle,
  sendJitoBundle,
  waitForBundleLanding,
} from "./jito.js";

// İki TX'i bundle'a hazırla
const bundle = await prepareAtomicBundle({
  leg1Tx: jupiterSwapTx,
  leg2Tx: okxSwapTx,
  signer: keypair,
  tipLamports: 10_000,
});

// Bundle gönder
const bundleId = await sendJitoBundle(bundle.signedTxs);

// Landing bekle
const landing = await waitForBundleLanding(bundleId, 30_000);
console.log(landing.success ? "Landed!" : `Failed: ${landing.failReason}`);
```

## Telemetri

Her bundle sonucu yapısal telemetri kaydı oluşturur:

```jsonc
{
  "pair": "SOL/USDC",
  "direction": "JUP_TO_OKX",
  "status": "JITO_BUNDLE_LANDED",    // veya "JITO_BUNDLE_FAILED"
  "txSignatures": ["sig1...", "sig2...", "tipSig..."],
  "netProfitUsdc": 0.18,
  "realizedPnl": {
    "deltaUsdc": 0.19,
    "deltaSol": 0.000025,
    "realizedNetProfitUsdc": 0.186
  },
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

## Tip Stratejisi

| Senaryo | Tip (lamports) | Maliyet (USD) | Açıklama |
|---|---|---|---|
| Düşük öncelik | 1,000 | ~$0.00015 | Yoğun olmayan saatler |
| Orta (varsayılan) | 10,000 | ~$0.0015 | Normal operasyon |
| Yüksek öncelik | 50,000 | ~$0.0075 | Rekabetçi fırsatlar |
| Agresif | 100,000 | ~$0.015 | Acil arbitraj |

SOL fiyatı $150 baz alındı. Tip miktarı minimum net kâr eşiğinin ($0.12) küçük bir yüzdesidir.

## Hata Senaryoları

| Durum | Eylem |
|---|---|
| Bundle Landed ✓ | Başarı — her iki TX aynı blokta |
| Bundle Failed | Temiz — hiçbir TX zincirde değil |
| Bundle Timeout | On-chain doğrulama → genellikle temiz |
| Leg1 on-chain, Leg2 yok | Emergency unwind tetiklenir (çok nadir) |
| Block Engine ulaşılamaz | Jito error → sequential fallback (opsiyonel) |
