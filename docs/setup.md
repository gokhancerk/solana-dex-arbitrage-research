# Kurulum ve Çalıştırma Rehberi

## Ön Koşullar

- **Node.js** ≥ 20 (nvm ile kurulum önerilir)
- **npm** ≥ 10
- Solana cüzdanı (keypair JSON dosyası)
- API anahtarları: Jupiter, OKX DEX, Helius (RPC)

> VPS'e kurulum için ayrıca bkz. [deployment.md](deployment.md)

## 1. Bağımlılıkları Kur

```bash
cd Arbitraj
npm install
```

## 2. Ortam Değişkenlerini Ayarla

`.env` dosyasını proje kök dizinine oluştur:

```dotenv
# ── Wallet ──────────────────────────────────────────────
WALLET_KEYPATH=.key/keypair.json

# ── RPC (Helius) ────────────────────────────────────────
HELIUS_API_KEY=<helius-api-key>
SOLANA_RPC_PRIMARY=https://mainnet.helius-rpc.com/?api-key=<helius-api-key>
SOLANA_RPC_BACKUP=https://mainnet.helius-rpc.com/?api-key=<helius-api-key>
SOLANA_WS_PRIMARY=wss://mainnet.helius-rpc.com/?api-key=<helius-api-key>
SOLANA_WS_BACKUP=wss://mainnet.helius-rpc.com/?api-key=<helius-api-key>
SOLANA_COMMITMENT=confirmed
PRIORITY_FEE_MICROLAMPORTS=10000

# ── Jupiter ─────────────────────────────────────────────
JUPITER_API_KEY=<jupiter-api-key>

# ── OKX DEX ─────────────────────────────────────────────
OKX_API_KEY=<okx-api-key>
OKX_API_SECRET=<okx-api-secret>
OKX_API_PASSPHRASE=<okx-api-passphrase>
OKX_API_PROJECT=<okx-project-id>
OKX_BASE_URL=https://www.okx.com

# ── Token Mint'leri (Mainnet — SOL/USDC) ────────────────
SOL_MINT=So11111111111111111111111111111111111111112
SOL_DECIMALS=9
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDC_DECIMALS=6

# ── Limitler ────────────────────────────────────────────
SLIPPAGE_BPS=20                   # 0.2% slippage cap
NOTIONAL_CAP_USD=1000             # Maks işlem tutarı (USDC)
MAX_RETRIES=3                     # TX gönderim yeniden deneme
CIRCUIT_BREAKER_THRESHOLD=3       # Ardışık hata eşiği
TRADE_AMOUNT_USDC=240             # İşlem başına tutar

# ── Net Profit & Throttle ───────────────────────────────
MIN_NET_PROFIT_USDC=0.05          # Minimum net kâr eşiği (USDC)
SOL_USDC_RATE=150                 # Fee hesabı için SOL/USDC kuru
API_COOLDOWN_MS=2000              # API istekleri arası bekleme (ms)

# ── Dashboard ───────────────────────────────────────────
DASHBOARD_PASSWORD=güçlü_şifre    # Boş bırakılırsa koruma devre dışı
API_PORT=3001                     # Express sunucu portu
```

> **ÖNEMLİ:** `.env` dosyasında `${VAR}` interpolasyonu desteklenmez. Tüm değerleri düz metin olarak yazın.

## 3. API Anahtarları Nasıl Alınır

| Servis | Adres | Not |
|---|---|---|
| Jupiter API Key | https://station.jup.ag/docs/apis/swap-api | Ücretsiz tier mevcut |
| OKX DEX API | https://web3.okx.com/build/dev-docs/wallet-api/env-setup | Proje oluştur + API key al |
| Helius RPC | https://helius.dev | Devnet/Mainnet RPC endpoint |

## 4. Keypair Dosyası

Keypair JSON dosyasını `.key/keypair.json` konumuna yerleştir:

```bash
# Yeni keypair oluşturmak için:
solana-keygen new --outfile .key/keypair.json --no-passphrase

# Mevcut base58 private key'i dönüştürmek için:
npm run convert-key
```

## 5. Komutlar

| Komut | Açıklama |
|---|---|
| `npm run build` | TypeScript tip kontrolü (noEmit) |
| `npm run start` | API sunucusu + PriceTicker (WebSocket slot-driven sim döngüsü) |
| `npm run server` | Sadece Express API + Dashboard sunucusu |
| `npm run dry-run` | Latency ölçümü + swap simülasyonu (canlı TX göndermez) |
| `npm run latency` | Detaylı RPC latency testi (10 round, karşılaştırma tablosu) |
| `npm run dashboard` | Dashboard dev server (Vite HMR) |
| `npm run dashboard:build` | Dashboard production build → `dashboard/dist/` |
| `npm run airdrop:devnet` | Devnet SOL airdrop |
| `npm run convert-key` | Keypair format dönüştürücü |

## 6. Deployment

Local veya VPS'te çalıştırmak için:

```bash
# 1) Dashboard build
npm run dashboard:build

# 2) Sunucuyu başlat (tek port: API + Dashboard)
npm run server

# VPS'te PM2 ile:
pm2 start ecosystem.config.cjs
```

Detaylı VPS kurulumu için bkz. [deployment.md](deployment.md)

## 7. Sorun Giderme

| Hata | Olası Sebep | Çözüm |
|---|---|---|
| `JUPITER_API_KEY env var is required` | API key eksik | `.env`'e `JUPITER_API_KEY` ekle |
| `Missing required env: USDT_MINT` | Token mint tanımsız | `.env`'de mint adreslerini kontrol et |
| `ERR_MODULE_NOT_FOUND` | Eski ts-node | `tsx` kullanıldığını doğrula |
| `getaddrinfo ENOTFOUND` | DNS/ağ sorunu | İnternet bağlantısını kontrol et |
| `401 Unauthorized` (Jupiter) | Geçersiz API key | Key'i yenile: https://station.jup.ag |
| `Route not found` (Jupiter) | Devnet'te rota yok | Mainnet'e geçiş gerekli veya geçerli token çifti kullan |
| `Circuit breaker tripped` | 3 ardışık TX hatası | Durumu kontrol et, süreci yeniden başlat |
