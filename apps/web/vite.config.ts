import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { omtHeadPlugin } from "./src/prefs/boot";

// The API (omt serve) listens on 127.0.0.1:4317; the dev server proxies /api to it.
export default defineConfig({
  plugins: [react(), omtHeadPlugin()],
  server: {
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
});
