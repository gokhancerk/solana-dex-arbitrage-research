import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TradeLog } from "@/types";
import { TrendingUp, CheckCircle, DollarSign, AlertTriangle } from "lucide-react";

interface StatsCardsProps {
  logs: TradeLog[];
}

export function StatsCards({ logs }: StatsCardsProps) {
  const totalOpportunities = logs.length;

  // Sadece zincire başarıyla gönderilen işlemler (SEND_SUCCESS veya JITO_BUNDLE_LANDED)
  const onChainTrades = logs.filter(
    (l) => l.status === "SEND_SUCCESS" || l.status === "JITO_BUNDLE_LANDED"
  );

  // Reddedilen / iptal edilen (zincire gitmedi)
  const rejectedTrades = logs.filter(
    (l) => l.status === "REJECTED_LOW_PROFIT" || l.status === "SIMULATION_SUCCESS" || l.status === "JITO_BUNDLE_FAILED"
  );

  // Winrate: zincire giden / toplam fırsat
  const onChainCount = onChainTrades.length;
  const winrate =
    totalOpportunities > 0
      ? ((onChainCount / totalOpportunities) * 100).toFixed(1)
      : "0.0";

  // Realized PnL: zincirdeki gerçek kâr/zarar (varsa realized, yoksa tahmini)
  const realizedNetProfit = onChainTrades.reduce((sum, l) => {
    if (l.realizedPnl) return sum + l.realizedPnl.realizedNetProfitUsdc;
    return sum + l.netProfitUsdc;
  }, 0);

  // Tahmini kâr (onaylanan ama henüz/hiç zincire gitmemiş dahil)
  const estimatedProfit = rejectedTrades
    .filter((l) => l.netProfitUsdc > 0)
    .reduce((sum, l) => sum + l.netProfitUsdc, 0);

  return (
    <div className="grid gap-4 md:grid-cols-4">
      {/* Toplam Fırsat */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Toplam Fırsat</CardTitle>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalOpportunities}</div>
          <p className="text-xs text-muted-foreground">
            Taranan toplam arbitraj fırsatı
          </p>
        </CardContent>
      </Card>

      {/* Zincire Giden İşlemler / Winrate */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Zincirdeki İşlemler
          </CardTitle>
          <CheckCircle className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {onChainCount}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              ({winrate}%)
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            On-chain başarılı gönderimler
          </p>
        </CardContent>
      </Card>

      {/* Gerçek Net Kâr (On-Chain) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Gerçek Net Kâr
          </CardTitle>
          <DollarSign className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${realizedNetProfit >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {realizedNetProfit.toFixed(4)}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              USDC
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            On-chain gerçekleşen kâr/zarar
          </p>
        </CardContent>
      </Card>

      {/* Kaçırılan Tahmini Kâr */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Kaçırılan (Tahmini)
          </CardTitle>
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-amber-500">
            {estimatedProfit.toFixed(4)}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              USDC
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Eşik altı reddedilen fırsatlar
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
