"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { TradeLog, HourlyBucket } from "@/types";

interface SpreadChartProps {
  logs: TradeLog[];
}

const chartConfig = {
  grossSpread: {
    label: "Brüt Makas (USDC)",
    color: "hsl(var(--chart-2))",
  },
  netSpread: {
    label: "Net Makas (USDC)",
    color: "hsl(var(--chart-1))",
  },
} satisfies ChartConfig;

function buildHourlyBuckets(logs: TradeLog[]): HourlyBucket[] {
  const map = new Map<
    string,
    { gross: number; net: number; count: number }
  >();

  for (const log of logs) {
    const d = new Date(log.timestamp);
    // Türkiye saati (UTC+3)
    const trHour = (d.getUTCHours() + 3) % 24;
    const hour = `${trHour.toString().padStart(2, "0")}:00`;
    const existing = map.get(hour) ?? { gross: 0, net: 0, count: 0 };
    existing.gross += log.grossProfitUsdc;
    existing.net += log.netProfitUsdc;
    existing.count += 1;
    map.set(hour, existing);
  }

  // 0–23 saat aralığını doldur
  const buckets: HourlyBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const hour = `${h.toString().padStart(2, "0")}:00`;
    const v = map.get(hour);
    buckets.push({
      hour,
      grossSpread: v ? parseFloat(v.gross.toFixed(6)) : 0,
      netSpread: v ? parseFloat(v.net.toFixed(6)) : 0,
      count: v?.count ?? 0,
    });
  }

  return buckets;
}

export function SpreadChart({ logs }: SpreadChartProps) {
  const data = buildHourlyBuckets(logs);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zaman ve Fırsat Dağılımı</CardTitle>
        <CardDescription>
          Saatlik toplam brüt ve net spread değerleri (Türkiye saati)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <BarChart data={data} barGap={2} barCategoryGap="20%" maxBarSize={28}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="hour"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v: number) => `${v.toFixed(4)}`}
              domain={["auto", "auto"]}
              allowDataOverflow={false}
              scale="linear"
            />
            <Tooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="grossSpread"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            >
              {data.map((entry, i) => (
                <Cell
                  key={`gross-${i}`}
                  fill={entry.grossSpread > 0 ? "#4caf50" : "var(--color-grossSpread)"}
                />
              ))}
            </Bar>
            <Bar
              dataKey="netSpread"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            >
              {data.map((entry, i) => (
                <Cell
                  key={`net-${i}`}
                  fill={entry.netSpread > 0 ? "#4caf50" : "var(--color-netSpread)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
