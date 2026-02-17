/**
 * TradeLock — Cooldown & Mutex guard for trade execution.
 *
 * Prevents:
 *  1. Concurrent trade execution (isExecuting mutex)
 *  2. Rapid-fire trades draining gas (TRADE_COOLDOWN_MS cooldown)
 *
 * Usage:
 *   if (!tradeLock.tryAcquire()) return; // skip this tick
 *   try { await executeTradeFlow(); }
 *   finally { tradeLock.release(); }
 */

import { loadConfig } from "./config.js";

export type SkipReason = "EXECUTING" | "COOLDOWN";

export interface TryAcquireResult {
  acquired: boolean;
  skipReason?: SkipReason;
  /** ms remaining until cooldown expires (only when skipReason === "COOLDOWN") */
  cooldownRemainingMs?: number;
}

class TradeLock {
  /** Mutex flag — true while a trade flow (sim / send) is in-progress */
  private isExecuting = false;
  /** Epoch-ms timestamp of the last completed trade */
  private lastTradeTime = 0;

  /**
   * Attempt to acquire the trade lock.
   *
   * Returns `{ acquired: true }` if the caller may proceed.
   * Returns `{ acquired: false, skipReason }` if the tick should be skipped.
   *
   * This is intentionally *synchronous* to eliminate any async race-condition
   * window between the check and the flag-set.
   */
  tryAcquire(): TryAcquireResult {
    if (this.isExecuting) {
      return { acquired: false, skipReason: "EXECUTING" };
    }

    const cfg = loadConfig();
    const now = Date.now();
    const elapsed = now - this.lastTradeTime;

    if (elapsed < cfg.tradeCooldownMs) {
      return {
        acquired: false,
        skipReason: "COOLDOWN",
        cooldownRemainingMs: cfg.tradeCooldownMs - elapsed,
      };
    }

    // ── Lock acquired ──
    this.isExecuting = true;
    return { acquired: true };
  }

  /**
   * Release the lock after the trade flow completes (success or failure).
   * Updates `lastTradeTime` so the cooldown window starts from *now*.
   *
   * MUST be called in a `finally` block to avoid deadlocking the bot.
   */
  release(): void {
    this.lastTradeTime = Date.now();
    this.isExecuting = false;
  }

  // ── Introspection (telemetry / dashboard) ──

  get executing(): boolean {
    return this.isExecuting;
  }

  get lastTradeTimestamp(): number {
    return this.lastTradeTime;
  }

  /** Remaining cooldown in ms; 0 when cooldown has expired. */
  get cooldownRemainingMs(): number {
    const cfg = loadConfig();
    const remaining = cfg.tradeCooldownMs - (Date.now() - this.lastTradeTime);
    return remaining > 0 ? remaining : 0;
  }
}

/** Singleton — import this instance across the project */
export const tradeLock = new TradeLock();
