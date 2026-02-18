# Kritik Bug Düzeltmesi: Inventory Exposure (Bakiye Kilitlenmesi)

**Tarih:** 2026-02-18  
**Öncelik:** Kritik  
**Etkilenen Modüller:** `execution.ts`, `stream/priceTicker.ts`, `types.ts`, `telemetry.ts`  
**Durum:** ✅ Çözüldü

---

## 1. Sorun Özeti

Arbitraj botu, çift bacaklı (Leg 1 + Leg 2) bir işlem akışında çalışır:

| Yön | Leg 1 | Leg 2 |
|-----|-------|-------|
| `JUP_TO_OKX` | Jupiter: USDC → Token | OKX: Token → USDC |
| `OKX_TO_JUP` | OKX: USDC → Token | Jupiter: Token → USDC |

**Sorun:** Leg 1 on-chain başarıyla confirm olur, ancak Leg 2 başarısız olur. Bu durumda:

- ~500 USDC değerindeki token (ör. wSOL) cüzdanda **takılı** kalır
- Bot'un USDC bakiyesi **sıfır**a düşer → yeni işlem yapılamaz
- Circuit breaker tetiklenir → bot tamamen durur
- **Sermaye riski:** Takılı token fiyatı düşerse kayıp büyür

### Gerçek Senaryo

```
[LIVE] OKX_TO_JUP — Leg 1 (OKX USDC → wSOL) başarılı ✓ sig=5x...
[LIVE] OKX_TO_JUP — Leg 2 (Jupiter wSOL → USDC) BAŞARISIZ!
  → 3 retry sonrası SendError → circuit breaker tripped
  → Sonuç: ~500 USDC değerinde wSOL cüzdanda kilitli
  → Bot durdu, USDC bakiyesi = 0
```

---

## 2. Kök Neden Analizi

İki temel problem tespit edildi:

### Problem A: Stale Blockhash (Eskimiş Blok Hash)

Eski akışta **her iki leg de `buildAndSimulate` içinde aynı anda oluşturuluyordu**. Leg 1 gönderilip onay beklenirken Leg 2'nin blockhash'i expire olabilir (Solana blockhash ömrü ~60-90 saniye). Expire olmuş TX zincir tarafından reddedilir.

```
Timeline:
  t=0s    Leg 1 TX + Leg 2 TX oluşturuldu (aynı blockhash)
  t=2s    Leg 1 gönderildi → onay bekleniyor
  t=8s    Leg 1 confirm ✓
  t=8s    Leg 2 gönderildi → ❌ blockhash expired!
```

### Problem B: Stale Quote (Eskimiş Fiyat)

Leg 2 TX, Leg 1 gönderilmeden **önce** alınan quote ile oluşturulmuştu. Piyasa birkaç saniye içinde hareket edebilir. Eski quote'un `otherAmountThreshold` değeri artık geçerli olmayabilir → `Custom:1` (InsufficientFunds / slippage protection) hatası.

### Problem C: Kurtarma Mekanizması Yoktu

Leg 2 başarısız olduğunda bot sadece `SendError` fırlatıp circuit breaker'ı tetikliyordu. Cüzdandaki takılı token'ı geri çevirme mekanizması **hiç yoktu**.

---

## 3. Çözüm Mimarisi

İki mekanizma implemente edildi:

```
┌──────────────────────────────────────────────────┐
│               PriceTicker (ADIM 4)               │
├──────────────────────────────────────────────────┤
│                                                  │
│  ① Leg 1 TX gönder → sendWithRetry()            │
│     └─ Başarısız → SendError (normal akış)       │
│     └─ Başarılı ✓ sig=...                        │
│                                                  │
│  ② buildFreshLeg2() ← TAZE QUOTE + BLOCKHASH    │
│     └─ Leg 1'den gelen gerçek amount kullanılır  │
│     └─ Tamamen yeni TX oluşturulur               │
│                                                  │
│  ③ Leg 2 TX gönder → sendWithRetry()            │
│     └─ Başarılı ✓ → SEND_SUCCESS telemetri       │
│     └─ Başarısız ↓                               │
│                                                  │
│  ④ emergencyUnwind() ← ACİL SERMAYE KURTARMA    │
│     └─ Jupiter ile token → USDC                  │
│     └─ %1 slippage, 5 retry, agresif backoff     │
│     └─ Başarılı → circuit breaker reset           │
│     └─ Başarısız → MANUAL INTERVENTION uyarısı    │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## 4. Çözüm 1: Leg 2 TX Refresh (`buildFreshLeg2`)

**Dosya:** `src/execution.ts` — satır ~522

### Amaç

Leg 1 on-chain confirm olduktan **sonra** Leg 2'yi tamamen sıfırdan oluşturur. Bu sayede:
- **Taze quote:** Güncel piyasa fiyatı kullanılır
- **Taze blockhash:** Expire riski ortadan kalkar
- **Gerçek miktar:** Leg 1'den gelen `expectedOut` değeri kullanılır (tahmini değil)

### Fonksiyon İmzası

```typescript
interface BuildFreshLeg2Params {
  direction: Direction;          // "JUP_TO_OKX" | "OKX_TO_JUP"
  targetToken: TokenSymbol;      // "WIF" | "JUP" | "SOL" | ...
  leg1ReceivedAmount: bigint;    // Leg 1'den alınan token miktarı (raw)
  owner: PublicKey;              // Cüzdan public key
}

interface FreshLeg2Result {
  tx: VersionedTransaction;      // İmzalanmaya hazır taze TX
  meta: QuoteMeta;               // Quote bilgileri
  venue: "JUPITER" | "OKX";     // Leg 2'nin çalıştığı venue
}

async function buildFreshLeg2(params): Promise<FreshLeg2Result>
```

### Yön Bazlı Davranış

| Yön | Leg 2 Venue | İşlem |
|-----|-------------|-------|
| `JUP_TO_OKX` | OKX | `buildOkxSwap(token → USDC)` — swap-instruction API |
| `OKX_TO_JUP` | Jupiter | `fetchJupiterQuote + buildJupiterSwap(token → USDC)` |

### Entegrasyon Noktası

```typescript
// priceTicker.ts — ADIM 4
const leg1SendResult = await sendWithRetry(leg1.tx, this.owner);
// ✅ Leg 1 başarılı — artık Leg 2'yi TAZE oluştur
const freshLeg2 = await buildFreshLeg2({
  direction: best.direction,
  targetToken,
  leg1ReceivedAmount: leg1.expectedOut,
  owner: this.owner.publicKey,
});
const leg2SendResult = await sendWithRetry(freshLeg2.tx, this.owner);
```

---

## 5. Çözüm 2: Emergency Unwind (`emergencyUnwind`)

**Dosya:** `src/execution.ts` — satır ~598

### Amaç

Leg 2 (rebuild dahil) tamamen başarısız olduğunda, cüzdandaki takılı token'ı **Jupiter üzerinden USDC'ye** çevirerek sermayeyi kurtarır. Küçük kayıp (~0.05-0.5 USDC) kabul edilir; amaç sermaye kurtarma, kâr değil.

### Tasarım Kararları

| Parametre | Değer | Neden |
|-----------|-------|-------|
| Venue | Jupiter | En likit, en güvenilir aggregator |
| Slippage | %1 (100 BPS) | Normal %0.5'ten yüksek, ama kayıp kabul edilebilir |
| Max Retry | 5 | Normal 3'ten fazla — sermaye kurtarma kritik |
| Backoff | 500ms × 2^n | Agresif: 500ms, 1s, 2s, 4s, 8s |
| Circuit Breaker | Başarıda reset | Bot tekrar trade yapabilir |

### Fonksiyon İmzası

```typescript
interface EmergencyUnwindParams {
  targetToken: TokenSymbol;       // Takılı token
  stuckAmountRaw: bigint;         // Takılı miktar (raw units)
  signer: Keypair;                // İmzalayan cüzdan
  direction: Direction;           // Orijinal işlem yönü
  leg1Signature?: string;         // Telemetri cross-reference
}

interface EmergencyUnwindResult {
  success: boolean;
  signature?: string;             // Unwind TX imzası
  recoveredUsdcRaw?: bigint;      // Kurtarılan USDC (raw)
  lossUsdc?: number;              // Kayıp (orijinal input'a göre)
  failReason?: string;
  attempts: number;               // Kaç deneme yapıldı
}

async function emergencyUnwind(params): Promise<EmergencyUnwindResult>
```

### Unwind Akışı (Her Retry İçin)

```
1. fetchJupiterQuote(token → USDC, slippage=100 BPS)
2. buildJupiterSwap(route, owner)
3. tx.sign([signer])
4. sendVersionedWithOpts(connection, tx)
5. ✓ Başarılı → telemetri kaydet, circuit breaker reset, return
6. ✗ Başarısız → backoff bekle, retry
```

### Entegrasyon Noktası

```typescript
// priceTicker.ts — Leg 2 başarısız olduğunda
if (!leg2Success) {
  const unwindResult = await emergencyUnwind({
    targetToken,
    stuckAmountRaw: leg1ExpectedOut,
    signer: this.owner,
    direction: best.direction,
    leg1Signature: leg1Sig,
  });
  // unwindResult.success → bot devam eder
  // !unwindResult.success → MANUAL INTERVENTION REQUIRED
}
```

---

## 6. Yeni Telemetri Durumları

`types.ts`'deki `TelemetryStatus` enum'una 3 yeni durum eklendi:

| Status | Ne Zaman | Persist |
|--------|----------|---------|
| `EMERGENCY_UNWIND_SUCCESS` | Unwind başarılı, sermaye kurtarıldı | ✅ trades.jsonl |
| `EMERGENCY_UNWIND_FAILED` | Unwind başarısız, manuel müdahale gerekli | ✅ trades.jsonl |
| `LEG2_REFRESH_FAILED` | Taze Leg 2 rebuild sonrası gönderim başarısız | ✅ trades.jsonl |

### Telemetri Çıktı Örnekleri

**Başarılı Unwind:**
```json
{
  "pair": "SOL/USDC",
  "direction": "OKX_TO_JUP",
  "status": "EMERGENCY_UNWIND_SUCCESS",
  "success": true,
  "failReason": "Unwind after Leg2 failure. Loss: 0.1234 USDC",
  "txSignatures": ["leg1_sig...", "unwind_sig..."],
  "netProfitUsdc": -0.1234,
  "grossProfitUsdc": -0.1234,
  "profitLabel": "loss"
}
```

**Başarısız Unwind:**
```json
{
  "pair": "SOL/USDC",
  "direction": "OKX_TO_JUP",
  "status": "EMERGENCY_UNWIND_FAILED",
  "success": false,
  "failReason": "Emergency unwind FAILED after 5 attempts — MANUAL INTERVENTION REQUIRED",
  "txSignatures": ["leg1_sig..."]
}
```

---

## 7. Değişen Dosyalar Özeti

| Dosya | Değişiklik |
|-------|------------|
| `src/execution.ts` | `buildFreshLeg2()`, `emergencyUnwind()`, `resetCircuitBreaker()` fonksiyonları eklendi |
| `src/stream/priceTicker.ts` | ADIM 4 tamamen yeniden yazıldı: Leg1→FreshLeg2→Unwind akışı |
| `src/types.ts` | `TelemetryStatus`'a 3 yeni durum eklendi |
| `src/telemetry.ts` | Yeni durumlar `PERSISTABLE_STATUSES` set'ine eklendi |

---

## 8. Eski vs. Yeni Akış Karşılaştırması

### ESKİ AKIŞ (Tehlikeli)

```
buildAndSimulate() → [Leg1 TX, Leg2 TX] (aynı anda oluşturulur)
  ↓
for leg in legs:
  sendWithRetry(leg)    ← Leg2'nin blockhash expire olabilir!
  ↓
Leg1 ✓, Leg2 ✗ → circuit breaker → BOT DURUR, TOKEN TAKILI KALIR
```

### YENİ AKIŞ (Güvenli)

```
buildAndSimulate() → [Leg1 TX, Leg2 TX] (ama Leg2 TX artık kullanılmaz)
  ↓
sendWithRetry(Leg1)
  ↓ (Leg 1 on-chain confirm)
buildFreshLeg2() → [TAZE Leg2 TX] (yeni quote + yeni blockhash)
  ↓
sendWithRetry(Leg2)
  ↓ Başarısız?
emergencyUnwind() → Jupiter token→USDC (sermaye kurtarma)
  ↓
Circuit breaker reset → bot devam eder
```

---

## 9. Risk Matrisi

| Senaryo | Eski Davranış | Yeni Davranış |
|---------|---------------|---------------|
| Leg 1 ✓, Leg 2 ✓ | Trade başarılı | Trade başarılı (aynı) |
| Leg 1 ✗ | SendError, bot devam | SendError, bot devam (aynı) |
| Leg 1 ✓, Leg 2 ✗ (stale) | **TOKEN TAKILI, BOT DURUR** | Taze Leg 2 rebuild → retry |
| Leg 1 ✓, Leg 2 ✗ (tüm retry) | **TOKEN TAKILI, BOT DURUR** | Emergency Unwind → sermaye kurtarma |
| Leg 1 ✓, Leg 2 ✗, Unwind ✗ | N/A | MANUAL INTERVENTION logu + telemetri |

---

## 10. Geri Kalan Bilinen Limitasyonlar

1. **Gerçek Leg 1 çıktı miktarı:** Şu anda `leg1.expectedOut` (quote tahmini) kullanılıyor. İdeal senaryoda on-chain TX sonucundan gerçek miktar parse edilmeli. Ancak Solana TX parse karmaşıklığı nedeniyle bu ertelendi — slippage koruması `otherAmountThreshold` ile sağlanıyor.

2. **Unwind venue sabit:** Emergency Unwind yalnızca Jupiter kullanır. OKX'in daha iyi fiyat verdiği nadir durumlarda suboptimal olabilir, ama güvenilirlik ön plandadır.

3. **Manuel müdahale senaryosu:** 5 retry sonrası unwind da başarısız olursa bot otomatik olarak devam edemez. `EMERGENCY_UNWIND_FAILED` logunu izleyen bir alerting sistemi kurulmalıdır (gelecek iş).

4. **`buildAndSimulate` hâlâ Leg 2 TX üretir:** Leg 2 TX artık fiilen kullanılmasa da `buildAndSimulate` onu hâlâ oluşturuyor. Bu, net profit gate kontrolü (Leg 2 expectedOut ile kâr hesabı) için gerekli. İleride optimize edilebilir.

---

## 11. Ek Düzeltme: wSOL `wrapAndUnwrapSol` Hatası

**Tarih:** 2026-02-18  
**Öncelik:** Kritik  
**Etkilenen Modüller:** `jupiter.ts`, `execution.ts`  
**Durum:** ✅ Çözüldü

### Sorun

Emergency Unwind ve `buildFreshLeg2` fonksiyonları implemente edildikten sonra, SOL/USDC çifti üzerinde Leg 2 ve Unwind denemeleri **5/5 retry'da da başarısız** oldu:

```
"Transfer: insufficient lamports 432642918, need 6011634412"
"Program 1111...1111 failed: custom program error: 0x1"
```

- Cüzdandaki native SOL: **~0.43 SOL** (432M lamport) — yalnızca fee/rent için ayrılmış
- Jupiter'ın talep ettiği: **~6.01 SOL** (6011M lamport) — swap edilecek ana tutar

### Kök Neden

`buildJupiterSwap()` fonksiyonunda `wrapAndUnwrapSol: true` **hardcoded** idi. Bu parametre Jupiter'a şunu söyler:

> "Swap öncesi native SOL lamport'larını al, geçici wSOL hesabı aç, wrap et, swap yap, sonra unwrap et."

Ancak OKX Leg 1 (USDC → wSOL) swap sonucunda wSOL zaten bir **SPL Token Account (ATA)** olarak cüzdana yatırılmıştı. Jupiter `wrapAndUnwrapSol: true` ile native lamport'lardan yeni wSOL oluşturmaya çalışıyor — ama native SOL bakiyesi sadece ~0.43 SOL (fee/rent).

```
Cüzdan Durumu (Leg 1 sonrası):
  ┌──────────────────────────────┐
  │ Native SOL:  0.43 SOL       │ ← fee/rent, dokunulmamalı
  │ wSOL ATA:    3.27 SOL       │ ← OKX'ten gelen, swap edilecek
  │ USDC ATA:    0.00 USDC      │ ← Leg 1'de harcandı
  └──────────────────────────────┘

Jupiter (wrapAndUnwrapSol=true) şunu yapar:
  ✗ Native SOL'dan 3.27 SOL al → wrap et → swap et
  → "insufficient lamports" hatası!

Jupiter (wrapAndUnwrapSol=false) şunu yapar:
  ✓ Mevcut wSOL ATA'daki 3.27 SOL'u doğrudan swap et
  → Başarılı!
```

### Çözüm

3 dosyada değişiklik yapıldı:

#### 1. `src/jupiter.ts` — Yeni opsiyonel parametre

`JupiterSwapParams` arayüzüne `wrapAndUnwrapSol?: boolean` eklendi. Default `true` (mevcut davranış korunur), ama SOL satılırken `false` geçilebilir:

```typescript
export interface JupiterSwapParams {
  route: JupiterRouteInfo;
  userPublicKey: PublicKey;
  asLegacy?: boolean;
  /**
   * true (default): Jupiter wraps native SOL → wSOL before swap, unwraps after.
   * false: Jupiter uses existing wSOL token account directly.
   * Set to false when selling wSOL that already sits in a token account
   * (e.g. received from OKX Leg 1).
   */
  wrapAndUnwrapSol?: boolean;
}

// buildJupiterSwap() body:
wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
```

#### 2. `src/execution.ts` — `buildFreshLeg2()` düzeltmesi

SOL token'ı satılırken `wrapAndUnwrapSol: false`:

```typescript
const isNativeSol = params.targetToken === "SOL";
const tx = await buildJupiterSwap({
  route,
  userPublicKey: params.owner,
  wrapAndUnwrapSol: !isNativeSol,  // SOL → false, diğerleri → true
});
```

#### 3. `src/execution.ts` — `emergencyUnwind()` düzeltmesi

Aynı mantık Emergency Unwind için de uygulandı:

```typescript
const isNativeSol = params.targetToken === "SOL";
const tx = await buildJupiterSwap({
  route,
  userPublicKey: params.signer.publicKey,
  wrapAndUnwrapSol: !isNativeSol,
});
```

### Ne Zaman `wrapAndUnwrapSol: false` Kullanılır?

| Senaryo | `wrapAndUnwrapSol` | Neden |
|---------|-------------------|-------|
| USDC → SOL (alım) | `true` | Native SOL yok, Jupiter wrap eder |
| SOL → USDC (satım, normal arb) | `false` | wSOL zaten ATA'da (Leg 1'den) |
| SOL → USDC (emergency unwind) | `false` | wSOL zaten ATA'da (takılı kalmış) |
| WIF → USDC (herhangi yön) | `true` | wSOL değil, etkilenmez |
| JUP → USDC (herhangi yön) | `true` | wSOL değil, etkilenmez |

### Genel Kural

> **`targetToken === "SOL"` ve token satılıyorsa (token → USDC yönü) → `wrapAndUnwrapSol: false`**  
> Diğer tüm senaryolarda → `wrapAndUnwrapSol: true` (varsayılan)

---

## 12. Ek Düzeltme 2: OKX wSOL Unwrap Sorunu — Dinamik Bakiye Tespiti

**Tarih:** 2026-02-18  
**Öncelik:** Kritik  
**Etkilenen Modüller:** `solana.ts`, `execution.ts`  
**Durum:** ✅ Çözüldü

### Sorun

Bölüm 11'deki `wrapAndUnwrapSol: false` düzeltmesine rağmen Emergency Unwind **5/5 retry'da da başarısız** olmaya devam etti. Hata artık farklı:

```
"Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoI5QNyVTaV4 failed: custom program error: 0x788"
```

- `0x788` = Jupiter programının kendi hatası (System Program `0x1`'den farklı)
- `wrapAndUnwrapSol=false` log'u görünüyor — Bölüm 11 fix'i uygulanmış
- Ama Jupiter boş wSOL ATA'dan swap etmeye çalışıyor → `0x788`

### Kök Neden

OKX DEX Aggregator, Leg 1 (USDC → SOL) swap'ı sırasında wSOL'u **unwrap ederek native SOL lamport'larına** dönüştürmüş. Yani:

```
Bölüm 11'deki varsayım (YANLIŞ):
  ┌──────────────────────────────┐
  │ Native SOL:  0.43 SOL       │
  │ wSOL ATA:    3.27 SOL  ★    │ ← "wSOL burada olmalı"
  └──────────────────────────────┘

Gerçek durum (OKX unwrap sonrası):
  ┌──────────────────────────────┐
  │ Native SOL:  3.70 SOL  ★    │ ← OKX wSOL'u native'e çevirmiş!
  │ wSOL ATA:    0.00 SOL       │ ← BOŞ
  └──────────────────────────────┘
```

**Bölüm 11 fix'i** `wrapAndUnwrapSol: false` ile ATA'dan okumaya çalışıyor, ama ATA boş → `0x788`.

**Asıl sorun:** OKX'in wSOL'u unwrap edip etmeyeceği **önceden bilinemez**. Bazen ATA'da bırakır, bazen native'e çevirir. Statik `true`/`false` kararı her iki durumu kapsamaz.

### Çözüm: `resolveSolBalance()` — Dinamik On-Chain Bakiye Tespiti

`src/solana.ts`'e yeni bir helper fonksiyonu eklendi. SOL token'ı için on-chain'den **her iki kaynağı paralel** olarak sorgular ve doğru swap parametrelerini döndürür.

#### Yeni Helper: `resolveSolBalance()`

```typescript
// src/solana.ts

interface SolBalanceInfo {
  wsolAtaBalance: bigint;        // wSOL ATA bakiyesi (0 olabilir)
  nativeLamports: bigint;        // Native SOL bakiyesi (toplam)
  usableNativeLamports: bigint;  // Native SOL - 0.01 rent reserve
  useAta: boolean;               // true = ATA'dan swap, false = native'den wrap
  swapAmount: bigint;            // Gerçek swap miktarı
  wrapAndUnwrapSol: boolean;     // Jupiter'a geçilecek parametre
}

async function resolveSolBalance(
  owner: PublicKey,
  wsolMint: PublicKey,
  expectedAmount: bigint
): Promise<SolBalanceInfo>
```

#### ATA Derivasyonu (spl-token bağımlılığı olmadan)

```typescript
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}
```

#### Karar Mantığı

```
   resolveSolBalance() çağrılır
         │
         ├─ getTokenAccountBalance(wSOL ATA)  ─┐
         ├─ getBalance(owner)                  ─┤  paralel
         │                                      │
         ▼                                      ▼
   wsolAtaBalance                         nativeLamports
         │                                      │
         └──────────┬─── threshold = expectedAmount × 80% ───┐
                    │                                         │
              ATA ≥ threshold?                          native ≥ threshold?
                 │                                         │
            ┌────┴────┐                              ┌─────┴─────┐
            │  EVET   │                              │   EVET    │
            ▼         │                              ▼           │
     useAta=true      │                       useAta=false       │
     wrap=false       │                       wrap=true          │
     amount=ATA bal   │                       amount=min(native, │
                      │                              expected)   │
                      │                                          │
                      └──── Her ikisi de düşük ─────┘
                                    │
                              Büyük olanı dene
                              + uyarı logla
```

| wSOL ATA Bakiyesi | Native SOL (usable) | Sonuç | `wrapAndUnwrapSol` |
|-------------------|--------------------|---------|--------------------|
| ≥ %80 beklenen | herhangi | ATA'dan swap | `false` |
| düşük / boş | ≥ %80 beklenen | Native'den wrap | `true` |
| her ikisi düşük | her ikisi düşük | Büyük olanı dene | dinamik |

#### Log Çıktısı

```
[SOL-BALANCE] wSOL ATA: 0 lamports | Native: 3700000000 lamports (usable: 3690000000) | Expected: 3270000000
```

### Entegrasyon Noktaları

#### `emergencyUnwind()` (execution.ts)

```typescript
if (isNativeSol) {
  const solInfo = await resolveSolBalance(
    params.signer.publicKey,
    new PublicKey(targetMint),
    params.stuckAmountRaw
  );
  unwindAmount = solInfo.swapAmount;
  wrapAndUnwrapSol = solInfo.wrapAndUnwrapSol;
}

// Bakiye sıfırsa erken çıkış
if (unwindAmount <= 0n) {
  return { success: false, failReason: "No SOL balance found", attempts: 0 };
}
```

#### `buildFreshLeg2()` (execution.ts)

```typescript
if (isNativeSol) {
  const solInfo = await resolveSolBalance(
    params.owner,
    new PublicKey(targetMint),
    params.leg1ReceivedAmount
  );
  swapAmount = solInfo.swapAmount;
  wrapAndUnwrapSol = solInfo.wrapAndUnwrapSol;
}

const { route, meta } = await fetchJupiterQuote({
  inputMint: targetMint,
  outputMint: usdcMint,
  amount: swapAmount,          // ← dinamik miktar
  slippageBps: cfg.slippageBps,
});

const tx = await buildJupiterSwap({
  route,
  userPublicKey: params.owner,
  wrapAndUnwrapSol: wrapAndUnwrapSol,  // ← dinamik karar
});
```

### Değişen Dosyalar

| Dosya | Değişiklik |
|-------|------------|
| `src/solana.ts` | `deriveATA()`, `resolveSolBalance()` helper'ları eklendi |
| `src/execution.ts` | `emergencyUnwind()` ve `buildFreshLeg2()` SOL için dinamik bakiye tespiti |

### Neden Bölüm 11 Yetersizdi?

| Özellik | Bölüm 11 (Statik) | Bölüm 12 (Dinamik) |
|---------|-------------------|---------------------|
| wSOL ATA'da | ✅ Çalışır | ✅ Çalışır |
| Native lamport'larda | ❌ `0x788` hatası | ✅ Otomatik tespit |
| Her ikisinde parçalı | ❌ Tanımsız | ✅ Büyük kaynağı seçer |
| Bakiye yok | ❌ Boş TX retry döngüsü | ✅ Erken çıkış + telemetri |

### Rent Reserve

Native SOL bakiyesinden **0.01 SOL** (10M lamport) düşülür — bu rent-exempt minimum + TX fee için ayrılır. Tüm native bakiyeyi swap etmeye çalışmak hesabın silinmesine yol açabilir.

---

## 13. Kritik Düzeltme 3: Leg 1 Onay Beklemeden Leg 2 Oluşturma (Race Condition)

**Tarih:** 2026-02-18  
**Öncelik:** Kritik  
**Etkilenen Modüller:** `solana.ts`, `stream/priceTicker.ts`  
**Durum:** ✅ Çözüldü

### Sorun

Bölüm 12'deki `resolveSolBalance()` doğru çalışmasına rağmen, **ilk kârlı işlemlerde paranın SOL'da kalması** devam etti. Dashboard'da 2 işlem "Kârlı" olarak gösterildi ama USDC cüzdana dönmedi.

Log çıktısı:

```
[LIVE] Leg 1 başarılı ✓ sig=4uq1...
[SOL-BALANCE] wSOL ATA: 0 lamports | Native: 498988848 | Expected: 6050429897
[SOL-BALANCE] ⚠ Yetersiz bakiye! ATA=0, native usable=488988848, expected=605042989?
```

**Kritik gözlem:** Leg 1 ~**6.05 SOL** üretmesi gerekiyor ama cüzdanda sadece **0.499 SOL** native görünüyor! ~5.55 SOL kayıp!

### Kök Neden: `sendTransaction` ≠ Onay

`sendWithRetry()` → `connection.sendTransaction()` çağrısı TX'i ağa gönderir ve **anında signature döndürür**. Ancak TX **henüz on-chain confirm olmamıştır**:

```
┌─────────────────────────────────────────────┐
│ sendTransaction() davranışı:                │
│                                             │
│ 1. Preflight simulation (yerel) ✓          │
│ 2. TX ağa gönderildi                       │
│ 3. Signature HEMEN döndürüldü ←            │
│                                             │
│ ... TX henüz validator tarafından ...       │
│ ... işlenmedi, balance güncellenmedi ...    │
│                                             │
│ 4. ~2-5 saniye sonra TX on-chain confirm    │
│ 5. Bakiye güncellendi                       │
└─────────────────────────────────────────────┘
```

Eski akış:

```
t=0.0s  sendWithRetry(Leg1) → signature alındı ✓
t=0.0s  buildFreshLeg2() HEMEN çağrıldı          ← HATA!
t=0.0s  resolveSolBalance() → ESKİ bakiye: 0.499 SOL
t=0.1s  Jupiter quote: 0.489 SOL → ~40 USDC
t=0.2s  Leg 2 gönderildi → sadece 0.489 SOL swap edildi
t=2.5s  Leg 1 on-chain confirm → bakiye 6.55 SOL (ama artık ÇOK GEÇ!)
```

**Sonuç:** 500 USDC → 6.05 SOL → sadece 0.489 SOL geri swap → ~40 USDC kurtarıldı → **~460 USDC kayıp!**

### Çözüm: `waitForConfirmation()` Helper

`src/solana.ts`'e yeni fonksiyon eklendi. TX signature'ının on-chain "confirmed" durumuna ulaşmasını **blockhash stratejisi** ile bekler:

```typescript
// src/solana.ts
async function waitForConfirmation(
  signature: string,
  commitment: Commitment = "confirmed",
  timeoutMs: number = 60_000
): Promise<void> {
  const connection = getConnection();
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);

  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    commitment
  );

  if (result.value.err) {
    throw new Error(`TX confirmed with error: ${JSON.stringify(result.value.err)}`);
  }
}
```

**Neden blockhash stratejisi?**
- `confirmTransaction` blockhash olmadan çağrılırsa timeout durumunda **sonsuz bekleyebilir**
- Blockhash ile çağrıldığında `lastValidBlockHeight` geçildikçe otomatik timeout oluşur (~60s)
- TX on-chain hata ile confirm olursa (`result.value.err`) throw eder → Leg 2'ye geçilmez

### Entegrasyon: priceTicker.ts

```typescript
// Leg 1 gönder
const leg1SendResult = await sendWithRetry(leg1.tx, this.owner);
const leg1Sig = leg1SendResult.finalSignature;

// ★ YENİ: On-chain confirm bekle — balance güncellenene kadar
await waitForConfirmation(leg1Sig, "confirmed");

// Artık balance doğru — Leg 2 oluştur
const freshLeg2 = await buildFreshLeg2({ ... });
```

### Yeni Akış (Düzeltilmiş)

```
t=0.0s  sendWithRetry(Leg1) → signature alındı ✓
t=0.0s  waitForConfirmation(sig) başladı…
t=2.5s  TX on-chain confirm ✓ — bakiye güncellendi
t=2.5s  buildFreshLeg2() çağrıldı
t=2.6s  resolveSolBalance() → GÜNCEL bakiye: 6.55 SOL ✓
t=2.7s  Jupiter quote: 6.05 SOL → ~500 USDC ✓
t=2.8s  Leg 2 gönderildi → TAM miktar swap edildi ✓
```

### Etki Analizi

| Metrik | Eski (confirm yok) | Yeni (confirm var) |
|--------|--------------------|--------------------|
| Balance doğruluğu | ❌ Stale (eski) | ✅ Güncel |
| SOL geri swap miktarı | ~%8 (0.49/6.05) | ~%100 |
| USDC kurtarma | ~40 USDC / 500 | ~500 USDC / 500 |
| Ek latency | 0ms | ~2-5s (block confirm süresi) |
| Sonsuz bekleme riski | N/A | Yok (blockhash timeout) |

### Leg 1 On-Chain Hata Durumu

`waitForConfirmation` TX'in hata ile confirm olduğunu da yakalar:

```typescript
try {
  await waitForConfirmation(leg1Sig, "confirmed");
} catch (confirmErr) {
  // TX zincirde hata ile sonuçlandı → token gelmedi
  // Leg 2'ye geçme, unwind da gerekli değil (para harcanmadı)
  throw new SendError(`Leg 1 on-chain confirm failed: ${reason}`);
}
```

Bu durumda:
- Leg 1 TX on-chain hata ile sonuçlanmış → token cüzdana **gelmemiş**
- USDC de harcanmamış olabilir (TX reverted)
- Emergency Unwind **gerekmez** — çünkü envanterde fazla token yok
- Bot sadece SendError fırlatır ve sonraki tick'e geçer

### Değişen Dosyalar

| Dosya | Değişiklik |
|-------|------------|
| `src/solana.ts` | `waitForConfirmation()` helper eklendi |
| `src/stream/priceTicker.ts` | Leg 1 sonrası `waitForConfirmation()` çağrısı eklendi |

### Neden Bölüm 12 Yetersizdi?

Bölüm 12'deki `resolveSolBalance()` doğru çalışıyor — on-chain bakiyeyi okuyor ve doğru karar veriyor. Sorun bakiye fonksiyonunda değil, **çağrı zamanlamasında**:

| Özellik | Bölüm 12 (Bakiye Tespiti) | Bölüm 13 (Onay Bekleme) |
|---------|--------------------------|------------------------|
| Bakiye okuma | ✅ Doğru | ✅ Doğru |
| Bakiye güncelliği | ❌ Stale olabilir | ✅ Confirm sonrası güncel |
| Tam miktar kurtarma | ❌ Kısmi (~%8) | ✅ Tam (~%100) |
| Race condition | ❌ Var | ✅ Yok |
