import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "client",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4174"
    }
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true
  }
});
