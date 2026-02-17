import { performance } from "perf_hooks";
import { SlotDriver } from "./slotDriver.js";
import { Direction, SendError } from "../types.js";
import {
  buildAndSimulate,
  sendWithRetry,
  estimateDirectionProfit,
  QuoteEstimate,
} from "../execution.js";
import { buildTelemetry, appendTradeLog } from "../telemetry.js";
import { Keypair } from "@solana/web3.js";
import { getKeypairFromEnv } from "../wallet.js";
import { loadConfig } from "../config.js";
import { tradeLock } from "../tradeLock.js";

/** Her döngüde taranacak iki yön */
const DIRECTIONS: readonly Direction[] = ["JUP_TO_OKX", "OKX_TO_JUP"] as const;

/** İnsan-okunur yön etiketi (log & telemetri) */
function dirLabel(d: Direction): string {
  return d === "JUP_TO_OKX" ? "JUP → OKX" : "OKX → JUP";
}

/**
 * Bi-directional PriceTicker — Event-driven driver.
 *
 * Her uygun slot'ta iki yönü ardışık (staggered) olarak tarar,
 * OKX rate-limit'ine (429) çarpmamak için araya STAGGER_DELAY_MS bırakır.
 * En kârlı rotayı seçer, tam build+simulate+send yapar.
 * Global tradeLock her iki yönü de kapsar; aynı anda sadece bir işlem çalışır.
 */
export class PriceTicker {
  private slotDriver: SlotDriver;
  private readonly slotsPerCheck: number;
  private slotCounter = 0;
  private readonly owner: Keypair;
  /** Timestamp (ms) of the last API quote request */
  private lastCheckTime = 0;
  /** Minimum ms between consecutive API calls (from API_COOLDOWN_MS) */
  private readonly apiCooldownMs: number;
  /**
   * OKX rate-limit'ine çarpmamak için iki yön taraması arasına
   * konulan bekleme süresi (ms). Env ile override edilebilir.
   */
  private readonly staggerDelayMs: number;

  /**
   * TRADE_AMOUNT_USDC env değişkeninden dinamik olarak okunur.
   * Her tick'te güncel değeri alır; tanımsızsa varsayılan 1 USDC kullanılır.
   */
  private get notionalUsd(): number {
    const raw = process.env.TRADE_AMOUNT_USDC;
    const val = raw ? Number(raw) : 1;
    if (Number.isNaN(val) || val <= 0) {
      console.warn(
        `[PriceTicker] Geçersiz TRADE_AMOUNT_USDC="${raw}", varsayılan 1 kullanılıyor`
      );
      return 1;
    }
    return val;
  }

  constructor(params: { slotsPerCheck?: number }) {
    this.slotDriver = new SlotDriver();
    this.slotsPerCheck = params.slotsPerCheck ?? 4;
    this.owner = getKeypairFromEnv();
    this.apiCooldownMs = loadConfig().apiCooldownMs;
    this.staggerDelayMs = Number(process.env.STAGGER_DELAY_MS ?? 2000);
  }

  start() {
    console.log(
      `[PriceTicker] Çift yönlü (bi-directional) tarama aktif — ` +
        `her tick'te JUP↔OKX staggered quote (delay=${this.staggerDelayMs}ms)`
    );
    this.slotDriver.start();

    this.slotDriver.onSlot(async (slot) => {
      this.slotCounter += 1;
      if (this.slotCounter % this.slotsPerCheck !== 0) return;

      // ── Cooldown throttle ──
      const now = Date.now();
      if (now - this.lastCheckTime < this.apiCooldownMs) return;
      this.lastCheckTime = now;

      // ── Trade Lock (global mutex — her iki yönü de kapsar) ──
      const lockResult = tradeLock.tryAcquire();
      if (!lockResult.acquired) {
        if (lockResult.skipReason === "EXECUTING") {
          console.log(`[SKIP] İşlem sürüyor — slot ${slot} atlandı`);
        } else {
          console.log(
            `[SKIP] Cooldown aktif (${lockResult.cooldownRemainingMs}ms kaldı) — slot ${slot} atlandı`
          );
        }
        return;
      }

      const startMs = performance.now();
      try {
        const ownerStr = this.owner.publicKey.toBase58();
        const notional = this.notionalUsd;

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 1 — Staggered quote: iki yönü ardışık tara           ║
        // ║  OKX 429 rate-limit'ini önlemek için araya delay koyuyoruz  ║
        // ╚══════════════════════════════════════════════════════════════╝
        console.log(
          `[SCAN] Slot ${slot} — iki yön staggered quote başlatılıyor (${notional} USDC, delay=${this.staggerDelayMs}ms)…`
        );

        const viable: QuoteEstimate[] = [];

        for (const [i, dir] of DIRECTIONS.entries()) {
          // İkinci yönden önce stagger delay bekle
          if (i > 0 && this.staggerDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.staggerDelayMs));
          }
          try {
            const q = await estimateDirectionProfit({
              direction: dir,
              notionalUsd: notional,
              ownerStr,
            });
            console.log(
              `[SCAN][${dirLabel(dir)}] Brüt: ${q.grossProfitUsdc.toFixed(6)} USDC | ` +
                `Fee: ${q.estimatedFeeUsdc.toFixed(6)} USDC | ` +
                `Net: ${q.netProfitUsdc.toFixed(6)} USDC ` +
                (q.viable ? "✓ VİABLE" : "✗ düşük")
            );
            if (q.viable) viable.push(q);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`[SCAN][${dirLabel(dir)}] Quote hatası: ${reason}`);
          }
        }

        if (viable.length === 0) {
          console.log(
            `[SCAN] Slot ${slot} — her iki yönde de kârlı rota yok, atlanıyor`
          );
          return;
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 2 — En iyi rotayı seç                               ║
        // ╚══════════════════════════════════════════════════════════════╝
        const best = viable.reduce((a, b) =>
          a.netProfitUsdc >= b.netProfitUsdc ? a : b
        );
        console.log(
          `[SCAN] ★ Kazanan rota: ${dirLabel(best.direction)} — ` +
            `Tahmini net kâr: ${best.netProfitUsdc.toFixed(6)} USDC`
        );

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 3 — Tam build + simulate (kazanan yön)               ║
        // ╚══════════════════════════════════════════════════════════════╝
        const result = await buildAndSimulate({
          direction: best.direction,
          notionalUsd: notional,
          owner: this.owner.publicKey,
          dryRun: false,
        });

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 4 — LIVE: İşlemi zincire gönder                     ║
        // ╚══════════════════════════════════════════════════════════════╝
        console.log(
          `[LIVE][${dirLabel(best.direction)}] Net kâr onaylandı ` +
            `(${result.netProfit.netProfitUsdc.toFixed(6)} USDC) — ` +
            `${result.legs.length} leg gönderiliyor…`
        );

        const signatures: string[] = [];
        for (const [idx, leg] of result.legs.entries()) {
          console.log(
            `[LIVE][${dirLabel(best.direction)}] Leg ${idx + 1}/${result.legs.length} ` +
              `(${leg.venue}) gönderiliyor…`
          );
          const sendResult = await sendWithRetry(leg.tx, this.owner);
          if (sendResult.finalSignature) {
            signatures.push(sendResult.finalSignature);
            console.log(
              `[LIVE][${dirLabel(best.direction)}] Leg ${idx + 1} başarılı ✓ ` +
                `sig=${sendResult.finalSignature}`
            );
          }
        }

        // ── Başarılı gönderim telemetrisi ──
        const tel = buildTelemetry({
          build: result,
          direction: best.direction,
          sendSignatures: signatures,
          success: true,
          status: "SEND_SUCCESS",
          netProfit: result.netProfit,
        });
        appendTradeLog(tel);
        console.log(
          `[LIVE][${dirLabel(best.direction)}] Tüm leg'ler gönderildi ✓ ` +
            `signatures=[${signatures.join(", ")}]`
        );
      } catch (e) {
        if (e instanceof SendError) {
          console.error(`[LIVE][SEND_FAILED] ${e.message}`);
        } else {
          // Quote/slippage/sim/net profit hataları execution.ts tarafından telemetri yazılır
          console.warn("[PriceTicker] error:", e);
        }
      } finally {
        tradeLock.release();
        const endMs = performance.now();
        const latencyMs = Math.round(endMs - startMs);
        console.info(
          `[LATENCY] Slot: ${slot} | E2E Bi-Directional Cycle: ${latencyMs}ms`
        );
      }
    });
  }

  stop() {
    this.slotDriver.stop();
  }
}
