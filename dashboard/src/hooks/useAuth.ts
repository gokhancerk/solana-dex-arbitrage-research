import { useState, useCallback } from "react";

const STORAGE_KEY = "dashboard_token";

export function useAuth() {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY)
  );
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (password: string) => {
    setLoading(true);
    setLoginError(null);
    try {
      const res = await fetch(`/api/logs`, {
        headers: { Authorization: `Bearer ${password}` },
      });
      if (res.status === 401) {
        setLoginError("Şifre hatalı.");
        return false;
      }
      if (!res.ok) {
        setLoginError(`Sunucu hatası: HTTP ${res.status}`);
        return false;
      }
      localStorage.setItem(STORAGE_KEY, password);
      setToken(password);
      return true;
    } catch {
      setLoginError("Sunucuya bağlanılamadı.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return { token, login, logout, loginError, loading };
}
