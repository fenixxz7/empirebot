import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    port: 5000,
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:5001",
        changeOrigin: false,
      },
      "/health": {
        target: "http://localhost:5001",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://localhost:5001",
        ws: true,
        changeOrigin: false,
      },
    },
  },
  appType: "spa",
});
