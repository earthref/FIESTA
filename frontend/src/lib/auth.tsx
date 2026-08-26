import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import type { UserOut } from "./types";

interface AuthContextValue {
  user: UserOut | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(() => getToken() !== null);

  const { data: user, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await api<UserOut>("/api/auth/me");
      } catch {
        // 401 already cleared the stored token in the api client.
        return null;
      }
    },
    enabled: hasToken,
    staleTime: 5 * 60 * 1000,
  });

  const login = useCallback(
    (token: string) => {
      setToken(token);
      setHasToken(true);
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    [queryClient],
  );

  const logout = useCallback(() => {
    clearToken();
    setHasToken(false);
    queryClient.setQueryData(["auth", "me"], null);
    queryClient.removeQueries({ queryKey: ["private"] });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: hasToken ? (user ?? null) : null,
      isLoading: hasToken && isLoading,
      login,
      logout,
    }),
    [hasToken, user, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
