import { PublicKey } from "@solana/web3.js";
import { getConnection, deriveATA } from "./solana.js";
import { loadConfig } from "./config.js";

// ───── Balance Snapshot — Realized PnL hesabı için bakiye okuma ─────

/**
 * Cüzdandaki USDC ve native SOL bakiyelerinin anlık görüntüsü.
 * Pre-trade → Post-trade farkı ile "gerçek kâr/zarar" hesaplanır.
 */
export interface BalanceSnapshot {
  /** USDC bakiyesi (raw units — 6 decimal) */
  usdcRaw: bigint;
  /** Native SOL bakiyesi (lamports) */
  solLamports: bigint;
  /** Snapshot alınma zamanı (ISO string) */
  timestamp: string;
}

/**
 * Gerçek (Realized) Kâr/Zarar hesabı — Pre vs Post bakiye deltası.
 */
export interface RealizedPnl {
  /** USDC delta: Post - Pre (pozitif = kazanç, negatif = kayıp) */
  deltaUsdcRaw: bigint;
  deltaUsdc: number;
  /** SOL delta: Pre - Post (pozitif = harcanan SOL gas/fee) */
  deltaSolLamports: bigint;
  deltaSol: number;
  /** SOL maliyetinin USDC karşılığı */
  solCostUsdc: number;
  /** Net gerçek kâr = deltaUsdc - solCostUsdc */
  realizedNetProfitUsdc: number;
  /** Pre-trade snapshot */
  preSnapshot: BalanceSnapshot;
  /** Post-trade snapshot */
  postSnapshot: BalanceSnapshot;
  /** Hesapta kullanılan SOL/USDC kuru */
  solUsdcRate: number;
}

/**
 * Cüzdanın mevcut USDC ve native SOL bakiyesini çeker.
 *
 * RPC 429 (rate-limit) durumundan korunmak için:
 * - İki sorgu tek Promise.all'da birleştirilir (2 RPC çağrısı)
 * - Hata olursa 0 döndürüp loglar (işlemi engellemez)
 */
export async function takeBalanceSnapshot(
  owner: PublicKey
): Promise<BalanceSnapshot> {
  const cfg = loadConfig();
  const connection = getConnection();

  const usdcMint = new PublicKey(cfg.tokens.USDC.mint);
  const usdcAta = deriveATA(owner, usdcMint);

  const timestamp = new Date().toISOString();

  try {
    const [usdcInfo, solBalance] = await Promise.all([
      connection.getTokenAccountBalance(usdcAta).catch(() => null),
      connection.getBalance(owner).then((b) => BigInt(b)),
    ]);

    const usdcRaw = usdcInfo ? BigInt(usdcInfo.value.amount) : BigInt(0);

    console.log(
      `[SNAPSHOT] ${timestamp} — USDC: ${usdcRaw.toString()} raw | ` +
        `SOL: ${solBalance.toString()} lamports`
    );

    return { usdcRaw, solLamports: solBalance, timestamp };
  } catch (err) {
    console.error("[SNAPSHOT] Bakiye snapshot hatası:", err);
    // Hata durumunda 0 döndür — realized PnL hesaplanamaz ama trade engellenmesin
    return { usdcRaw: BigInt(0), solLamports: BigInt(0), timestamp };
  }
}

/**
 * Pre-trade ve Post-trade snapshotlarından delta hesaplar.
 *
 * Formül:
 *  - deltaUsdc       = Post_USDC - Pre_USDC
 *  - deltaSol        = Pre_SOL - Post_SOL  (harcanan gas/fee)
 *  - solCostUsdc     = deltaSol * solUsdcRate
 *  - realizedNetPnL  = deltaUsdc - solCostUsdc
 */
export function computeRealizedPnl(
  pre: BalanceSnapshot,
  post: BalanceSnapshot,
  solUsdcRate?: number
): RealizedPnl {
  const cfg = loadConfig();
  const rate = solUsdcRate ?? cfg.solUsdcRate;
  const usdcDecimals = cfg.tokens.USDC.decimals;

  // USDC delta (pozitif = kazanç)
  const deltaUsdcRaw = post.usdcRaw - pre.usdcRaw;
  const deltaUsdc = Number(deltaUsdcRaw) / 10 ** usdcDecimals;

  // SOL delta (pozitif = harcanan SOL)
  const deltaSolLamports = pre.solLamports - post.solLamports;
  const deltaSol = Number(deltaSolLamports) / 1e9;

  // SOL maliyetinin USDC karşılığı
  const solCostUsdc = deltaSol * rate;

  // Net gerçek kâr
  const realizedNetProfitUsdc = deltaUsdc - solCostUsdc;

  console.log(
    `[REALIZED-PNL] USDC Δ: ${deltaUsdc.toFixed(6)} | ` +
      `SOL Δ: ${deltaSol.toFixed(9)} (${solCostUsdc.toFixed(6)} USDC @ ${rate}) | ` +
      `Net Realized: ${realizedNetProfitUsdc.toFixed(6)} USDC`
  );

  return {
    deltaUsdcRaw,
    deltaUsdc,
    deltaSolLamports,
    deltaSol,
    solCostUsdc,
    realizedNetProfitUsdc,
    preSnapshot: pre,
    postSnapshot: post,
    solUsdcRate: rate,
  };
}
