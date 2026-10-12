import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react(), {
    name: "about-page",
    enforce: "post",
    generateBundle(_, bundle) {
      const index = bundle["index.html"];
      if (index?.type === "asset") this.emitFile({ type: "asset", fileName: "about/index.html", source: index.source });
    },
  }],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true } } },
});
