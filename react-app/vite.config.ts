import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The new app is published next to the current one, at
// https://tarun1203.github.io/Chittamenterprises/next/ — the built files go
// to ../next (committed, like the rest of the site) until it replaces the old app.
// version.json: what the running app compares itself with to offer a reload
function versionFile() {
  return {
    name: "version-file",
    generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void }) {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, "src/version.ts"), "utf8");
      const version = /APP_VERSION = "([^"]+)"/.exec(src)?.[1] || "";
      const updated = /APP_UPDATED = "([^"]+)"/.exec(src)?.[1] || "";
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version, updated }) });
    },
  };
}

// npm run build:android (mode "android"): the same app for the Android app,
// talking to the office PC server; built into dist-android, which Capacitor
// copies into the Android project (android/)
export default defineConfig(({ mode }) => ({
  base: mode === "android" ? "./" : "/Chittamenterprises/next/",
  plugins: [react(), tailwindcss(), versionFile()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: mode === "android" ? "dist-android" : "../next", emptyOutDir: true, chunkSizeWarningLimit: 1400 },
}));
