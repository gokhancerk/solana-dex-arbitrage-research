import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TradeLog } from "@/types";
import { TrendingUp, CheckCircle, DollarSign } from "lucide-react";

interface StatsCardsProps {
  logs: TradeLog[];
}

export function StatsCards({ logs }: StatsCardsProps) {
  const totalOpportunities = logs.length;

  const approvedTrades = logs.filter(
    (l) => l.profitLabel === "profit" && l.netProfitUsdc > 0
  );
  const approvedCount = approvedTrades.length;
  const winrate =
    totalOpportunities > 0
      ? ((approvedCount / totalOpportunities) * 100).toFixed(1)
      : "0.0";

  const potentialNetProfit = approvedTrades.reduce(
    (sum, l) => sum + l.netProfitUsdc,
    0
  );

  return (
    <div className="grid gap-4 md:grid-cols-3">
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

      {/* Onaylanan İşlemler / Winrate */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Onaylanan İşlemler (Winrate)
          </CardTitle>
          <CheckCircle className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {approvedCount}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              ({winrate}%)
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Eşiği geçen kârlı işlemler
          </p>
        </CardContent>
      </Card>

      {/* Potansiyel Net Kâr */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Potansiyel Net Kâr
          </CardTitle>
          <DollarSign className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {potentialNetProfit.toFixed(4)}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              USDC
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Onaylanan işlemlerin toplam net kârı
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
