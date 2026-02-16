import { useTradeLogs } from "@/hooks/useTradeLogs";
import { StatsCards } from "@/components/StatsCards";
import { SpreadChart } from "@/components/SpreadChart";
import { TradesTable } from "@/components/TradesTable";
import { RefreshCw, AlertCircle } from "lucide-react";

function App() {
  const { logs, loading, error, refetch } = useTradeLogs();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Arbitraj Dashboard
            </h1>
            <p className="text-sm text-muted-foreground">
              SOL/USDC Arbitraj Bot Metrikleri
            </p>
          </div>
          <button
            onClick={refetch}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Yenile
          </button>
        </div>
      </header>

      <main className="container mx-auto space-y-6 px-4 py-6">
        {/* Hata Durumu */}
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Yükleniyor */}
        {loading && logs.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">
              Veriler yükleniyor...
            </span>
          </div>
        )}

        {/* Ana İçerik */}
        {logs.length > 0 && (
          <>
            {/* İstatistik Kartları */}
            <StatsCards logs={logs} />

            {/* Spread Grafiği */}
            <SpreadChart logs={logs} />

            {/* Son İşlemler Tablosu */}
            <TradesTable logs={logs} />
          </>
        )}

        {/* Boş Durum */}
        {!loading && !error && logs.length === 0 && (
          <div className="text-center py-20 text-muted-foreground">
            <p className="text-lg font-medium">Henüz veri yok</p>
            <p className="text-sm">
              Bot çalıştırıldığında işlem verileri burada görünecektir.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
