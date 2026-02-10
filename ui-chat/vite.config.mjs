import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.CONSOLE_PORT || "18080";
const apiTarget = `http://127.0.0.1:${apiPort}`;
const wsTarget = `ws://127.0.0.1:${apiPort}`;

export default defineConfig({
  root,
  // Built assets are served by the console server under /chat/assets.
  base: "/chat/",
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      "/api": apiTarget,
      "/ws": {
        target: wsTarget,
        ws: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html")
      }
    }
  }
});
