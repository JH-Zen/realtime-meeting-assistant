import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The app used to ship as one 524 kB chunk, so any edit to our own code invalidated the entire
 * download including two libraries that change far less often. Splitting them out is a caching win
 * with no behaviour change; the browser still loads everything eagerly.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          const parts = id.slice(id.lastIndexOf("node_modules") + "node_modules/".length).split(/[\\/]/);
          const pkg = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
          return pkg === "react" || pkg === "react-dom" || pkg === "scheduler" ? "vendor-react" : "vendor";
        },
      },
    },
  },
});
