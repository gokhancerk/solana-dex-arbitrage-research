import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useTradeLogs } from "@/hooks/useTradeLogs";
import { LoginScreen } from "@/components/LoginScreen";
import { StatsCards } from "@/components/StatsCards";
import { SpreadChart } from "@/components/SpreadChart";
import { TradesTable } from "@/components/TradesTable";
import { RefreshCw, AlertCircle, LogOut, Trash2, Sun, Moon } from "lucide-react";

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

function App() {
  const { token, login, logout, loginError, loading: authLoading } = useAuth();
  const { logs, loading, error, unauthorized, refetch, clearLogs } = useTradeLogs(token);
  const { dark, toggle: toggleTheme } = useTheme();
  const [clearing, setClearing] = useState(false);

  // Token var ama API 401 dönüyorsa → geçersiz şifre, logout yap
  if (unauthorized || !token) {
    return (
      <LoginScreen
        onLogin={login}
        error={loginError}
        loading={authLoading}
      />
    );
  }

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
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="inline-flex items-center justify-center rounded-md border p-2 text-sm font-medium hover:bg-accent transition-colors"
              title={dark ? "Açık Tema" : "Koyu Tema"}
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={async () => {
                if (!window.confirm("Tüm işlem verileri silinecek. Emin misiniz?")) return;
                setClearing(true);
                await clearLogs();
                setClearing(false);
              }}
              disabled={clearing || loading}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
              title="Verileri Sıfırla"
            >
              <Trash2 className={`h-4 w-4 ${clearing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Sıfırla</span>
            </button>
            <button
              onClick={refetch}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Yenile
            </button>
            <button
              onClick={logout}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="Çıkış Yap"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
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
