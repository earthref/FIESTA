import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Base path the SPA is served under: "/" (default) or a node prefix such as
// "/MagIC/" when several nodes share one hostname. Normalized to always carry
// a leading and trailing slash; the same value reaches the app as
// import.meta.env.BASE_URL (see src/lib/base.ts) and the Docker image's nginx
// as BASE_PATH.
const base = `/${(process.env.VITE_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(
  "//",
  "/",
);

// Which node this build/dev server is for (VITE_NODE, or the first entry of
// the stack's FIESTA_NODE list) and, optionally, a fixed API origin. Both are
// also served at runtime as <base>fiesta-env.js (see src/lib/base.ts): the
// dev server renders it from these values, `vite build` emits it into dist,
// and the nginx image overrides it from its own environment.
const node = process.env.VITE_NODE || (process.env.FIESTA_NODE || "magic").split(",")[0].trim();
const apiUrl = process.env.VITE_API_URL || "";
const envScript = `window.__FIESTA__=${JSON.stringify({ node, apiUrl })};\n`;

function fiestaEnv(): Plugin {
  return {
    name: "fiesta-env",
    configureServer(server) {
      server.middlewares.use(`${base}fiesta-env.js`, (_req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(envScript);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "fiesta-env.js", source: envScript });
    },
  };
}

// Dev-only proxy: with no VITE_API_URL the SPA calls <base>v1/... on its own
// origin, so forward that to the API (any reverse proxy does the same in
// production: nginx in the Docker image, or whatever fronts a static build).
export default defineConfig({
  base,
  define: {
    "import.meta.env.VITE_NODE": JSON.stringify(node),
    "import.meta.env.VITE_API_URL": JSON.stringify(apiUrl),
  },
  plugins: [react(), tailwindcss(), fiestaEnv()],
  server: {
    proxy: {
      [`${base}v1`]: {
        target: process.env.VITE_API_TARGET || "http://localhost:8000",
        changeOrigin: true,
        // Strip the base path: the API always serves /v1 at its root.
        rewrite: (path) => path.slice(base.length - 1),
      },
    },
  },
});
