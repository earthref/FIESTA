import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Base path the SPA is served under: "/" (default) or a node prefix such as
// "/MagIC/" when several nodes share one hostname. Normalized to always carry
// a leading and trailing slash; the same value reaches the app as
// import.meta.env.BASE_URL (see src/lib/base.ts) and the Docker image's nginx
// as BASE_PATH.
const base = `/${(process.env.VITE_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(
  "//",
  "/",
);

// Dev-only proxy: the SPA always uses relative /api URLs (under the base
// path), so in production any reverse proxy (nginx, compose) can route
// <base>api to the backend.
export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      [`${base}api`]: {
        target: process.env.VITE_API_TARGET || "http://localhost:8000",
        changeOrigin: true,
        // Strip the base path: the backend always serves /api at its root.
        rewrite: (path) => path.slice(base.length - 1),
      },
    },
  },
});
