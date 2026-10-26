import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { api, ApiError, type Meta, type User } from "./api";

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api.get<{ user: User }>("/auth/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });

  const value: AuthState = {
    user: me.data ?? null,
    isAdmin: me.data?.role === "admin",
    loading: me.isLoading,
    signOut: async () => {
      await api.post("/auth/logout");
      qc.clear();
      qc.setQueryData(["me"], null);
    },
    refresh: () => me.refetch(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => api.get<Meta>("/meta"), staleTime: 5 * 60_000 });
}
