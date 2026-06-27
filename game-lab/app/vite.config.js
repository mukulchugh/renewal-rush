import { defineConfig } from "vite";

// Embeddable static build. base:"./" so the dist can be dropped anywhere
// (quivly.ai iframe, CDN, or served by game-lab/server.py) and still resolve assets.
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1024,
    reportCompressedSize: true,
  },
});
