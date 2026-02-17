# SOL/USDC Arbitraj Çifti Geçişi

## Sorun

Jupiter API'nin `swap/v1` endpointi yalnızca sınırlı bir token setini destekliyor. Önceki çift olan **JUP/USDT** artık kullanılamaz durumda:

| Token | Jupiter swap/v1 |
|-------|----------------|
| SOL   | ✅ Tradable     |
| USDC  | ✅ Tradable     |
| USDT  | ❌ Not tradable |
| JUP   | ❌ Not tradable |

## Çözüm

Arbitraj çifti **SOL/USDC** olarak değiştirildi.

### Yön Açıklamaları

| Direction     | Leg 1                    | Leg 2                  |
|---------------|--------------------------|------------------------|
| `JUP_TO_OKX`  | Jupiter: USDC → SOL      | OKX: SOL → USDC        |
| `OKX_TO_JUP`  | OKX: USDC → SOL          | Jupiter: SOL → USDC    |

### Token Mint Adresleri (Mainnet)

| Token | Mint Adresi | Decimals |
|-------|-------------|----------|
| SOL   | `So11111111111111111111111111111111111111112` | 9 |
| USDC  | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |

## Değiştirilen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `.env` | `USDT_MINT`/`JUP_MINT` → `SOL_MINT`/`USDC_MINT` |
| `src/config.ts` | Token tanımları `SOL` + `USDC`, `PublicKey` importu kaldırıldı |
| `src/jupiter.ts` | API URL: `swap/v6/*` → `swap/v1/quote` ve `swap/v1/swap` |
| `src/types.ts` | `Telemetry.pair` → `"SOL/USDC"` |
| `src/execution.ts` | `usdtMint`/`jupMint` → `usdcMint`/`solMint` |
| `src/tokens.ts` | `getMintInfo` symbol tipi → `"USDC" \| "SOL"` |
| `src/telemetry.ts` | Pair → `"SOL/USDC"` |
| `src/dryRun.ts` | Varsayılan notional: 1 USDC (test) |

## Jupiter API URL Geçmişi

| URL | Durum |
|-----|-------|
| `api.jup.ag/swap/v6/quote` | ❌ 404 (eski, kapatılmış) |
| `quote-api.jup.ag/v6/quote` | ❌ DNS çözülemiyor |
| `api.jup.ag/v6/quote` | ❌ 404 Route not found |
| `lite-api.jup.ag/v6/quote` | ❌ 404 Route not found |
| **`api.jup.ag/swap/v1/quote`** | ✅ 200 (aktif, API key gerekli) |
| **`api.jup.ag/swap/v1/swap`** | ✅ 200 (aktif, API key gerekli) |

## Doğrulama

```
Jupiter Leg (USDC→SOL): ✅ Quote alındı, TX oluşturuldu, simülasyon geçti
OKX Leg (SOL→USDC):     ✅ Quote alındı, TX oluşturuldu (v6 API düzeltmesi tamamlandı)
```

> OKX API düzeltme detayları: [docs/okx-api-fix.md](okx-api-fix.md)

## .env Örnek Yapılandırma

```env
SOL_MINT=So11111111111111111111111111111111111111112
SOL_DECIMALS=9
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDC_DECIMALS=6
```
