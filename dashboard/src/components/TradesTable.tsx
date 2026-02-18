import { useState } from "react";
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
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import type { TradeLog } from "@/types";

const PAGE_SIZE = 30;

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
  // On-chain başarılı gönderim
  if (log.status === "SEND_SUCCESS") {
    const isProfit = log.realizedPnl
      ? log.realizedPnl.realizedNetProfitUsdc > 0
      : log.netProfitUsdc > 0;
    return (
      <Badge className={isProfit ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"}>
        {isProfit ? "Kârlı ✓" : "Zararlı ✗"}
      </Badge>
    );
  }
  // Net kâr eşiği altında reddedildi
  if (log.status === "REJECTED_LOW_PROFIT") {
    return (
      <Badge variant="secondary" className="text-amber-600">
        Eşik Altı
      </Badge>
    );
  }
  // Simülasyon başarılı ama gönderilmedi
  if (log.status === "SIMULATION_SUCCESS" || log.status === "DRY_RUN_PROFITABLE") {
    return (
      <Badge variant="secondary">
        Onay Bekliyor
      </Badge>
    );
  }
  // Emergency unwind
  if (log.status?.startsWith("EMERGENCY_UNWIND")) {
    return (
      <Badge variant="destructive">
        Unwind
      </Badge>
    );
  }
  // Leg2 hatası
  if (log.status === "LEG2_REFRESH_FAILED") {
    return (
      <Badge variant="destructive">
        Leg2 Hata
      </Badge>
    );
  }
  // Diğer hatalar
  return (
    <Badge variant="secondary">
      {log.status ?? "Bilinmeyen"}
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

/** Bugünün tarihini YYYY-MM-DD formatında döndürür */
function todayStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/** CSV dışa aktarma */
function exportCSV(logs: TradeLog[]) {
  const header = "Tarih,Parite,Yön,Brüt Kâr,Ağ Ücreti,Net Kâr,Durum,Profit Label\n";
  const rows = logs.map((l) =>
    [
      l.timestamp,
      l.pair,
      l.direction,
      l.grossProfitUsdc.toFixed(6),
      l.feeUsdc.toFixed(6),
      l.netProfitUsdc.toFixed(6),
      l.status,
      l.profitLabel,
    ].join(",")
  );
  const blob = new Blob([header + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `trades_${todayStr()}.csv`);
}

/** JSON dışa aktarma */
function exportJSON(logs: TradeLog[]) {
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
  downloadBlob(blob, `trades_${todayStr()}.json`);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TradesTable({ logs }: TradesTableProps) {
  const [page, setPage] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);

  // Son işlemler en üstte
  const sorted = [...logs].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Sayfa sınırlarını kontrol et
  const safePage = Math.min(page, totalPages - 1);
  if (safePage !== page) setPage(safePage);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Son İşlemler</CardTitle>
        {/* Dışa Aktarma Butonu */}
        <div className="relative">
          <button
            onClick={() => setExportOpen((o) => !o)}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <Download className="h-4 w-4" />
            Dışa Aktar
          </button>
          {exportOpen && (
            <div className="absolute right-0 mt-1 z-10 w-36 rounded-md border bg-popover shadow-md">
              <button
                onClick={() => { exportCSV(sorted); setExportOpen(false); }}
                className="block w-full text-left px-4 py-2 text-sm hover:bg-accent transition-colors rounded-t-md"
              >
                CSV olarak indir
              </button>
              <button
                onClick={() => { exportJSON(sorted); setExportOpen(false); }}
                className="block w-full text-left px-4 py-2 text-sm hover:bg-accent transition-colors rounded-b-md"
              >
                JSON olarak indir
              </button>
            </div>
          )}
        </div>
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
              {paged.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Henüz işlem verisi yok
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((log, idx) => (
                  <TableRow key={`${log.timestamp}-${page}-${idx}`}>
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

        {/* Sayfalama Kontrolleri */}
        {sorted.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t pt-4 mt-4">
            <span className="text-sm text-muted-foreground">
              Toplam {sorted.length} işlem · Sayfa {page + 1} / {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                <ChevronLeft className="h-4 w-4" />
                Önceki
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Sonraki
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
