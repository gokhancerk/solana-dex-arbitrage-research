/**
 * Jito Block Engine — Bundle Submission & Status Tracking
 *
 * Jito bundle'ları tüm TX'lerin aynı blokta yer almasını garanti eder.
 * 2-leg arbitraj: Leg1 + Leg2 + Tip TX → tek bundle → aynı blokta çalışır.
 *
 * Avantajlar:
 * - Aynı blok: her iki bacak da aynı blokta, ardışık olarak çalışır
 * - MEV koruması: bundle validatör tarafından önceliklendirilir
 * - Sequential risk yok: Leg1→Leg2 arası saniye cinsinden bekleme yok
 *
 * API: Jito Block Engine JSON-RPC
 * Endpoint: POST /api/v1/bundles
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getConnection } from "./solana.js";
import { loadConfig } from "./config.js";

// ═══════════════════════════════════════════════════════════════════
// ║  Constants                                                      ║
// ═══════════════════════════════════════════════════════════════════

/** Jito Block Engine varsayılan URL — env ile override: JITO_BLOCK_ENGINE_URL */
export const DEFAULT_JITO_BLOCK_ENGINE_URL =
  "https://mainnet.block-engine.jito.wtf";

/** Varsayılan tip miktarı (lamports) — env ile override: JITO_TIP_LAMPORTS */
export const DEFAULT_JITO_TIP_LAMPORTS = 10_000; // 0.00001 SOL

/** Bundle JSON-RPC endpoint */
const BUNDLES_PATH = "/api/v1/bundles";

/** Tip hesapları REST endpoint */
const TIP_ACCOUNTS_PATH = "/api/v1/bundles/tip_accounts";

/** Tip hesapları cache TTL (ms) */
const TIP_CACHE_TTL_MS = 300_000; // 5 dakika

/** Bundle landing polling aralığı (ms) */
const BUNDLE_POLL_INTERVAL_MS = 2_000;

/** Bundle landing varsayılan timeout (ms) */
const BUNDLE_LANDING_TIMEOUT_MS = 30_000;

/** Jito HTTP fetch timeout (ms) */
const JITO_FETCH_TIMEOUT_MS = 10_000;

/** 429 rate limit retry — max deneme sayısı (fast-fail: sadece 1 retry) */
const JITO_429_MAX_RETRIES = 1;

/** 429 backoff base (ms) — exponential: base * 2^(attempt) */
const JITO_429_BACKOFF_BASE_MS = 1_000;

/** Ardışık Jito API çağrıları arasında min bekleme (ms) */
const JITO_MIN_CALL_SPACING_MS = 3_000;

/** Rate-limit sonrası Jito cooldown süresi (ms) — bu süre boyunca sequential mode */
const JITO_COOLDOWN_MS = 60_000; // 60 saniye

/** Son Jito bundle gönderim zamanı */
let _lastJitoCallTimestamp = 0;

/** Endpoint round-robin index (her 429'da sonraki endpoint'e geç) */
let _endpointIndex = 0;

/** Jito rate-limit cooldown bitiş zamanı (epoch ms) */
let _jitoRateLimitedUntil = 0;

// ═══════════════════════════════════════════════════════════════════
// ║  Rate-Limit Cooldown                                            ║
// ═══════════════════════════════════════════════════════════════════

/**
 * Jito bundle gönderimi şu an mümkün mü?
 * Rate-limit cooldown aktifse false döner — caller sequential mode'a geçmelidir.
 */
export function isJitoAvailable(): boolean {
  return Date.now() >= _jitoRateLimitedUntil;
}

/**
 * Jito cooldown'ın kalan süresi (saniye). 0 = cooldown yok.
 */
export function getJitoCooldownRemaining(): number {
  const remaining = _jitoRateLimitedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Jito cooldown'ını başlat (rate-limit algılandığında çağrılır).
 * @internal
 */
function activateJitoCooldown(): void {
  _jitoRateLimitedUntil = Date.now() + JITO_COOLDOWN_MS;
  console.warn(
    `[JITO-COOLDOWN] Rate-limited! Jito bundle ${JITO_COOLDOWN_MS / 1000}s devre dışı → sequential fallback aktif`
  );
}

/**
 * Round-robin ile sonraki Jito Block Engine URL'ini döndürür.
 * 429 hatalarında otomatik olarak farklı bölgedeki endpoint'e geçer.
 */
function getNextJitoEndpoint(): string {
  const cfg = loadConfig();
  const urls = cfg.jitoBlockEngineUrls;
  if (!urls.length) return cfg.jitoBlockEngineUrl ?? DEFAULT_JITO_BLOCK_ENGINE_URL;
  const url = urls[_endpointIndex % urls.length];
  return url;
}

/** Endpoint round-robin'i bir sonraki endpoint'e ilerlet */
function advanceJitoEndpoint(): void {
  const cfg = loadConfig();
  _endpointIndex = (_endpointIndex + 1) % (cfg.jitoBlockEngineUrls.length || 1);
}

// ═══════════════════════════════════════════════════════════════════
// ║  Tip Accounts                                                   ║
// ═══════════════════════════════════════════════════════════════════

/**
 * Bilinen Jito tip hesapları (fallback — API ulaşılamazsa kullanılır).
 * Tip hesapları nadiren değişir; API'den çekilemezse bu güvenli liste kullanılır.
 */
const FALLBACK_TIP_ACCOUNTS: string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiPhk3gPu",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSx5NTQREPsA28X9tSDf",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY",
];

let _cachedTipAccounts: string[] | null = null;
let _tipCacheFetchedAt = 0;

/**
 * Jito tip hesaplarını Block Engine API'den çeker, cache'ler.
 * API ulaşılamazsa bilinen fallback listesini döndürür.
 */
export async function getJitoTipAccounts(): Promise<string[]> {
  const now = Date.now();
  if (_cachedTipAccounts && now - _tipCacheFetchedAt < TIP_CACHE_TTL_MS) {
    return _cachedTipAccounts;
  }

  // Birincil endpoint + alternatiflerden tip hesapları çek
  const cfg = loadConfig();
  const urls = cfg.jitoBlockEngineUrls.length > 0
    ? cfg.jitoBlockEngineUrls
    : [cfg.jitoBlockEngineUrl ?? DEFAULT_JITO_BLOCK_ENGINE_URL];

  for (const baseUrl of urls) {
    const url = `${baseUrl}${TIP_ACCOUNTS_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const accounts = (await res.json()) as string[];
      if (Array.isArray(accounts) && accounts.length > 0) {
        const valid = accounts.filter(
          (a) => typeof a === "string" && a.length >= 32 && a.length <= 44
        );
        if (valid.length > 0) {
          _cachedTipAccounts = valid;
          _tipCacheFetchedAt = now;
          console.log(
            `[JITO] Tip hesapları güncellendi (${valid.length} hesap, kaynak: ${baseUrl.replace('https://', '').split('.')[0]})`
          );
          return valid;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[JITO] Tip hesapları ${baseUrl.replace('https://', '').split('.')[0]} hatası: ${reason}`
      );
      continue; // sonraki endpoint'i dene
    }
  }

  console.warn(
    `[JITO] Tüm endpoint'lerden tip hesapları alınamadı — fallback kullanılıyor`
  );
  _cachedTipAccounts = FALLBACK_TIP_ACCOUNTS;
  _tipCacheFetchedAt = now;
  return FALLBACK_TIP_ACCOUNTS;
}

/**
 * Rastgele bir Jito tip hesabı seçer.
 * Her bundle farklı tip hesabına gönderilir — yük dağılımı.
 */
export function getRandomTipAccount(accounts: string[]): PublicKey {
  const idx = Math.floor(Math.random() * accounts.length);
  return new PublicKey(accounts[idx]);
}

// ═══════════════════════════════════════════════════════════════════
// ║  Transaction Utilities                                          ║
// ═══════════════════════════════════════════════════════════════════

/**
 * VersionedTransaction'ın recentBlockhash'ini değiştirir ve mevcut imzaları temizler.
 * Jito bundle'ında tüm TX'lerin aynı blockhash kullanması tercih edilir.
 *
 * NOT: Blockhash değiştiğinde eski imzalar geçersiz olur — temizlenip
 * yeniden `tx.sign([signer])` çağrılmalıdır.
 */
export function replaceBlockhash(
  tx: VersionedTransaction,
  blockhash: string
): void {
  tx.message.recentBlockhash = blockhash;
  // Eski imzaları temizle — blockhash değişti, geçersiz oldular
  for (let i = 0; i < tx.signatures.length; i++) {
    tx.signatures[i] = new Uint8Array(64);
  }
}

/**
 * SOL transferi ile Jito tip TX'i oluşturur.
 * Genellikle bundle'ın son TX'i olarak eklenir.
 */
export async function buildTipTransaction(params: {
  payer: PublicKey;
  tipAccount: PublicKey;
  tipLamports: number;
  blockhash: string;
}): Promise<VersionedTransaction> {
  const ix = SystemProgram.transfer({
    fromPubkey: params.payer,
    toPubkey: params.tipAccount,
    lamports: params.tipLamports,
  });

  const messageV0 = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: params.blockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}

/**
 * Signed VersionedTransaction'ı base58 string'e çevirir.
 * Jito Bundle API base58-encoded signed TX'ler bekler.
 */
export function serializeTxBase58(tx: VersionedTransaction): string {
  return bs58.encode(tx.serialize());
}

/**
 * Signed TX'ten base58 signature string'i çıkarır.
 */
export function extractSignature(tx: VersionedTransaction): string | undefined {
  try {
    const sigBytes = tx.signatures[0];
    if (!sigBytes || sigBytes.every((b) => b === 0)) return undefined;
    return bs58.encode(sigBytes);
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ║  JSON-RPC Helper                                                ║
// ═══════════════════════════════════════════════════════════════════

/**
 * JSON-RPC çağrısı yapıcı — Jito Block Engine endpoint'ine.
 *
 * Özellikler:
 * - Çoklu endpoint round-robin (429'da sonraki bölgeye geç)
 * - 429 "rate limited" için exponential backoff ile retry
 * - Ardışık çağrılar arasında minimum bekleme (spacing)
 * - Her denemede farklı endpoint kullanılır
 */
async function jitoRpc<T>(method: string, params: unknown[]): Promise<T> {
  const bodyJson = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  for (let attempt = 0; attempt <= JITO_429_MAX_RETRIES; attempt++) {
    // ── Spacing: ardışık çağrılar arası minimum bekleme ──
    const now = Date.now();
    const elapsed = now - _lastJitoCallTimestamp;
    if (elapsed < JITO_MIN_CALL_SPACING_MS && attempt === 0) {
      const waitMs = JITO_MIN_CALL_SPACING_MS - elapsed;
      console.log(`[JITO-RATE] ${waitMs}ms spacing bekleniyor…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // ── 429 backoff (retry > 0) ──
    if (attempt > 0) {
      const backoffMs = JITO_429_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      advanceJitoEndpoint();
      console.warn(
        `[JITO-RETRY] ${method} — 429 retry ${attempt}/${JITO_429_MAX_RETRIES}, ` +
        `${backoffMs}ms backoff, sonraki endpoint: ${getNextJitoEndpoint().replace('https://', '').split('.')[0]}…`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    const baseUrl = getNextJitoEndpoint();
    const url = `${baseUrl}${BUNDLES_PATH}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson,
        signal: AbortSignal.timeout(JITO_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Timeout veya ağ hatası — sonraki endpoint'i dene
      if (attempt < JITO_429_MAX_RETRIES) {
        console.warn(
          `[JITO-RETRY] ${method} fetch hatası (${reason}) — retry…`
        );
        advanceJitoEndpoint();
        continue;
      }
      throw new JitoBundleError(
        `Jito ${method} fetch failed after ${JITO_429_MAX_RETRIES + 1} attempts: ${reason}`
      );
    }

    _lastJitoCallTimestamp = Date.now();

    // ── 429 Rate Limited → cooldown aktifle + fast-fail ──
    if (res.status === 429) {
      const bodyText = await res.text().catch(() => "");
      console.warn(
        `[JITO-RATE] ${method} HTTP 429 — ${baseUrl.replace('https://', '').split('.')[0]} ` +
        `(attempt ${attempt + 1}/${JITO_429_MAX_RETRIES + 1}): ${bodyText.slice(0, 120)}`
      );
      // Cooldown aktifle — sonraki trade'ler otomatik sequential'a düşer
      activateJitoCooldown();
      if (attempt === JITO_429_MAX_RETRIES) {
        throw new JitoBundleError(
          `Jito ${method} rate-limited: 429 — tüm endpoint'ler denendi, ` +
          `${JITO_429_MAX_RETRIES + 1} deneme sonrası başarısız (cooldown ${JITO_COOLDOWN_MS / 1000}s aktif)`
        );
      }
      continue; // retry with next endpoint
    }

    // ── Diğer HTTP hataları → hemen throw (400, 500 vb.) ──
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // 400 "cannot lock vote accounts" gibi hatalar retry ile düzelmez
      throw new JitoBundleError(
        `Jito ${method} HTTP ${res.status}: ${errBody}`
      );
    }

    const json = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    // ── JSON-RPC error (code -32097 = rate limited vb.) ──
    if (json.error) {
      const code = json.error.code;
      const isRateLimit = code === -32097 || code === -32602 ||
        json.error.message?.toLowerCase().includes("rate");

      if (isRateLimit) {
        // Cooldown aktifle — sonraki trade'ler sequential'a düşer
        activateJitoCooldown();

        if (attempt < JITO_429_MAX_RETRIES) {
          console.warn(
            `[JITO-RATE] ${method} RPC rate limited [${code}]: ${json.error.message} — retry…`
          );
          continue;
        }
      }

      throw new JitoBundleError(
        `Jito ${method} RPC error [${code}]: ${json.error.message}`
      );
    }

    return json.result as T;
  }

  // TypeScript exhaustiveness
  throw new JitoBundleError(`Jito ${method}: unexpected retry loop exit`);
}

// ═══════════════════════════════════════════════════════════════════
// ║  Error Types                                                    ║
// ═══════════════════════════════════════════════════════════════════

export class JitoBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JitoBundleError";
  }
}

// ═══════════════════════════════════════════════════════════════════
// ║  Bundle Result Types                                            ║
// ═══════════════════════════════════════════════════════════════════

export type JitoBundleStatus =
  | "Pending"
  | "Landed"
  | "Failed"
  | "Invalid"
  | "Timeout";

export interface JitoBundleResult {
  /** Jito tarafından verilen bundle UUID */
  bundleId: string;
  /** Bundle başarılı şekilde bir blokta yer aldı mı */
  success: boolean;
  /** Bundle'daki TX imzaları */
  signatures: string[];
  /** Landing slot numarası (başarılıysa) */
  landedSlot?: number;
  /** Hata nedeni */
  failReason?: string;
  /** Bundle durumu */
  status: JitoBundleStatus;
}

// ═══════════════════════════════════════════════════════════════════
// ║  Bundle Submission & Status                                     ║
// ═══════════════════════════════════════════════════════════════════

/**
 * Signed TX'leri Jito Block Engine'e bundle olarak gönderir.
 *
 * Bundle sırası önemlidir — TX'ler verilen sırada aynı blokta çalışır:
 *   [Leg1_swap, Leg2_swap, Tip_transfer]
 *
 * @returns Jito bundle UUID (durum takibi için)
 */
export async function sendJitoBundle(
  signedTxs: VersionedTransaction[]
): Promise<string> {
  const serialized = signedTxs.map(serializeTxBase58);

  console.log(`[JITO] Bundle gönderiliyor (${serialized.length} TX)…`);

  const bundleId = await jitoRpc<string>("sendBundle", [serialized]);

  console.log(`[JITO] Bundle kabul edildi — bundleId=${bundleId}`);
  return bundleId;
}

/**
 * Bundle'ın zincirde yer almasını (landing) bekler.
 * Belirli aralıklarla getBundleStatuses sorgular.
 *
 * Jito bundle durumları:
 * - "Pending"   → hâlâ işleniyor, validatöre gönderildi
 * - "Landed"    → başarılı, tüm TX'ler blokta yer aldı
 * - "Failed"    → bundle simülasyonu başarısız veya reddedildi
 * - "Invalid"   → geçersiz bundle formatı
 */
export async function waitForBundleLanding(
  bundleId: string,
  timeoutMs: number = BUNDLE_LANDING_TIMEOUT_MS
): Promise<JitoBundleResult> {
  const t0 = Date.now();

  console.log(
    `[JITO] Bundle landing bekleniyor: ${bundleId.slice(0, 16)}… ` +
      `(timeout=${timeoutMs}ms)`
  );

  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, BUNDLE_POLL_INTERVAL_MS));

    // ── Rate-limit cooldown aktifse polling'i erken sonlandır ──
    // getBundleStatuses 429 alınca cooldown aktifleşir; devam etmek anlamsız.
    if (!isJitoAvailable()) {
      console.warn(
        `[JITO] Rate-limited — bundle status polling erken sonlandırılıyor ` +
          `(${getJitoCooldownRemaining()}s cooldown). On-chain verify yapılacak.`
      );
      break;
    }

    try {
      interface BundleStatusValue {
        bundle_id: string;
        transactions: string[];
        slot: number;
        confirmation_status: string;
        err: { Ok: null } | { Err: unknown } | null;
      }

      interface BundleStatusResult {
        context: { slot: number };
        value: BundleStatusValue[];
      }

      const result = await jitoRpc<BundleStatusResult>(
        "getBundleStatuses",
        [[bundleId]]
      );

      if (!result?.value?.length) {
        // Henüz durum bilgisi yok — pending
        continue;
      }

      const info = result.value[0];
      const confStatus = info.confirmation_status;

      if (confStatus === "finalized" || confStatus === "confirmed") {
        // Bundle bir blokta yer aldı
        const hasError = info.err && "Err" in info.err;
        if (hasError) {
          const errMsg = JSON.stringify(info.err);
          console.warn(
            `[JITO] Bundle landed AMA on-chain hata: ${errMsg}`
          );
          return {
            bundleId,
            success: false,
            signatures: info.transactions ?? [],
            landedSlot: info.slot,
            failReason: `Bundle landed with on-chain error: ${errMsg}`,
            status: "Failed",
          };
        }

        console.log(
          `[JITO] ✓ Bundle LANDED! slot=${info.slot}, ` +
            `txCount=${info.transactions?.length ?? 0}, ` +
            `confirmation=${confStatus}`
        );
        return {
          bundleId,
          success: true,
          signatures: info.transactions ?? [],
          landedSlot: info.slot,
          status: "Landed",
        };
      }

      // Diğer durumlar (processed, vb.)
      const elapsedMs = Date.now() - t0;
      console.log(
        `[JITO] Bundle durumu: ${confStatus} (${elapsedMs}ms) — bekleniyor…`
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[JITO] getBundleStatuses hatası: ${reason} — retry…`
      );
    }
  }

  // Timeout — bundle belirli sürede land etmedi
  const elapsedMs = Date.now() - t0;
  console.warn(
    `[JITO] Bundle landing TIMEOUT (${elapsedMs}ms) — bundleId=${bundleId.slice(0, 16)}…`
  );
  return {
    bundleId,
    success: false,
    signatures: [],
    failReason: `Bundle landing timeout (${timeoutMs}ms)`,
    status: "Timeout",
  };
}

// ═══════════════════════════════════════════════════════════════════
// ║  High-Level: Atomic Bundle Preparation                          ║
// ═══════════════════════════════════════════════════════════════════

export interface PrepareAtomicBundleParams {
  /** Leg 1 swap TX (imzasız veya stale imzalı) */
  leg1Tx: VersionedTransaction;
  /** Leg 2 swap TX (imzasız veya stale imzalı) */
  leg2Tx: VersionedTransaction;
  /** Cüzdan keypair — tüm TX'leri imzalayacak */
  signer: Keypair;
  /** Tip miktarı (lamports). Varsayılan: config'ten okunur */
  tipLamports?: number;
}

export interface AtomicBundleData {
  /** Bundle'a dahil edilecek signed TX'ler: [Leg1, Leg2, Tip] */
  signedTxs: VersionedTransaction[];
  /** Ortak blockhash (tüm TX'ler bunu kullanır) */
  blockhash: string;
  /** Seçilen tip hesabı */
  tipAccount: PublicKey;
  /** Tip miktarı (lamports) */
  tipLamports: number;
  /** Her TX'in base58 signature'ı (on-chain doğrulama için) */
  txSignatures: string[];
}

/**
 * İki swap TX'i + tip TX'i tek bir Jito bundle'ına hazırlar.
 *
 * İşlem sırası:
 * 1. Taze blockhash al (tüm TX'ler için ortak)
 * 2. Tüm TX'lerin blockhash'ini eşitle (replaceBlockhash)
 * 3. Tip TX oluştur (aynı blockhash ile)
 * 4. Tüm TX'leri imzala (tek signer)
 * 5. TX imzalarını çıkar (on-chain doğrulama için)
 *
 * ⚠️ DİKKAT: Bu fonksiyon leg1Tx ve leg2Tx'i IN-PLACE değiştirir
 * (blockhash değişimi + imza). Orijinal TX'ler artık geçersizdir.
 *
 * @returns [Leg1, Leg2, Tip] sırasıyla hazırlanmış bundle
 */
export async function prepareAtomicBundle(
  params: PrepareAtomicBundleParams
): Promise<AtomicBundleData> {
  const cfg = loadConfig();
  const connection = getConnection();

  // 1. Taze blockhash al
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  console.log(`[JITO] Ortak blockhash: ${blockhash.slice(0, 16)}…`);

  // 2. Tüm TX'lerin blockhash'ini eşitle
  replaceBlockhash(params.leg1Tx, blockhash);
  replaceBlockhash(params.leg2Tx, blockhash);

  // 3. Tip TX oluştur
  const tipLamports =
    params.tipLamports ?? cfg.jitoTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS;
  const tipAccounts = await getJitoTipAccounts();
  const tipAccount = getRandomTipAccount(tipAccounts);

  console.log(
    `[JITO] Tip: ${tipLamports} lamports → ${tipAccount.toBase58().slice(0, 12)}…`
  );

  const tipTx = await buildTipTransaction({
    payer: params.signer.publicKey,
    tipAccount,
    tipLamports,
    blockhash,
  });

  // 4. Tüm TX'leri imzala
  params.leg1Tx.sign([params.signer]);
  params.leg2Tx.sign([params.signer]);
  tipTx.sign([params.signer]);

  const signedTxs = [params.leg1Tx, params.leg2Tx, tipTx];

  // 5. TX imzalarını çıkar
  const txSignatures = signedTxs.map(
    (tx) => extractSignature(tx) ?? "unknown"
  );

  console.log(
    `[JITO] Bundle hazır — ${signedTxs.length} TX:\n` +
      `  Leg1: ${txSignatures[0].slice(0, 16)}…\n` +
      `  Leg2: ${txSignatures[1].slice(0, 16)}…\n` +
      `  Tip:  ${txSignatures[2].slice(0, 16)}…`
  );

  return {
    signedTxs,
    blockhash,
    tipAccount,
    tipLamports,
    txSignatures,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ║  On-Chain TX Verification (bundle sonrası)                      ║
// ═══════════════════════════════════════════════════════════════════

export interface TxVerifyResult {
  signature: string;
  confirmed: boolean;
  err?: string;
}

/**
 * Bir TX signature'ının zincirde confirm olup olmadığını kontrol eder.
 * Bundle land etmediğinde veya hata döndüğünde bireysel TX'leri doğrulamak için.
 */
export async function verifyTxOnChainJito(
  signature: string,
  timeoutMs: number = 8_000
): Promise<TxVerifyResult> {
  try {
    const connection = getConnection();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1_500));

    while (Date.now() - t0 < timeoutMs) {
      const resp = await connection.getSignatureStatuses([signature]);
      const status = resp.value?.[0];
      if (status) {
        const level = status.confirmationStatus;
        if (level === "confirmed" || level === "finalized") {
          return {
            signature,
            confirmed: true,
            err: status.err ? JSON.stringify(status.err) : undefined,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return { signature, confirmed: false };
  } catch {
    return { signature, confirmed: false };
  }
}

/**
 * Bundle'daki Leg1 ve Leg2 TX'lerinin on-chain durumunu kontrol eder.
 * Bundle timeout veya hata sonrası hangisinin başarılı olduğunu belirler.
 *
 * Sonuçlar:
 * - bothSucceeded: Her iki TX de on-chain başarılı
 * - leg1Only: Sadece Leg1 on-chain (Leg2 yok/hatalı) — UNWIND GEREKLİ
 * - neitherLanded: Hiçbiri on-chain — temiz başarısızlık
 */
export async function checkBundleTxResults(
  leg1Sig: string,
  leg2Sig: string
): Promise<{
  outcome: "bothSucceeded" | "leg1Only" | "neitherLanded" | "bothFailed";
  leg1: TxVerifyResult;
  leg2: TxVerifyResult;
}> {
  console.log(
    `[JITO-VERIFY] Bundle TX'leri on-chain kontrol ediliyor…\n` +
      `  Leg1: ${leg1Sig.slice(0, 16)}…\n` +
      `  Leg2: ${leg2Sig.slice(0, 16)}…`
  );

  const [leg1, leg2] = await Promise.all([
    verifyTxOnChainJito(leg1Sig, 10_000),
    verifyTxOnChainJito(leg2Sig, 10_000),
  ]);

  let outcome: "bothSucceeded" | "leg1Only" | "neitherLanded" | "bothFailed";

  if (leg1.confirmed && !leg1.err && leg2.confirmed && !leg2.err) {
    outcome = "bothSucceeded";
    console.log(`[JITO-VERIFY] ✓ Her iki TX de on-chain başarılı!`);
  } else if (leg1.confirmed && !leg1.err && (!leg2.confirmed || leg2.err)) {
    outcome = "leg1Only";
    console.warn(
      `[JITO-VERIFY] ⚠ Sadece Leg1 on-chain! Leg2 ${
        leg2.confirmed ? `hata: ${leg2.err}` : "bulunamadı"
      } — UNWIND GEREKLİ`
    );
  } else if (!leg1.confirmed && !leg2.confirmed) {
    outcome = "neitherLanded";
    console.log(
      `[JITO-VERIFY] Hiçbir TX on-chain değil — temiz başarısızlık.`
    );
  } else {
    outcome = "bothFailed";
    console.log(
      `[JITO-VERIFY] Her iki TX de hatalı veya beklenmedik durum.`
    );
  }

  return { outcome, leg1, leg2 };
}
