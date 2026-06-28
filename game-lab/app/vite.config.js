import { defineConfig } from "vite";

// Embeddable static build. base:"./" so the dist can be dropped anywhere
// (quivly.ai iframe, CDN, or served by game-lab/server.py) and still resolve assets.
export default defineConfig({
  base: "./",
  // Havok ships a .wasm; let Vite emit/serve it as an asset and skip pre-bundling
  // (pre-bundled, the dev server returns index.html for the .wasm — wrong MIME).
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: { exclude: ["@babylonjs/havok"] },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1024,
    reportCompressedSize: true,
  },
});
