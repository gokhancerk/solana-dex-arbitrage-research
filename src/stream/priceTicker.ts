import { performance } from "perf_hooks";
import { SlotDriver } from "./slotDriver.js";
import { Direction } from "../types.js";
import { buildAndSimulate } from "../execution.js";
import { Keypair } from "@solana/web3.js";
import { getKeypairFromEnv } from "../wallet.js";

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
  private readonly notionalUsd: number;

  constructor(params: { slotsPerCheck?: number; direction: Direction; notionalUsd: number }) {
    this.slotDriver = new SlotDriver();
    this.slotsPerCheck = params.slotsPerCheck ?? 4;
    this.owner = getKeypairFromEnv();
    this.direction = params.direction;
    this.notionalUsd = params.notionalUsd;
  }

  start() {
    this.slotDriver.start();
    this.slotDriver.onSlot(async (slot) => {
      this.slotCounter += 1;
      if (this.slotCounter % this.slotsPerCheck !== 0) return;
      const startMs = performance.now();
      try {
        await buildAndSimulate({ direction: this.direction, notionalUsd: this.notionalUsd, owner: this.owner.publicKey });
      } catch (e) {
        // log and continue; user should plug in structured logger
        console.warn("price ticker sim error", e);
      } finally {
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
