import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The node plugins live outside this package, one folder each with their
// backend half (docs/plugins.md): ../../configurations/plugins here and in
// the Docker images (which mirror the repo: /fiesta/frontend, /configurations/plugins). Plugin files import
// core code as "@/..." and their packages from this package's node_modules
// (`dedupe` resolves every dependency from here, not from the importer's
// directory, where there is none).
const src = fileURLToPath(new URL("./src", import.meta.url));
const pluginsDir = fileURLToPath(new URL("../../configurations/plugins", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

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
// the FIESTA_NODES / FIESTA_NODE list), optionally a fixed API origin, and --
// for the multi-node layout of the local stack, where every node in
// FIESTA_NODES is served under <base><node>/ -- the node list. All are served
// at runtime as <base>fiesta-env.js (see src/lib/base.ts): the dev server
// renders it from these values, `vite build` emits it into dist, and the
// nginx image overrides it from its own environment.
const nodes = (process.env.FIESTA_NODES || "").trim();
const node =
  process.env.VITE_NODE || (nodes || process.env.FIESTA_NODE || "magic").split(",")[0].trim();
const apiUrl = process.env.VITE_API_URL || "";
const envScript = `window.__FIESTA__=${JSON.stringify({ node, apiUrl, ...(nodes ? { nodes } : {}) })};\n`;

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

// Identity of this build, for the update poller (src/lib/use-update-available.ts).
// It goes to two places -- inlined into the bundle as the build the page is
// RUNNING, and written to <base>version.json as the build the server is
// SERVING -- and the poller compares them, so both come from this one constant.
// The short commit SHA, so every node built by one deploy shares an id and
// redeploying the same commit is not an update; a build outside a git checkout
// (the Docker image) falls back to a per-build timestamp.
const buildId =
  (() => {
    try {
      return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "";
    }
  })() || `build-${Date.now()}`;

/** Publishes the build id at <base>version.json for the update poller. */
function buildVersion(): Plugin {
  return {
    name: "fiesta-build-version",
    apply: "build", // the dev server has real HMR; nothing to poll for
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: buildId }),
      });
    },
  };
}

// Dev-only proxy: with no VITE_API_URL the SPA calls <base>v2/... on its own
// origin, so forward that to the API (any reverse proxy does the same in
// production: nginx in the Docker image, or whatever fronts a static build).
export default defineConfig({
  base,
  define: {
    "import.meta.env.VITE_NODE": JSON.stringify(node),
    "import.meta.env.VITE_API_URL": JSON.stringify(apiUrl),
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId),
  },
  plugins: [react(), tailwindcss(), fiestaEnv(), buildVersion()],
  resolve: {
    alias: { "@/": `${src}/`, "@plugins/": `${pluginsDir}/` },
    dedupe: Object.keys(pkg.dependencies ?? {}),
  },
  server: {
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), pluginsDir] },
    proxy: {
      [`${base}v2`]: {
        target: process.env.VITE_API_TARGET || "http://localhost:8000",
        changeOrigin: true,
        // Strip the base path: the API always serves /v2 at its root.
        rewrite: (path) => path.slice(base.length - 1),
      },
    },
  },
});
