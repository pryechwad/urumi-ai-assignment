import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    // In development the gateway runs separately; in the cluster the Ingress routes these paths.
    proxy: {
      "/api": "http://localhost:8080",
      "/mcp": "http://localhost:8080",
    },
  },
});
