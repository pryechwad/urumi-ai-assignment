import "./lib/zod-config";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "./App";
import { ApiError } from "./lib/api";
import { AuthProvider } from "./lib/auth";
import "./index.css";

// A 401 anywhere means the session ended: drop cached data so the app falls back to sign-in.
const onError = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401) queryClient.setQueryData(["me"], null);
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster
            position="bottom-right"
            toastOptions={{ className: "!rounded-lg !border !border-line !shadow-pop !text-[13px] !font-sans" }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
