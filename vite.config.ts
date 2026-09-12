import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    // The gateway serves this directory; see src/fleet/site/server.ts.
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // `npm run dev:web` talks to a gateway running on 8790, so the session
    // cookie and the API share an origin during development too.
    proxy: {
      "/api": "http://127.0.0.1:8790",
      "/a2a": "http://127.0.0.1:8790",
    },
  },
});
