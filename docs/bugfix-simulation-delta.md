# Kritik Bug Düzeltmesi: Simülasyon Çıktısında Toplam Bakiye vs. Net Delta

**Tarih:** 2026-02-17  
**Öncelik:** Kritik  
**Etkilenen Modüller:** `execution.ts`, `solana.ts`, `types.ts`  
**Yön:** JUP_TO_OKX (ve potansiyel olarak OKX_TO_JUP)

---

## Sorun Özeti

Bot, JUP → OKX yönünde canlı işlem denerken `simulatedOut` değerini yanlış hesaplıyordu. Swap sonrasında elde edilen **net** token miktarı yerine, cüzdanın o anki **toplam** USDC bakiyesini (ör. 215 USDC) döndürüyordu.

Bu durum, kârsız işlemlerin kârlı görünmesine ve botun sürekli simülasyon + gönderim döngüsüne girmesine neden oluyordu.

## Kök Neden Analizi

`extractSimulatedOut()` fonksiyonu, Solana RPC simülasyon yanıtındaki `postTokenBalances` dizisinden ilgili mint+owner kaydını bulup `rawAmount` değerini doğrudan `simulatedOut` olarak döndürüyordu:

```typescript
// ❌ ESKİ KOD — HATALI
function extractSimulatedOut(sim, mint, owner): bigint | undefined {
  const balance = sim.postTokenBalances?.find(
    (b) => b.mint === mint && b.owner === owner
  );
  if (!balance) return undefined;
  if (balance.rawAmount) return BigInt(balance.rawAmount);
  // ...
}
```

`postTokenBalances[].rawAmount`, hesaptaki **toplam** token bakiyesini temsil eder — swap öncesi mevcut bakiye + swap'tan gelen miktar. Örneğin:

| Değer | Miktar |
|---|---|
| Swap öncesi USDC bakiyesi (pre) | 213.50 USDC |
| Swap'tan elde edilen net çıktı | 1.50 USDC |
| postTokenBalances rawAmount | **215.00 USDC** ← bot bunu "kazanç" sanıyordu |

Bot 1.50 USDC'lik bir çıktıyı 215 USDC sanınca net kâr hesabı her zaman pozitif çıkıyor, Net Profit Gate'i geçiyor ve işlem gönderilmeye çalışılıyordu.

## Uygulanan Düzeltme

### 1. `types.ts` — `SimulationOutcome` arayüzüne `preTokenBalances` ve `preBalances` eklendi

```typescript
export interface SimulationOutcome {
  logs: string[];
  unitsConsumed?: number;
  error?: string;
  accountsLoaded?: number;
  preBalances?: bigint[];           // ← YENİ
  postBalances?: bigint[];
  preTokenBalances?: Array<{        // ← YENİ
    mint: string;
    owner: string;
    rawAmount: string;
    uiAmount?: string;
    decimals?: number;
  }>;
  postTokenBalances?: Array<{ /* aynı yapı */ }>;
}
```

### 2. `solana.ts` — `simulateTx()` artık `preTokenBalances` yakalıyor

RPC yanıtından (`simulateTransaction`) gelen `preTokenBalances` dizisi parse edilip `SimulationOutcome`'a eklendi. Ortak mapping helper fonksiyonu kullanılarak kod tekrarı önlendi.

### 3. `execution.ts` — `extractSimulatedOut()` delta tabanlı hesaplama

```typescript
// ✅ YENİ KOD — DOĞRU
function extractSimulatedOut(sim, mint, owner): bigint | undefined {
  const postEntry = sim.postTokenBalances?.find(
    (b) => b.mint === mint && b.owner === owner
  );
  if (!postEntry) return undefined;

  const postRaw = BigInt(postEntry.rawAmount);

  // preTokenBalances'tan aynı mint+owner kaydını bul
  const preEntry = sim.preTokenBalances?.find(
    (b) => b.mint === mint && b.owner === owner
  );
  const preRaw = preEntry?.rawAmount ? BigInt(preEntry.rawAmount) : BigInt(0);

  const delta = postRaw - preRaw;

  // Delta negatifse bu çıkış tokeni değil, input tokenidir
  if (delta < BigInt(0)) return undefined;

  return delta;
}
```

**Hesaplama özeti:**

```
simulatedOut = postTokenBalances[mint,owner].rawAmount
             − preTokenBalances[mint,owner].rawAmount
```

## Etki ve Doğrulama

| Kontrol | Sonuç |
|---|---|
| TypeScript derleme (`tsc --noEmit`) | ✅ İlgili dosyalarda hata yok |
| `preTokenBalances` yoksa (eski RPC) | ✅ Fallback: pre = 0, post değeri aynen kullanılır |
| Delta negatif (input token sorgulanırsa) | ✅ `undefined` döner, güvenli fallback |
| Debug loglama | ✅ `pre`, `post`, `delta` değerleri konsola yazılır |

## Önleme Stratejisi

1. **Birim test ekle:** `extractSimulatedOut` fonksiyonu için mock `SimulationOutcome` nesneleriyle test yazılmalı — toplam bakiye ile delta ayrımı doğrulanmalı.
2. **Canary kontrol:** `simulatedOut > notionalInput * 2` gibi bir sanity check eklenebilir — delta'nın makul aralıkta olduğunu doğrular.
3. **Telemetri:** `pre`, `post`, `delta` değerleri trade log'a eklenerek canlı ortamda izlenebilir.
