import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const appSrc = path.resolve(__dirname, "../../../app/src");

// The grid is the app's own source, read in place: "@app" is app/src. What that source
// imports from packages is looked up from here (web/node_modules, which run.sh points at the
// app's own node_modules), so the build does not depend on where the packages were installed.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [
    {
      name: "app-packages",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (!importer || !importer.startsWith(appSrc) || /^[./\0]/.test(source) || source.startsWith("@app")) return null;
        return this.resolve(source, path.join(__dirname, "main.tsx"), { ...options, skipSelf: true });
      },
    },
    react(),
  ],
  resolve: {
    alias: { "@app": appSrc },
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: path.resolve(__dirname, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 8000 },
});
