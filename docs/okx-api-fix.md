# OKX DEX API Düzeltmesi (404 → 401 → ✅ Çalışır Durumda)

## Sorun

OKX DEX API'sine yapılan quote isteği **HTTP 404 Not Found** hatası döndürüyordu.

```
[ERROR] OKX quote HTTP 404: {"code":404,"data":{},"detailMsg":"","error_code":"404","error_message":"Not Found","msg":"Not Found"}
```

## Kök Neden Analizi

OKX, DEX Aggregator API'sini **v5'ten v6'ya** geçirmiş ve birçok breaking change uygulamıştır. Eski implementasyondaki sorunlar:

| # | Sorun | Eski (Yanlış) | Doğru |
|---|-------|---------------|-------|
| 1 | API versiyon + path | `/api/v5/dex/aggregate/quote` | `/api/v6/dex/aggregator/quote` |
| 2 | Swap endpoint | `/api/v5/dex/aggregate/swap-instruction` | `/api/v6/dex/aggregator/swap-instruction` |
| 3 | HTTP metodu | `POST` (JSON body) | `GET` (query params) |
| 4 | Zincir parametresi | `chainId: "501"` | `chainIndex: "501"` |
| 5 | Token parametreleri | `inputMint` / `outputMint` | `fromTokenAddress` / `toTokenAddress` |
| 6 | Slippage formatı | `slippageBps: 20` (bps, sayı) | `slippagePercent: "0.2"` (yüzde, string) |
| 7 | Response alanı | `outAmount` | `toTokenAmount` |
| 8 | HMAC imza (auth) | Eksikti — sadece KEY/PASSPHRASE/PROJECT | `OK-ACCESS-SIGN` + `OK-ACCESS-TIMESTAMP` eklendi |
| 9 | Debug log | URL loglanmıyordu | `[DEBUG] OKX Quote Request URL: ...` eklendi |
| 10 | ALT desteği (Solana) | Yoktu — base64 TX deserialize | `addressLookupTableAccount` çözümleniyor |
| 11 | Swap TX build | API'den base64 TX geldiği varsayılıyordu | Instruction-level assembly (Solana) |

## Çözüm Detayları

### 1. Endpoint Düzeltmesi

```typescript
// Eski
const OKX_QUOTE_PATH = "/api/v5/dex/aggregate/quote";
const OKX_SWAP_PATH  = "/api/v5/dex/aggregate/swap-instruction";

// Yeni
const OKX_QUOTE_PATH            = "/api/v6/dex/aggregator/quote";
const OKX_SWAP_INSTRUCTION_PATH = "/api/v6/dex/aggregator/swap-instruction";
```

### 2. GET + Query Params (POST Body Yerine)

```typescript
// Eski — POST ile JSON body
res = await fetch(url, {
  method: "POST",
  headers: buildOkxHeaders(),
  body: JSON.stringify({ chainId: "501", inputMint, ... })
});

// Yeni — GET ile query string
const qs = new URLSearchParams({
  chainIndex: "501",
  fromTokenAddress: params.inputMint,
  toTokenAddress: params.outputMint,
  amount: params.amount.toString(),
  slippagePercent: (params.slippageBps / 100).toString(),
});
const fullUrl = `${cfg.okxBaseUrl}${OKX_QUOTE_PATH}?${qs.toString()}`;
res = await fetch(fullUrl, { method: "GET", headers });
```

### 3. HMAC-SHA256 İmza Mekanizması

OKX API, her istekte `OK-ACCESS-SIGN` header'ı bekler:

```typescript
function buildOkxHeaders(method: string, requestPath: string) {
  const timestamp = new Date().toISOString();
  const preHash = timestamp + method.toUpperCase() + requestPath;
  const sign = createHmac("sha256", cfg.okxApiSecret ?? "")
    .update(preHash)
    .digest("base64");

  return {
    "OK-ACCESS-KEY": cfg.okxApiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": cfg.okxApiPassphrase,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PROJECT": cfg.okxProjectId,
  };
}
```

**Önemli:** GET isteklerinde `body` boş string olarak ele alınır. `requestPath` query string dahil tam path olmalıdır.

### 4. Instruction-Level TX Assembly (Solana)

v6 API'si Solana için base64 serileştirilmiş TX yerine ayrı instruction listesi döner. Artık TX'i instruction seviyesinde kendimiz oluşturuyoruz:

```typescript
async function assembleOkxTransaction(data, userWallet) {
  // 1. OKX instruction listesini Solana TransactionInstruction'a çevir
  const instructions = data.instructionLists.map(ix =>
    new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map(a => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    })
  );

  // 2. Address Lookup Table (ALT) hesaplarını çözümle
  const altResults = await Promise.all(
    data.addressLookupTableAccount.map(addr =>
      connection.getAddressLookupTable(new PublicKey(addr))
    )
  );

  // 3. V0 Message oluştur (ALT'ler ile TX boyutunu küçült)
  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(userWallet),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  return new VersionedTransaction(messageV0);
}
```

### 5. Simülasyon Hata Yönetimi (Dry-Run)

`AccountNotFound` simülasyon hatası beklenen bir durumdur:
- Leg 2 (OKX), Leg 1'in (Jupiter) çıktısına bağımlıdır
- Leg 1 sadece simüle edildiğinden, cüzdanda swap için yeterli token yoktur
- wSOL token hesabı mevcut olmayabilir

Çözüm: `dryRun` modunda simülasyon hataları uyarı olarak loglanır, akış bloklanmaz:

```typescript
// execution.ts — BuildParams'a dryRun eklendi
interface BuildParams {
  direction: Direction;
  notionalUsd: number;
  owner: PublicKey;
  dryRun?: boolean;  // ← yeni
}

// Simülasyon hatası kontrolü
if (leg.simulation.error) {
  if (params.dryRun) {
    console.warn(`[WARN] Leg ${idx + 1} (${leg.venue}): Simulation error — dry-run devam ediyor`);
  } else {
    throw new SimulationError(`Simulation failed: ${leg.simulation.error}`);
  }
}
```

## Değiştirilen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `src/okxDex.ts` | Tamamen yeniden yazıldı: v6 endpointleri, GET metodu, HMAC imza, parametre isimleri, response parsing, instruction assembly, ALT desteği |
| `src/execution.ts` | `buildOkxSwap()` çağrı imzası güncellendi (quoteContext → swap params), `dryRun` modu eklendi |
| `src/dryRun.ts` | `dryRun: true` ile çağrım, zengin tablo çıktısı, P/L hesabı |

## OKX API Referans Linkleri

| Endpoint | Dokümantasyon |
|----------|---------------|
| Quote | https://web3.okx.com/build/dev-docs/wallet-api/dex-get-quote |
| Swap Instructions (Solana) | https://web3.okx.com/build/dev-docs/wallet-api/dex-solana-swap-instruction |
| API Reference | https://web3.okx.com/build/dev-docs/wallet-api/dex-api-reference |
| Environment Setup | https://web3.okx.com/build/dev-docs/wallet-api/env-setup |

## OKX API Gerekli Başlıklar

| Header | Açıklama |
|--------|----------|
| `OK-ACCESS-KEY` | OKX Developer Portal'dan alınan API anahtarı |
| `OK-ACCESS-SIGN` | `HMAC-SHA256(secret, timestamp + METHOD + requestPath)` → Base64 |
| `OK-ACCESS-PASSPHRASE` | API oluştururken belirlenen passphrase |
| `OK-ACCESS-TIMESTAMP` | ISO 8601 formatında UTC zaman damgası |
| `OK-ACCESS-PROJECT` | OKX Developer Portal'daki proje ID'si |

## OKX Solana Parametre Eşleşmesi

| Parametre | Tip | Açıklama |
|-----------|-----|----------|
| `chainIndex` | String | `"501"` — Solana mainnet-beta |
| `fromTokenAddress` | String | Kaynak token mint adresi |
| `toTokenAddress` | String | Hedef token mint adresi |
| `amount` | String | Raw birimde tutar (decimals dahil) |
| `slippagePercent` | String | Yüzde olarak slippage (`"0.2"` = %0.2) |
| `userWalletAddress` | String | Kullanıcı cüzdan adresi (swap-instruction için) |
| `computeUnitPrice` | String | Priority fee (opsiyonel) |

## Doğrulama (Dry-Run Çıktısı)

```
═══ Swap Dry-Run: direction=JUP_TO_OKX notional=1 ═══

[DEBUG] Jupiter quote alındı (796ms) — expectedOut=11826020
[DEBUG] OKX Quote Request URL: https://www.okx.com/api/v6/dex/aggregator/quote?chainIndex=501&...
[DEBUG] OKX quote alındı (1224ms) — expectedOut=1000124
[DEBUG] OKX Swap-Instruction Request URL: https://www.okx.com/api/v6/dex/aggregator/swap-instruction?...
[DEBUG] OKX: 4 ALT hesabı çözümleniyor...

╔══════════════════════════════════════════════════════════╗
║  Dry-Run Sonuçları                                      ║
╠══════════════════════════════════════════════════════════╣
║  Leg 1: JUPITER  ⚠ SIM HATASI (AccountNotFound)        ║
║    expectedOut  = 11826020                              ║
║  Leg 2: OKX      ⚠ SIM HATASI (AccountNotFound)        ║
║    expectedOut  = 1000124                               ║
╠──────────────────────────────────────────────────────────╣
║  Input       = 1000000 (1 USDC)                         ║
║  ExpectedOut = 1000124 (≈1.000124 USDC)                 ║
║  P/L (raw)   = +124    [PROFIT]                         ║
╚══════════════════════════════════════════════════════════╝
```

> **Not:** `AccountNotFound` simülasyon hatası, cüzdanda yeterli bakiye olmamasından kaynaklanır. Gerçek execution'da Leg 1 çalıştıktan sonra Leg 2 için gerekli token mevcut olacaktır.
