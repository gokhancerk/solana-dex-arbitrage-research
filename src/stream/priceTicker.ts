import { performance } from "perf_hooks";
import { SlotDriver } from "./slotDriver.js";
import { Direction, SendError, RealizedPnlInfo, LatencyMetrics, JitoBundleTelemetry } from "../types.js";
import {
  buildAndSimulate,
  sendWithRetry,
  estimateDirectionProfit,
  pairFromToken,
  QuoteEstimate,
  buildFreshLeg2,
  emergencyUnwind,
  resolvePriorityFee,
  executeAtomicArbitrage,
  refreshLeg1ForSequential,
} from "../execution.js";
import { buildTelemetry, appendTradeLog } from "../telemetry.js";
import { Keypair } from "@solana/web3.js";
import { getKeypairFromEnv } from "../wallet.js";
import { loadConfig, type TokenSymbol, type TradePair } from "../config.js";
import { tradeLock } from "../tradeLock.js";
import { waitForConfirmation } from "../solana.js";
import { takeBalanceSnapshot, computeRealizedPnl, type RealizedPnl } from "../balanceSnapshot.js";
import { isJitoAvailable, getJitoCooldownRemaining } from "../jito.js";
import { isMarketEligible, getCachedClassification } from "../marketFilter.js";
import type { MarketClassification } from "../types.js";

/** Her döngüde taranacak iki yön */
const DIRECTIONS: readonly Direction[] = ["JUP_TO_OKX", "OKX_TO_JUP"] as const;

/** İnsan-okunur yön etiketi (log & telemetri) */
function dirLabel(d: Direction): string {
  return d === "JUP_TO_OKX" ? "JUP → OKX" : "OKX → JUP";
}

/**
 * Bi-directional PriceTicker — Round-Robin multi-token driver.
 *
 * Her tick'te yalnızca BİR token çifti taranır (rate-limit koruması):
 *   Tick 1: SOL/USDC (iki yön PARALEL)
 *   Tick 2: WIF/USDC (iki yön PARALEL)
 *   Tick 3: JUP/USDC …
 *
 * Config'den scanTokens listesi okunur (varsayılan: SOL, WIF, JUP).
 * Env ile override: SCAN_TOKENS=SOL,WIF,JUP
 *
 * İki yön PARALEL taranır (stagger delay kaldırıldı) — Jupiter ve OKX
 * farklı API'lar olduğundan aynı anda çağrılabilir.
 *
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
  /** Config'den gelen taranacak token listesi */
  private readonly scanTokens: readonly TokenSymbol[];

  /**
   * Round-Robin index — hangi token'ın sırada olduğunu takip eder.
   * Her başarılı tick'ten sonra bir sonraki token'a geçer.
   */
  private roundRobinIndex = 0;

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

  /** Round-Robin sırasındaki mevcut target token */
  private get currentToken(): TokenSymbol {
    return this.scanTokens[this.roundRobinIndex % this.scanTokens.length];
  }

  /** Round-Robin'i bir sonraki token'a ilerlet */
  private advanceRoundRobin(): void {
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.scanTokens.length;
  }

  constructor(params: { slotsPerCheck?: number }) {
    this.slotDriver = new SlotDriver();
    this.slotsPerCheck = params.slotsPerCheck ?? 2; // 2 slot = ~0.8s — daha hızlı tarama
    this.owner = getKeypairFromEnv();
    const cfg = loadConfig();
    this.apiCooldownMs = cfg.apiCooldownMs;
    this.scanTokens = cfg.scanTokens;
  }

  start() {
    const cfg = loadConfig();
    const isDryRun = cfg.dryRun;
    console.log(
      `[PriceTicker] ${isDryRun ? "★ DRY-RUN MODU AKTİF — TX gönderilmeyecek ★" : "LIVE MOD"} | ` +
        `Round-Robin çoklu-token tarama aktif — ` +
        `tokenlar=[${this.scanTokens.join(", ")}], ` +
        `her tick'te tek token, çift yönlü PARALEL` +
        (isDryRun
          ? ``
          : cfg.useJitoBundle
            ? ` | ★ JITO BUNDLE AKTİF (atomik çalışma)`
            : ` | Sequential mod (Leg1→confirm→Leg2)`)
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
      const targetToken = this.currentToken;
      const pair: TradePair = pairFromToken(targetToken);

      // ── Latency Instrumentation ──
      // detectSlot/detectTimestamp are set AFTER a profitable opportunity
      // is confirmed (not at cycle start) to avoid inflated D2S metrics.
      const cycleSlot = slot;
      let detectSlot = slot;
      let detectTimestamp = 0;
      let quoteLatencyMs = 0;
      let quoteReceivedTimestamp = 0;
      let buildLatencyMs = 0;
      let simulationLatencyMs = 0;
      let detectToSendLatencyMs = 0;
      let executionMode: LatencyMetrics["executionMode"] = "SEQUENTIAL";
      let cycleLatencyMetrics: LatencyMetrics | undefined;
      let cycleJitoBundleTelemetry: JitoBundleTelemetry | undefined;
      let marketClass: MarketClassification | undefined;
      let expectedNetProfitUsdc: number | undefined;

      try {
        const ownerStr = this.owner.publicKey.toBase58();
        const notional = this.notionalUsd;

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 0 — Dinamik priority fee resolve et (cache'li)         ║
        // ╚══════════════════════════════════════════════════════════════╝
        await resolvePriorityFee();

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 0.5 — Market Type Filter (Type C gating)              ║
        // ║  Only Type C markets are eligible for live execution.        ║
        // ║  Classification is cached (60s TTL) — minimal overhead.      ║
        // ╚══════════════════════════════════════════════════════════════╝
        marketClass = getCachedClassification(targetToken);
        if (!marketClass) {
          try {
            marketClass = await isMarketEligible(targetToken);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(
              `[MARKET-FILTER] ${pair} classification hatası: ${reason} — filtre atlanıyor`
            );
          }
        }
        // If market is classified and NOT eligible (not Type C), skip this tick
        // DRY-RUN modda market filter bypass edilir — latency test verisi toplamak için
        if (marketClass && !marketClass.eligible) {
          if (isDryRun) {
            console.log(
              `[MARKET-FILTER][DRY-RUN-BYPASS] ${pair} → Type ${marketClass.type} ` +
                `(eligible=false) — dry-run modda filtre ATLANARAK devam ediliyor`
            );
          } else {
            console.log(
              `[MARKET-FILTER][SKIP] ${pair} → Type ${marketClass.type} (eligible=false) — ` +
                `impact_3k=${marketClass.impact3k.toFixed(4)}% | ` +
                `reject: [${marketClass.rejectReasons.join("; ")}] — atlanıyor`
            );
            return;
          }
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 1 — Round-Robin: bu tick'te tek token, iki yön        ║
        // ║  PARALEL tara (Jupiter & OKX farklı API'lar)                ║
        // ╚══════════════════════════════════════════════════════════════╝
        console.log(
          `[SCAN] Slot ${slot} — ${pair} çift yönlü PARALEL quote başlatılıyor ` +
            `(${notional} USDC)…`
        );

        // ── Latency Hook: quote start ──
        const quoteStartMs = performance.now();

        // Paralel: her iki yönü aynı anda tara
        const quotePromises = DIRECTIONS.map(async (dir) => {
          try {
            const q = await estimateDirectionProfit({
              direction: dir,
              notionalUsd: notional,
              ownerStr,
              targetToken,
            });
            console.log(
              `[SCAN][${pair}][${dirLabel(dir)}] Brüt: ${q.grossProfitUsdc.toFixed(6)} USDC | ` +
                `Fee: ${q.estimatedFeeUsdc.toFixed(6)} USDC | ` +
                `Net: ${q.netProfitUsdc.toFixed(6)} USDC ` +
                (q.viable ? "✓ VİABLE" : "✗ düşük")
            );
            return q;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`[SCAN][${pair}][${dirLabel(dir)}] Quote hatası: ${reason}`);
            return null;
          }
        });

        const results = await Promise.all(quotePromises);

        // ── Latency Hook: quote end ──
        quoteLatencyMs = Math.round(performance.now() - quoteStartMs);
        quoteReceivedTimestamp = Date.now();

        // ── SPREAD BUFFER: Estimate aşamasında 1.5x min profit gerekli ──
        // Tahmini kâr her zaman gerçek kârdan ~50% daha iyi çıkıyor (MEV, fiyat kayması).
        // Bu buffer, sadece yeterince geniş spread'lerde trade eden bir filtre ekler.
        const SPREAD_BUFFER = 1.5;
        const effectiveMinProfit = loadConfig().minNetProfitUsdc * SPREAD_BUFFER;
        const viable = results.filter(
          (q): q is QuoteEstimate => q !== null && q.netProfitUsdc >= effectiveMinProfit
        );

        if (viable.length === 0) {
          // Orijinal viable kontrolü (buffer'sız) ile karşılaştır — bilgilendirme logu
          const marginal = results.filter(
            (q): q is QuoteEstimate => q !== null && q.viable
          );
          if (marginal.length > 0) {
            const best = marginal.reduce((a, b) => a.netProfitUsdc >= b.netProfitUsdc ? a : b);
            console.log(
              `[SCAN] Slot ${slot} — ${pair} spread buffer altında ` +
                `(en iyi: ${best.netProfitUsdc.toFixed(6)} USDC < buffer: ${effectiveMinProfit.toFixed(4)} USDC), atlanıyor`
            );
          } else {
            console.log(
              `[SCAN] Slot ${slot} — ${pair} her iki yönde de kârlı rota yok, atlanıyor`
            );
          }
          return;
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 2 — En iyi rotayı seç                               ║
        // ╚══════════════════════════════════════════════════════════════╝
        const best = viable.reduce((a, b) =>
          a.netProfitUsdc >= b.netProfitUsdc ? a : b
        );
        console.log(
          `[SCAN] ★ Kazanan rota: ${pair} ${dirLabel(best.direction)} — ` +
            `Tahmini net kâr: ${best.netProfitUsdc.toFixed(6)} USDC`
        );

        // ── Latency Hook: DETECT POINT ──
        // Detect = profitable opportunity identified (NOT tick start).
        // This is the correct measurement point for D2S latency.
        detectSlot = cycleSlot;
        detectTimestamp = Date.now();
        expectedNetProfitUsdc = best.netProfitUsdc;

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 3 — Tam build + simulate (kazanan yön)               ║
        // ╚══════════════════════════════════════════════════════════════╝
        // ── Latency Hook: build+simulate start ──
        const buildStartMs = performance.now();

        let result = await buildAndSimulate({
          direction: best.direction,
          notionalUsd: notional,
          owner: this.owner.publicKey,
          targetToken,
          dryRun: isDryRun,
          cachedEstimate: best,
        });

        // ── Latency Hook: build+simulate end ──
        const buildEndMs = performance.now();
        buildLatencyMs = Math.round(buildEndMs - buildStartMs);
        // Simulation is embedded in build — approximate as build time (sim may be skipped in live mode)
        simulationLatencyMs = buildLatencyMs;

        // Finalize latency metrics now (detectToSend will be updated before actual send)
        const buildLatencyMetrics = (): LatencyMetrics => {
          const sendTimestamp = Date.now();
          detectToSendLatencyMs = sendTimestamp - detectTimestamp;
          const quoteToSendMs = sendTimestamp - quoteReceivedTimestamp;
          cycleLatencyMetrics = {
            detectSlot,
            detectTimestamp,
            quoteLatencyMs,
            buildLatencyMs,
            simulationLatencyMs,
            detectToSendLatencyMs,
            executionMode,
            quoteReceivedTimestamp,
            quoteToSendLatencyMs: quoteToSendMs,
          };
          return cycleLatencyMetrics;
        };

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  DRY-RUN GUARD — TX gönderilmez, sadece telemetri yazılır   ║
        // ╚══════════════════════════════════════════════════════════════╝
        if (isDryRun) {
          console.log(
            `[DRY-RUN][${pair}][${dirLabel(best.direction)}] Simülasyon tamamlandı — ` +
              `net kâr: ${result.netProfit.netProfitUsdc.toFixed(6)} USDC | ` +
              `TX gönderilmiyor (dry-run modu aktif)`
          );
          result.legs.forEach((leg, idx) => {
            const status = leg.simulation.error ? "⚠ SIM HATASI" : "✓ SIM OK";
            console.log(
              `[DRY-RUN]  Leg ${idx + 1}: ${leg.venue} ${status} | ` +
                `expectedOut=${leg.expectedOut} | ` +
                `simulatedOut=${leg.simulatedOut ?? "n/a"} | ` +
                `slippageBps=${leg.effectiveSlippageBps ?? "n/a"}`
            );
          });
          const tel = buildTelemetry({
            build: result,
            direction: best.direction,
            targetToken,
            success: true,
            status: "DRY_RUN_SIM_OK",
            netProfit: result.netProfit,
            latencyMetrics: buildLatencyMetrics(),
            marketClassification: marketClass,
            expectedNetProfitUsdc,
          });
          appendTradeLog(tel);
          return; // dry-run: TX gönderilmez, finally bloğu ile round-robin ilerler
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 4 — LIVE EXECUTION                                      ║
        // ║  Jito aktifse: Atomic bundle (Leg1+Leg2+Tip → tek blok)       ║
        // ║  Değilse: Sequential (Leg1→confirm→Leg2)                      ║
        // ╚══════════════════════════════════════════════════════════════════╝
        console.log(
          `[LIVE][${pair}][${dirLabel(best.direction)}] Net kâr onaylandı ` +
            `(${result.netProfit.netProfitUsdc.toFixed(6)} USDC) — ` +
            `${result.legs.length} leg gönderiliyor…`
        );
        // ── PRE-TRADE BALANCE SNAPSHOT ──
        console.log(`[SNAPSHOT] Pre-trade bakiye çekiliyor…`);
        const preSnapshot = await takeBalanceSnapshot(this.owner.publicKey);

        // Helper: RealizedPnl → RealizedPnlInfo dönüştürücü
        const toRealizedPnlInfo = (r: RealizedPnl): RealizedPnlInfo => ({
          deltaUsdc: r.deltaUsdc,
          deltaSol: r.deltaSol,
          solCostUsdc: r.solCostUsdc,
          realizedNetProfitUsdc: r.realizedNetProfitUsdc,
          solUsdcRate: r.solUsdcRate,
          preUsdcRaw: r.preSnapshot.usdcRaw.toString(),
          postUsdcRaw: r.postSnapshot.usdcRaw.toString(),
          preSolLamports: r.preSnapshot.solLamports.toString(),
          postSolLamports: r.postSnapshot.solLamports.toString(),
        });

        const useJito = loadConfig().useJitoBundle;
        const jitoReady = useJito && isJitoAvailable();
        let executedSuccessfully = false;

        if (useJito && !jitoReady) {
          console.log(
            `[JITO-FALLBACK][${pair}] Jito rate-limited (cooldown: ${getJitoCooldownRemaining()}s kaldı) → sequential mode`
          );
        }

        if (jitoReady) {
          // ═══════════════════════════════════════════════════════════
          // ║  JITO BUNDLE PATH — Atomik 2-leg çalışma                ║
          // ║  Leg1 + Leg2 + Tip → tek bundle → aynı blokta           ║
          // ║  Emergency unwind sadece çok nadir Leg1-only durumda     ║
          // ═══════════════════════════════════════════════════════════
          executionMode = "JITO";
          console.log(
            `[JITO][${pair}][${dirLabel(best.direction)}] Atomik bundle gönderiliyor…`
          );

          const atomicResult = await executeAtomicArbitrage({
            buildResult: result,
            signer: this.owner,
            targetToken,
          });

          if (atomicResult.success) {
            executedSuccessfully = true;
            // ── POST-TRADE BALANCE SNAPSHOT (Jito başarılı) ──
            let realizedPnlInfo: RealizedPnlInfo | undefined;
            try {
              // Bundle land etti — kısa bekleme sonrası bakiye oku
              await new Promise((r) => setTimeout(r, 2_000));
              console.log(`[SNAPSHOT] Post-trade bakiye çekiliyor (Jito)…`);
              const postSnapshot = await takeBalanceSnapshot(this.owner.publicKey);
              const realized = computeRealizedPnl(preSnapshot, postSnapshot);
              realizedPnlInfo = toRealizedPnlInfo(realized);

              console.log(
                `[REALIZED vs ESTIMATED] Tahmini net: ${result.netProfit.netProfitUsdc.toFixed(6)} USDC | ` +
                  `Gerçek net: ${realized.realizedNetProfitUsdc.toFixed(6)} USDC | ` +
                  `Fark: ${(realized.realizedNetProfitUsdc - result.netProfit.netProfitUsdc).toFixed(6)} USDC`
              );
            } catch (snapErr) {
              console.error(`[SNAPSHOT] Post-trade snapshot hatası:`, snapErr);
            }

            // Telemetri: Jito başarılı
            // ── Jito Bundle Telemetry ──
            const bundleSendTimestamp = detectTimestamp + quoteLatencyMs + buildLatencyMs;
            const bundleLandingSlot = atomicResult.landedSlot ?? null;
            const bundleSendSlot = detectSlot;  // approximate — may be a few slots later
            const bundleLatencyMs = bundleLandingSlot
              ? Math.round(Date.now() - bundleSendTimestamp)
              : 0;
            const bundleInclusionDelaySlots = bundleLandingSlot
              ? bundleLandingSlot - bundleSendSlot
              : 0;
            cycleJitoBundleTelemetry = {
              bundleSendSlot,
              bundleSendTimestamp,
              bundleLandingSlot,
              bundleStatus: "LANDED",
              bundleLatencyMs,
              bundleInclusionDelaySlots,
            };
            if (bundleInclusionDelaySlots > 1) {
              console.warn(
                `[JITO-MEV] Bundle inclusion delay: ${bundleInclusionDelaySlots} slots — MEV race riski!`
              );
            }
            const tel = buildTelemetry({
              build: result,
              direction: best.direction,
              targetToken,
              sendSignatures: atomicResult.signatures,
              success: true,
              status: "JITO_BUNDLE_LANDED",
              netProfit: result.netProfit,
              realizedPnl: realizedPnlInfo,
              latencyMetrics: buildLatencyMetrics(),
              jitoBundleTelemetry: cycleJitoBundleTelemetry,
              marketClassification: marketClass,
              expectedNetProfitUsdc,
            });
            appendTradeLog(tel);
            console.log(
              `[JITO][${pair}][${dirLabel(best.direction)}] ✓ Bundle LANDED — ` +
                `slot=${atomicResult.landedSlot}, signatures=${atomicResult.signatures.length}`
            );
          } else if (atomicResult.leg1OnChainButLeg2Failed) {            executedSuccessfully = true; // emergency unwind handles it            // ── NADIR DURUM: Leg1 on-chain, Leg2 yok — Emergency Unwind ──
            console.warn(
              `[JITO][${pair}][${dirLabel(best.direction)}] ★ INVENTORY EXPOSURE! ` +
                `Leg1 on-chain, Leg2 başarısız → Emergency Unwind tetikleniyor…`
            );

            // Telemetri: Jito kısmi başarısızlık
            cycleJitoBundleTelemetry = {
              bundleSendSlot: detectSlot,
              bundleSendTimestamp: detectTimestamp + quoteLatencyMs + buildLatencyMs,
              bundleLandingSlot: null,
              bundleStatus: "FAILED",
              bundleLatencyMs: 0,
              bundleInclusionDelaySlots: 0,
            };
            const failTel = buildTelemetry({
              build: result,
              direction: best.direction,
              targetToken,
              sendSignatures: atomicResult.signatures,
              success: false,
              status: "JITO_BUNDLE_FAILED",
              failReason: atomicResult.failReason ?? "Leg1 on-chain, Leg2 failed in bundle",
              netProfit: result.netProfit,
              latencyMetrics: buildLatencyMetrics(),
              jitoBundleTelemetry: cycleJitoBundleTelemetry,
              marketClassification: marketClass,
              expectedNetProfitUsdc,
            });
            appendTradeLog(failTel);

            // Emergency Unwind: token → USDC via Jupiter
            const leg1ExpectedOut = result.legs[0].expectedOut;
            const unwindResult = await emergencyUnwind({
              targetToken,
              stuckAmountRaw: leg1ExpectedOut,
              signer: this.owner,
              direction: best.direction,
              leg1Signature: atomicResult.leg1Signature,
              actualTradeAmountUsdc: notional,
            });

            // Post-unwind snapshot
            let realizedPnlInfoUnwind: RealizedPnlInfo | undefined;
            try {
              if (unwindResult.success && unwindResult.signature) {
                await waitForConfirmation(unwindResult.signature, "confirmed");
              }
              console.log(`[SNAPSHOT] Post-unwind bakiye çekiliyor…`);
              const postSnapshot = await takeBalanceSnapshot(this.owner.publicKey);
              const realized = computeRealizedPnl(preSnapshot, postSnapshot);
              realizedPnlInfoUnwind = toRealizedPnlInfo(realized);
              console.log(
                `[REALIZED-UNWIND] Gerçek net: ${realized.realizedNetProfitUsdc.toFixed(6)} USDC`
              );
            } catch (snapErr) {
              console.error(`[SNAPSHOT] Post-unwind snapshot hatası:`, snapErr);
            }

            if (unwindResult.success) {
              console.warn(
                `[EMERGENCY-UNWIND] Sermaye kurtarıldı ✓ — ` +
                  `loss=${unwindResult.lossUsdc?.toFixed(4) ?? "?"} USDC` +
                  (realizedPnlInfoUnwind ? `, realized=${realizedPnlInfoUnwind.realizedNetProfitUsdc.toFixed(4)} USDC` : "")
              );
            } else {
              console.error(
                `[EMERGENCY-UNWIND] ★★★ SERMAYE KURTARILAMADI ★★★ — ` +
                  `${unwindResult.failReason} — MANUAL INTERVENTION REQUIRED`
              );
            }
          } else {
            // ── TEMİZ BAŞARISIZLIK: Hiçbir TX on-chain değil ──
            // → Sequential fallback deneniyor (legs rebuild)
            console.warn(
              `[JITO-FALLBACK][${pair}][${dirLabel(best.direction)}] Bundle başarısız — ` +
                `${atomicResult.failReason ?? "unknown"} → Sequential fallback deneniyor…`
            );
            const failTel = buildTelemetry({
              build: result,
              direction: best.direction,
              targetToken,
              sendSignatures: atomicResult.signatures,
              success: false,
              status: "JITO_BUNDLE_FAILED",
              failReason: atomicResult.failReason ?? "Bundle failed → sequential fallback",
              netProfit: result.netProfit,
              latencyMetrics: buildLatencyMetrics(),
              expectedNetProfitUsdc,
              jitoBundleTelemetry: {
                bundleSendSlot: detectSlot,
                bundleSendTimestamp: detectTimestamp + quoteLatencyMs + buildLatencyMs,
                bundleLandingSlot: null,
                bundleStatus: "FAILED",
                bundleLatencyMs: 0,
                bundleInclusionDelaySlots: 0,
              },
              marketClassification: marketClass,
            });
            appendTradeLog(failTel);

            // Jito prepareAtomicBundle TX'leri in-place değiştirdi (blockhash + sign).
            // Tam rebuild yerine SADECE blockhash taze + re-sign yaparak ~200ms'de sequential'a geç.
            // Tam rebuild (buildAndSimulate) 3-5s sürer ve spread kapanır.
            try {
              await refreshLeg1ForSequential(result.legs[0].tx, this.owner);
              console.log(
                `[JITO-FALLBACK][${pair}] Leg1 TX blockhash tazelendi — sequential devam ediyor`
              );
            } catch (refreshErr) {
              const reason = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
              console.error(
                `[JITO-FALLBACK][${pair}] Leg1 refresh BAŞARISIZ: ${reason} — tam rebuild deneniyor…`
              );
              // Refresh başarısızsa tam rebuild dene
              try {
                result = await buildAndSimulate({
                  direction: best.direction,
                  notionalUsd: notional,
                  owner: this.owner.publicKey,
                  targetToken,
                  dryRun: isDryRun,
                });
                console.log(
                  `[JITO-FALLBACK][${pair}] Tam rebuild başarılı — sequential devam ediyor`
                );
              } catch (rebuildErr) {
                const rr = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
                console.error(
                  `[JITO-FALLBACK][${pair}] Tam rebuild de BAŞARISIZ: ${rr}`
                );
                executedSuccessfully = true; // prevent sequential with stale data
              }
            }
          }
        }

        if (!executedSuccessfully) {
          // ═══════════════════════════════════════════════════════════
          // ║  SEQUENTIAL PATH — Mevcut Leg1→confirm→Leg2 akışı       ║
          // ║  Jito devre dışı veya rate-limited → sequential fallback ║
          // ═══════════════════════════════════════════════════════════
        // ── LEG 1: İlk bacağı zincire gönder ──
        const leg1 = result.legs[0];
        console.log(
          `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 1/${result.legs.length} ` +
            `(${leg1.venue}) gönderiliyor…`
        );
        const leg1SendResult = await sendWithRetry(leg1.tx, this.owner);
        if (!leg1SendResult.success || !leg1SendResult.finalSignature) {
          throw new SendError(
            `Leg 1 (${leg1.venue}) send failed: ${leg1SendResult.failReason ?? "unknown"}`
          );
        }
        const leg1Sig = leg1SendResult.finalSignature;
        console.log(
          `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 1 başarılı ✓ sig=${leg1Sig}`
        );

        // ── LEG 1 ON-CHAIN CONFIRM BEKLENİYOR ──
        // sendWithRetry() sadece signature döndürür, TX zincirde henüz confirm
        // olmamış olabilir. Balance sorgusu yapılmadan ÖNCE confirm beklemek
        // ZORUNLU — aksi halde resolveSolBalance() eski bakiyeyi okur ve
        // Leg 2 yanlış miktarla oluşturulur.
        try {
          await waitForConfirmation(leg1Sig, "confirmed");
        } catch (confirmErr) {
          const reason = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
          console.error(
            `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 1 on-chain confirm HATASI: ${reason}`
          );
          // Leg 1 TX zincirde hata ile sonuçlandıysa Leg 2'ye geçme
          // (TX başarısız → token gelmedi → unwind gerekli değil)
          throw new SendError(`Leg 1 on-chain confirm failed: ${reason}`);
        }

        // ── LEG 2: Taze quote + taze blockhash ile yeniden oluştur ──
        // Leg 1 on-chain confirm oldu → artık token bakiyemiz var
        // Eski TX'in blockhash'i expire olmuş olabilir, quote stale olabilir
        const leg1ExpectedOut = leg1.expectedOut; // Leg 1'den beklenen token miktarı
        console.log(
          `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 2 TAZE oluşturuluyor ` +
            `(amount=${leg1ExpectedOut.toString()})…`
        );

        let leg2Success = false;
        let leg2Sig: string | undefined;
        try {
          const freshLeg2 = await buildFreshLeg2({
            direction: best.direction,
            targetToken,
            leg1ReceivedAmount: leg1ExpectedOut,
            owner: this.owner.publicKey,
          });
          console.log(
            `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 2/${result.legs.length} ` +
              `(${freshLeg2.venue}) gönderiliyor (FRESH TX)…`
          );
          const leg2SendResult = await sendWithRetry(freshLeg2.tx, this.owner);
          if (leg2SendResult.success && leg2SendResult.finalSignature) {
            leg2Sig = leg2SendResult.finalSignature;
            leg2Success = true;
            console.log(
              `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 2 başarılı ✓ sig=${leg2Sig}`
            );
          }
        } catch (leg2Err) {
          const reason = leg2Err instanceof Error ? leg2Err.message : String(leg2Err);
          console.error(
            `[LIVE][${pair}][${dirLabel(best.direction)}] Leg 2 BAŞARISIZ: ${reason}`
          );
        }

        if (leg2Success && leg2Sig) {
          // ── POST-TRADE BALANCE SNAPSHOT (başarılı işlem) ──
          // Leg 2 confirm bekleniyor, ardından post-trade bakiyesi okunuyor
          let realizedPnlInfo: RealizedPnlInfo | undefined;
          try {
            await waitForConfirmation(leg2Sig, "confirmed");
            console.log(`[SNAPSHOT] Post-trade bakiye çekiliyor…`);
            const postSnapshot = await takeBalanceSnapshot(this.owner.publicKey);
            const realized = computeRealizedPnl(preSnapshot, postSnapshot);
            realizedPnlInfo = toRealizedPnlInfo(realized);

            // Tahmin vs Gerçek karşılaştırma log'u
            console.log(
              `[REALIZED vs ESTIMATED] Tahmini net: ${result.netProfit.netProfitUsdc.toFixed(6)} USDC | ` +
                `Gerçek net: ${realized.realizedNetProfitUsdc.toFixed(6)} USDC | ` +
                `Fark: ${(realized.realizedNetProfitUsdc - result.netProfit.netProfitUsdc).toFixed(6)} USDC`
            );
          } catch (snapErr) {
            console.error(`[SNAPSHOT] Post-trade snapshot hatası:`, snapErr);
            // Snapshot başarısız olursa tahmini değerlere geri dön
          }

          // ── Başarılı gönderim telemetrisi (realized PnL ile) ──
          const signatures = [leg1Sig, leg2Sig];
          const tel = buildTelemetry({
            build: result,
            direction: best.direction,
            targetToken,
            sendSignatures: signatures,
            success: true,
            status: "SEND_SUCCESS",
            netProfit: result.netProfit,
            realizedPnl: realizedPnlInfo,
            latencyMetrics: buildLatencyMetrics(),
            marketClassification: marketClass,
            expectedNetProfitUsdc,
          });
          appendTradeLog(tel);
          console.log(
            `[LIVE][${pair}][${dirLabel(best.direction)}] Tüm leg'ler gönderildi ✓ ` +
              `signatures=[${signatures.join(", ")}]`
          );
        } else {
          // ╔══════════════════════════════════════════════════════════════╗
          // ║  EMERGENCY UNWIND — Leg1 başarılı, Leg2 başarısız!          ║
          // ║  Takılı token'ı USDC'ye çevirerek sermayeyi kurtar.         ║
          // ╚══════════════════════════════════════════════════════════════╝
          console.warn(
            `[LIVE][${pair}][${dirLabel(best.direction)}] ★ INVENTORY EXPOSURE! ` +
              `Leg 1 on-chain, Leg 2 başarısız → Emergency Unwind tetikleniyor…`
          );

          // Telemetri: Leg2 failure
          const failTel = buildTelemetry({
            build: result,
            direction: best.direction,
            targetToken,
            sendSignatures: [leg1Sig],
            success: false,
            status: "LEG2_REFRESH_FAILED",
            failReason: "Leg 2 send failed after fresh rebuild — triggering emergency unwind",
            netProfit: result.netProfit,
            latencyMetrics: buildLatencyMetrics(),
            marketClassification: marketClass,
            expectedNetProfitUsdc,
          });
          appendTradeLog(failTel);

          // Emergency Unwind: token → USDC via Jupiter
          const unwindResult = await emergencyUnwind({
            targetToken,
            stuckAmountRaw: leg1ExpectedOut,
            signer: this.owner,
            direction: best.direction,
            leg1Signature: leg1Sig,
            actualTradeAmountUsdc: notional,
          });

          // ── POST-TRADE BALANCE SNAPSHOT (emergency unwind sonrası) ──
          let realizedPnlInfoUnwind: RealizedPnlInfo | undefined;
          try {
            if (unwindResult.success && unwindResult.signature) {
              await waitForConfirmation(unwindResult.signature, "confirmed");
            }
            console.log(`[SNAPSHOT] Post-unwind bakiye çekiliyor…`);
            const postSnapshot = await takeBalanceSnapshot(this.owner.publicKey);
            const realized = computeRealizedPnl(preSnapshot, postSnapshot);
            realizedPnlInfoUnwind = toRealizedPnlInfo(realized);

            console.log(
              `[REALIZED-UNWIND] Gerçek net: ${realized.realizedNetProfitUsdc.toFixed(6)} USDC ` +
                `(USDC Δ: ${realized.deltaUsdc.toFixed(6)}, SOL maliyeti: ${realized.solCostUsdc.toFixed(6)})`
            );
          } catch (snapErr) {
            console.error(`[SNAPSHOT] Post-unwind snapshot hatası:`, snapErr);
          }

          if (unwindResult.success) {
            if (unwindResult.leg2AlreadySucceeded) {
              console.warn(
                `[EMERGENCY-UNWIND] Leg 2 zaten zincirde başarılı ✓ — unwind yapılmadı. ` +
                  (realizedPnlInfoUnwind ? `Realized: ${realizedPnlInfoUnwind.realizedNetProfitUsdc.toFixed(4)} USDC` : "")
              );
            } else {
              console.warn(
                `[EMERGENCY-UNWIND] Sermaye kurtarıldı ✓ — ` +
                  `sig=${unwindResult.signature}, ` +
                  `loss=${unwindResult.lossUsdc?.toFixed(4) ?? "?"} USDC` +
                  (realizedPnlInfoUnwind ? `, realized=${realizedPnlInfoUnwind.realizedNetProfitUsdc.toFixed(4)} USDC` : "") +
                  `, attempts=${unwindResult.attempts}`
              );
            }
          } else {
            console.error(
              `[EMERGENCY-UNWIND] ★★★ SERMAYE KURTARILAMADI ★★★ — ` +
                `${unwindResult.failReason} — MANUAL INTERVENTION REQUIRED`
            );
          }
        }
        } // end: if (!executedSuccessfully) — sequential path / jito fallback
      } catch (e) {
        if (e instanceof SendError) {
          console.error(`[LIVE][${pair}][SEND_FAILED] ${e.message}`);
        } else {
          // Quote/slippage/sim/net profit hataları execution.ts tarafından telemetri yazılır
          console.warn(`[PriceTicker][${pair}] error:`, e);
        }
      } finally {
        // Round-Robin: bu tick tamamlandı, sıradaki token'a geç
        this.advanceRoundRobin();
        tradeLock.release();
        const endMs = performance.now();
        const latencyMs = Math.round(endMs - startMs);
        const d2s = Date.now() - detectTimestamp;
        console.info(
          `[LATENCY] Slot: ${slot} | Pair: ${pair} | E2E Cycle: ${latencyMs}ms | ` +
            `Quote: ${quoteLatencyMs}ms | Build: ${buildLatencyMs}ms | ` +
            `D2S: ${d2s}ms | Mode: ${executionMode} | ` +
            `Sonraki: ${pairFromToken(this.currentToken)} | ` +
            `Tokens: [${this.scanTokens.join(",")}]`
        );
        // Latency warning for Type A markets
        if (d2s > 800) {
          console.warn(
            `[LATENCY-WARN] detectToSend ${d2s}ms > 800ms — ` +
              `Type A markets'ta MEV race kaybedilir. Pair: ${pair}`
          );
        }
      }
    });
  }

  stop() {
    this.slotDriver.stop();
  }
}
