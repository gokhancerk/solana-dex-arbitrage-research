import { performance } from "perf_hooks";
import { SlotDriver } from "./slotDriver.js";
import { Direction, SendError, RealizedPnlInfo } from "../types.js";
import {
  buildAndSimulate,
  sendWithRetry,
  estimateDirectionProfit,
  pairFromToken,
  QuoteEstimate,
  buildFreshLeg2,
  emergencyUnwind,
  resolvePriorityFee,
} from "../execution.js";
import { buildTelemetry, appendTradeLog } from "../telemetry.js";
import { Keypair } from "@solana/web3.js";
import { getKeypairFromEnv } from "../wallet.js";
import { loadConfig, type TokenSymbol, type TradePair } from "../config.js";
import { tradeLock } from "../tradeLock.js";
import { waitForConfirmation } from "../solana.js";
import { takeBalanceSnapshot, computeRealizedPnl, type RealizedPnl } from "../balanceSnapshot.js";

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
    console.log(
      `[PriceTicker] Round-Robin çoklu-token tarama aktif — ` +
        `tokenlar=[${this.scanTokens.join(", ")}], ` +
        `her tick'te tek token, çift yönlü PARALEL`
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

      try {
        const ownerStr = this.owner.publicKey.toBase58();
        const notional = this.notionalUsd;

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 0 — Dinamik priority fee resolve et (cache'li)         ║
        // ╚══════════════════════════════════════════════════════════════╝
        await resolvePriorityFee();

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 1 — Round-Robin: bu tick'te tek token, iki yön        ║
        // ║  PARALEL tara (Jupiter & OKX farklı API'lar)                ║
        // ╚══════════════════════════════════════════════════════════════╝
        console.log(
          `[SCAN] Slot ${slot} — ${pair} çift yönlü PARALEL quote başlatılıyor ` +
            `(${notional} USDC)…`
        );

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
        const viable = results.filter((q): q is QuoteEstimate => q !== null && q.viable);

        if (viable.length === 0) {
          console.log(
            `[SCAN] Slot ${slot} — ${pair} her iki yönde de kârlı rota yok, atlanıyor`
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
          `[SCAN] ★ Kazanan rota: ${pair} ${dirLabel(best.direction)} — ` +
            `Tahmini net kâr: ${best.netProfitUsdc.toFixed(6)} USDC`
        );

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 3 — Tam build + simulate (kazanan yön)               ║
        // ╚══════════════════════════════════════════════════════════════╝
        const result = await buildAndSimulate({
          direction: best.direction,
          notionalUsd: notional,
          owner: this.owner.publicKey,
          targetToken,
          dryRun: false,
          cachedEstimate: best,
        });

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  ADIM 4 — LIVE: Leg1 gönder → Leg2 TAZE oluştur → gönder    ║
        // ║  Leg2 başarısız olursa Emergency Unwind devreye girer.        ║
        // ╚══════════════════════════════════════════════════════════════════╝
        console.log(
          `[LIVE][${pair}][${dirLabel(best.direction)}] Net kâr onaylandı ` +
            `(${result.netProfit.netProfitUsdc.toFixed(6)} USDC) — ` +
            `${result.legs.length} leg gönderiliyor…`
        );
        // ── PRE-TRADE BALANCE SNAPSHOT ──
        // İşlem başlamadan önce cüzdandaki kesin USDC ve SOL bakiyesini kaydet
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
          });
          appendTradeLog(failTel);

          // Emergency Unwind: token → USDC via Jupiter
          const unwindResult = await emergencyUnwind({
            targetToken,
            stuckAmountRaw: leg1ExpectedOut,
            signer: this.owner,
            direction: best.direction,
            leg1Signature: leg1Sig,
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
            console.warn(
              `[EMERGENCY-UNWIND] Sermaye kurtarıldı ✓ — ` +
                `sig=${unwindResult.signature}, ` +
                `loss=${unwindResult.lossUsdc?.toFixed(4) ?? "?"} USDC` +
                (realizedPnlInfoUnwind ? `, realized=${realizedPnlInfoUnwind.realizedNetProfitUsdc.toFixed(4)} USDC` : "") +
                `, attempts=${unwindResult.attempts}`
            );
          } else {
            console.error(
              `[EMERGENCY-UNWIND] ★★★ SERMAYE KURTARILAMADI ★★★ — ` +
                `${unwindResult.failReason} — MANUAL INTERVENTION REQUIRED`
            );
          }
        }
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
        console.info(
          `[LATENCY] Slot: ${slot} | Pair: ${pair} | E2E Cycle: ${latencyMs}ms | ` +
            `Sonraki: ${pairFromToken(this.currentToken)} | ` +
            `Tokens: [${this.scanTokens.join(",")}]`
        );
      }
    });
  }

  stop() {
    this.slotDriver.stop();
  }
}
