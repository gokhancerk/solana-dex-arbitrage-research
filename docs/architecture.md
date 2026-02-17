# Mimari Genel Bakış

## Sistem Amacı

Jupiter (jup.ag) ve OKX DEX arasında **SOL/USDC** paritesinde fiyat farklarından kâr elde eden bir arbitraj botu. Solana mainnet-beta üzerinde çalışır. React tabanlı bir monitoring dashboard'u ve Express API sunucusu içerir. Tüm bileşenler tek bir port (3001) üzerinden sunulur.

## Üst Düzey Akış

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐
│  Jupiter API │◄───►│              │◄───►│   OKX DEX API │
│  (quote/swap)│     │  Orchestrator│     │  (quote/swap) │
└──────────────┘     │  (execution) │     └───────────────┘
                     │              │
                     │  ┌────────┐  │
                     │  │ Wallet │  │
                     │  │ Signer │  │
                     │  └────────┘  │
                     │              │
                     │  ┌────────┐  │
                     │  │ Solana │  │
                     │  │  RPC   │  │
                     │  └────────┘  │
                     └──────────────┘
                            │
                     ┌──────┴──────┐
                     │  Telemetry  │
                     │  & Latency  │
                     └─────────────┘
```

## İki Yönlü Arbitraj Akışı

### Yön 1: `JUP_TO_OKX`
1. USDC → SOL swap (Jupiter üzerinden)
2. SOL → USDC swap (OKX DEX üzerinden)
3. Net USDC farkı = kâr/zarar

### Yön 2: `OKX_TO_JUP`
1. USDC → SOL swap (OKX DEX üzerinden)
2. SOL → USDC swap (Jupiter üzerinden)
3. Net USDC farkı = kâr/zarar

## Net Profit Hesaplama Akışı

Her `buildAndSimulate()` çağrısında iki bacak tamamlandıktan sonra:

```
inputRaw = toRaw(notionalUsd, 6)        // Başlangıç USDC (raw bigint)
         │
Leg 1:   USDC → SOL  (quote: expectedOut = SOL lamport)
         │
Leg 2:   SOL → USDC  (quote: expectedOut = USDC raw)
         │
grossProfitRaw  = leg2.expectedOut − inputRaw
grossProfitUsdc = grossProfitRaw / 10^6
         │
feeSol  = (BASE_FEE + priorityFee × CU) × legCount / 1e9
feeUsdc = feeSol × solUsdcRate
         │
netProfitUsdc = grossProfitUsdc − feeUsdc
         │
         ├── ≥ minNetProfitUsdc  →  İşlem ONAYLANDI
         └── < minNetProfitUsdc  →  NetProfitRejectedError
```

### Örnek Hesaplama (240 USDC, JUP_TO_OKX)

| Adım | Değer |
|---|---|
| inputRaw | 240,000,000 (240 USDC) |
| Leg 1 (Jupiter USDC→SOL) | expectedOut = 2,832,716,434 lamports (~2.83 SOL) |
| Leg 2 (OKX SOL→USDC) | expectedOut = 240,192,647 (~240.19 USDC) |
| grossProfitRaw | 192,647 |
| grossProfitUsdc | +0.192647 USDC |
| feeUsdc | −0.002100 USDC (2 TX × 5000 lamports base + priority) |
| **netProfitUsdc** | **+0.190547 USDC → ONAYLANDI** |

## Güvenlik Katmanları

| Katman | Mekanizma | Değer |
|---|---|---|
| Slippage Cap | Simülasyonda kontrol | ≤ 0.2% (20 bps) |
| Notional Cap | İşlem öncesi kontrol | ≤ 200 USDT |
| Simülasyon | TX gönderiminden önce zorunlu | Her TX |
| **Net Profit Gate** | **Brüt kâr − tahmini fee ≥ eşik** | **≥ 0.05 USDC (yapılandırılabilir)** |
| Retry + Backoff | Üssel geri çekilme | Maks 3 deneme |
| Circuit Breaker | Ardışık başarısız gönderim | 3 → durdur |
| Priority Fee | MEV koruması | Ayarlanabilir |
| DryRun Modu | Simülasyon hataları uyarı olarak loglanır | PriceTicker daima `dryRun: true` |

## Dosya Yapısı

```
src/
├── config.ts          # Ortam değişkenleri ve uygulama ayarları
├── types.ts           # Paylaşılan tip tanımları ve hata sınıfları
├── solana.ts          # RPC bağlantısı, simülasyon, TX gönderimi
├── wallet.ts          # Keypair yükleme
├── tokens.ts          # Token mint/decimal yardımcıları
├── jupiter.ts         # Jupiter API: quote, swap build, simülasyon
├── okxDex.ts          # OKX DEX API: quote, swap build, simülasyon
├── execution.ts       # buildAndSimulate(), net profit gate, sendWithRetry()
├── telemetry.ts       # Telemetri: buildTelemetry(), JSONL logging
├── server.ts          # Express API + Dashboard static serving
├── start.ts           # Birleşik entrypoint: API + PriceTicker
├── latency.ts         # RPC latency ölçüm modülü
├── fees.ts            # Priority fee öneri mekanizması
├── dryRun.ts          # Dry-run giriş noktası
├── airdrop.ts         # Devnet airdrop yardımcısı
├── scripts/
│   ├── convertKey.ts    # Keypair format dönüştürücü
│   └── latencyTest.ts   # Bağımsız latency test scripti
└── stream/
    ├── priceTicker.ts   # Event-driven sim döngüsü (slot tabanlı)
    └── slotDriver.ts    # WebSocket slot stream sürücüsü

dashboard/               # React monitoring dashboard
├── src/
│   ├── App.tsx          # Ana uygulama (auth gate + layout)
│   ├── components/
│   │   ├── LoginScreen.tsx   # Şifre giriş ekranı
│   │   ├── TradesTable.tsx   # İşlem tablosu (filtrelenebilir)
│   │   ├── StatsCards.tsx    # Özet metrik kartları
│   │   └── SpreadChart.tsx   # Spread grafiği (recharts)
│   └── hooks/
│       ├── useAuth.ts        # Auth state yönetimi
│       └── useTradeLogs.ts   # API polling hook
└── dist/                # Production build çıktısı (express.static)

ecosystem.config.cjs     # PM2 süreç yapılandırması
```

## Veri Akışı

```
.env → loadConfig() → AppConfig nesnesi
                            │
         ┌──────────────────┴──────────────────┐
         ▼                                     ▼
   fetchJupiterQuote()                  fetchOkxQuote()
         │                                     │
         ▼                                     ▼
   buildJupiterSwap()                   buildOkxSwap()
         │                                     │
         └──────────────┬──────────────────────┘
                        ▼
               buildAndSimulate()
                        │
                        ▼
              simulateTx() [her leg için]
                        │
                        ▼
              Slippage kontrolü (≤ 20 bps)
                        │
                        ▼
              Net Profit Gate
              (brüt kâr − fee ≥ minNetProfitUsdc?)
                    │           │
               ONAYLANDI    REDDEDİLDİ
                    │           │
                    ▼           ▼
              sendWithRetry()  Telemetri kaydet
              [canlı mod]     + NetProfitRejectedError
                    │
                    ▼
              buildTelemetry() → JSON çıktı
```

## Tek Port Mimarisi

Frontend ve backend tek bir Express sunucusu üzerinden (port 3001) sunulur:

```
:3001
├── /api/logs          → Express API (JSONL parse, JSON response)
├── /api/*             → Auth middleware (Bearer token)
├── /assets/*          → express.static (dashboard/dist)
└── /*                 → Catch-all → index.html (React SPA routing)
```

## Teknoloji Yığını

| Bileşen | Teknoloji |
|---|---|
| Runtime | Node.js 20+ |
| Dil | TypeScript (ES2022, NodeNext) |
| Blockchain | Solana (mainnet-beta) |
| SDK | @solana/web3.js ^1.95 |
| DEX 1 | Jupiter Aggregator API v6 |
| DEX 2 | OKX DEX Aggregator API v6 |
| Backend | Express 5, CORS |
| Frontend | React 19, Vite, Tailwind CSS, shadcn/ui, recharts |
| Çevre Değişkenleri | dotenv |
| WS Desteği | ws ^8.18 |
| TS Runner | tsx |
| Süreç Yönetimi | PM2 |
