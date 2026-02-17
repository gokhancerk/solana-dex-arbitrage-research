import { performance } from "perf_hooks";
import { SlotDriver } from "./slotDriver.js";
import { Direction } from "../types.js";
import { buildAndSimulate } from "../execution.js";
import { Keypair } from "@solana/web3.js";
import { getKeypairFromEnv } from "../wallet.js";
import { loadConfig } from "../config.js";
import { tradeLock } from "../tradeLock.js";

/**
 * Event-driven driver: on each new slot, optionally trigger a quote/sim cycle.
 * Backoff/throttle logic can be expanded to avoid redundant work; current implementation
 * triggers at a fixed cadence defined by slotsPerCheck.
 */
export class PriceTicker {
  private slotDriver: SlotDriver;
  private readonly slotsPerCheck: number;
  private slotCounter = 0;
  private readonly owner: Keypair;
  private readonly direction: Direction;
  /** Timestamp (ms) of the last API quote request */
  private lastCheckTime = 0;
  /** Minimum ms between consecutive API calls (from API_COOLDOWN_MS) */
  private readonly apiCooldownMs: number;

  /**
   * TRADE_AMOUNT_USDC env değişkeninden dinamik olarak okunur.
   * Her tick'te güncel değeri alır; tanımsızsa varsayılan 1 USDC kullanılır.
   */
  private get notionalUsd(): number {
    const raw = process.env.TRADE_AMOUNT_USDC;
    const val = raw ? Number(raw) : 1;
    if (Number.isNaN(val) || val <= 0) {
      console.warn(`[PriceTicker] Geçersiz TRADE_AMOUNT_USDC="${raw}", varsayılan 1 kullanılıyor`);
      return 1;
    }
    return val;
  }

  constructor(params: { slotsPerCheck?: number; direction: Direction }) {
    this.slotDriver = new SlotDriver();
    this.slotsPerCheck = params.slotsPerCheck ?? 4;
    this.owner = getKeypairFromEnv();
    this.direction = params.direction;
    this.apiCooldownMs = loadConfig().apiCooldownMs;
  }

  start() {
    this.slotDriver.start();
    this.slotDriver.onSlot(async (slot) => {
      this.slotCounter += 1;
      if (this.slotCounter % this.slotsPerCheck !== 0) return;

      // ── Cooldown throttle: son API isteğinden beri yeterince süre geçmediyse atla ──
      const now = Date.now();
      if (now - this.lastCheckTime < this.apiCooldownMs) {
        return; // slot'u görmezden gel, cooldown dolmadı
      }
      this.lastCheckTime = now;

      // ── Trade Lock: eşzamanlı işlem veya trade cooldown aktifse atla ──
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
        const result = await buildAndSimulate({ direction: this.direction, notionalUsd: this.notionalUsd, owner: this.owner.publicKey, dryRun: true });
        // Telemetri artık execution.ts içinde yazılıyor (her kod yolunda).
      } catch (e) {
        // Telemetri artık execution.ts içinde throw'dan önce yazılıyor.
        // Burada sadece terminale loglama yapılır.
        console.warn("price ticker sim error", e);
      } finally {
        tradeLock.release();
        const endMs = performance.now();
        const latencyMs = Math.round(endMs - startMs);
        console.info(`[LATENCY] Slot: ${slot} | E2E Quote & Sim Suresi: ${latencyMs}ms`);
      }
    });
  }

  stop() {
    this.slotDriver.stop();
  }
}
