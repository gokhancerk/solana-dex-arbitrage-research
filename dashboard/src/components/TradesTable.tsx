import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TradeLog } from "@/types";

interface TradesTableProps {
  logs: TradeLog[];
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StatusBadge({ log }: { log: TradeLog }) {
  if (log.profitLabel === "profit" && log.netProfitUsdc > 0) {
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white">
        Kârlı
      </Badge>
    );
  }
  if (log.profitLabel === "loss") {
    return (
      <Badge variant="destructive">
        Reddedildi
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      Sabit
    </Badge>
  );
}

function DirectionLabel({ direction }: { direction: string }) {
  if (direction === "JUP_TO_OKX") {
    return <span className="text-blue-500 font-medium">JUP → OKX</span>;
  }
  if (direction === "OKX_TO_JUP") {
    return <span className="text-amber-500 font-medium">OKX → JUP</span>;
  }
  return <span>{direction}</span>;
}

export function TradesTable({ logs }: TradesTableProps) {
  // Son işlemler en üstte
  const sorted = [...logs].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Son İşlemler</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 bg-background">
                  Tarih/Saat (TR)
                </TableHead>
                <TableHead className="sticky top-0 bg-background">
                  Parite
                </TableHead>
                <TableHead className="sticky top-0 bg-background">
                  Yön
                </TableHead>
                <TableHead className="sticky top-0 bg-background text-right">
                  Brüt Kâr
                </TableHead>
                <TableHead className="sticky top-0 bg-background text-right">
                  Ağ Ücreti
                </TableHead>
                <TableHead className="sticky top-0 bg-background text-right">
                  Net Kâr
                </TableHead>
                <TableHead className="sticky top-0 bg-background">
                  Durum
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Henüz işlem verisi yok
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((log, idx) => (
                  <TableRow key={`${log.timestamp}-${idx}`}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatDate(log.timestamp)}
                    </TableCell>
                    <TableCell className="font-medium">{log.pair}</TableCell>
                    <TableCell>
                      <DirectionLabel direction={log.direction} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {log.grossProfitUsdc.toFixed(6)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {log.feeUsdc.toFixed(6)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums font-medium ${
                        log.netProfitUsdc > 0
                          ? "text-emerald-500"
                          : log.netProfitUsdc < 0
                          ? "text-red-500"
                          : ""
                      }`}
                    >
                      {log.netProfitUsdc.toFixed(6)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge log={log} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
