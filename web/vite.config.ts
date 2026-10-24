import { defineConfig } from "vite";
import { resolve } from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/**
 * The dashboard lives in `web/` but reads mock JSON from the sibling `mock/`
 * folder (see mock/README.md). We set the Vite root to the repo root so both
 * folders are served, and keep `web/index.html` as the entry point.
 *
 * Because the Vite root is the repo root, Vite would look for a PostCSS config
 * there and never find the one in web/. We therefore configure PostCSS inline
 * and point Tailwind at web/tailwind.config.ts explicitly, so `@apply` and the
 * Tailwind layers actually get processed.
 */
const repoRoot = resolve(__dirname, "..");

export default defineConfig({
  root: repoRoot,
  base: "./",
  publicDir: false,
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(__dirname, "tailwind.config.ts") }),
        autoprefixer(),
      ],
    },
  },
  server: {
    open: "/web/index.html",
    fs: {
      // allow serving the sibling mock/ folder
      allow: [repoRoot],
    },
  },
  build: {
    outDir: resolve(repoRoot, "web/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
    },
  },
});
