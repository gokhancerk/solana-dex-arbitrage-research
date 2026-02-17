import { useState, useEffect, useCallback, useRef } from "react";
import type { TradeLog } from "@/types";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;

interface UseTradeLogsResult {
  logs: TradeLog[];
  loading: boolean;
  error: string | null;
  unauthorized: boolean;
  refetch: () => void;
  clearLogs: () => Promise<boolean>;
}

export function useTradeLogs(token: string | null, intervalMs = 15000): UseTradeLogsResult {
  const [logs, setLogs] = useState<TradeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const retryCount = useRef(0);

  const fetchLogs = useCallback(async () => {
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await fetch(`/api/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setUnauthorized(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TradeLog[] = await res.json();
      setLogs(data);
      setError(null);
      setUnauthorized(false);
      retryCount.current = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bilinmeyen hata";
      if (retryCount.current < MAX_RETRIES) {
        retryCount.current++;
        const delay = BASE_DELAY * Math.pow(2, retryCount.current - 1);
        setTimeout(fetchLogs, delay);
        return;
      }
      setError(`Veri alınamadı: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(() => {
      retryCount.current = 0;
      fetchLogs();
    }, intervalMs);
    return () => clearInterval(id);
  }, [fetchLogs, intervalMs]);

  const clearLogs = useCallback(async (): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await fetch(`/api/logs`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogs([]);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bilinmeyen hata";
      setError(`Veriler silinemedi: ${msg}`);
      return false;
    }
  }, [token]);

  return { logs, loading, error, unauthorized, refetch: fetchLogs, clearLogs };
}
