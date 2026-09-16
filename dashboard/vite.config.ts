import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Remove authoring comments from the shipped assets so nothing readable —
// least of all internal design references — leaks in the browser's network tab.
// Two surfaces the JS minifier does NOT cover:
//   1. public/styles/*.css and public/**/*.svg are served VERBATIM (Vite copies
//      public/ byte-for-byte), so their /* … */ and <!-- … --> comments ship raw.
//      → stripped from dist on `closeBundle`, after the public/ copy is on disk.
//   2. assets imported with `?raw` (e.g. an inline SVG) are bundled into JS as a
//      STRING, which esbuild treats as data and never strips.
//      → stripped in `load`, before the string is bundled.
// The rest of the JS is already comment-free (esbuild minify + legalComments
// "none" below). Together this leaves the served artifact fully comment-free.
function stripCssComment(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}
function stripMarkupComment(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}
function stripAssetComments(): Plugin {
  return {
    name: "strip-asset-comments",
    apply: "build",
    enforce: "pre",
    // Raw-imported CSS/SVG → bundled into JS as a string; strip before bundling.
    load(id) {
      const m = /^(.*\.(svg|css))\?raw$/.exec(id);
      if (!m) return null;
      let src = fs.readFileSync(m[1], "utf8");
      src = stripMarkupComment(stripCssComment(src));
      return `export default ${JSON.stringify(src)};`;
    },
    // Inline CSS rendered via <style> in a component is a JS string to esbuild,
    // so its /* … */ comments survive minification. Strip them (comments only,
    // strictly scoped to the injected stylesheet) before the source transform.
    // Two shapes: literal <style>…css…</style>, and <style>{IDENT}</style> whose
    // CSS lives in a nearby `const IDENT = ` … `` template literal.
    transform(code, id) {
      if (id.includes("node_modules") || !/\.(t|j)sx?$/.test(id)) return null;
      if (!code.includes("<style")) return null;
      let out = code.replace(
        /(<style[^>]*>)([^{][\s\S]*?)(<\/style>)/g,
        (_m, open: string, css: string, close: string) =>
          open + stripCssComment(css) + close,
      );
      // <style>{CSS}</style> → strip the backing `const CSS = ` … `` literal.
      for (const [, ident] of code.matchAll(
        /<style[^>]*>\{(\w+)\}<\/style>/g,
      )) {
        const re = new RegExp("(const\\s+" + ident + "\\s*=\\s*`)([\\s\\S]*?)(`)");
        out = out.replace(
          re,
          (_m, a: string, css: string, c: string) => a + stripCssComment(css) + c,
        );
      }
      return out === code ? null : { code: out, map: null };
    },
    // Served CSS/SVG copied verbatim from public/ → strip in the emitted dist.
    closeBundle() {
      const dist = path.resolve(__dirname, "dist");
      if (!fs.existsSync(dist)) return;
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name.endsWith(".css")) {
            const src = fs.readFileSync(p, "utf8");
            const out = stripCssComment(src).replace(/^[ \t]*\n/gm, "");
            if (out !== src) fs.writeFileSync(p, out);
          } else if (entry.name.endsWith(".svg")) {
            const src = fs.readFileSync(p, "utf8");
            const out = stripMarkupComment(stripCssComment(src));
            if (out !== src) fs.writeFileSync(p, out);
          }
        }
      };
      walk(dist);
    },
  };
}

export default defineConfig({
  plugins: [react(), stripAssetComments()],
  // Never emit source maps in the production build — they would let anyone
  // reconstruct the original TypeScript (with comments) from the network tab.
  // (false is Vite's default; pinned here so it can't be turned on by accident.)
  // Drop even third-party legal banners so the shipped JS carries no comments.
  esbuild: { legalComments: "none" },
  resolve: {
    alias: {
      // Enterprise Edition surface. Core imports the `ee` object from "@ee";
      // this resolves to the real proprietary barrel when src/ee/ ships with
      // the build (cloud) and to the open-source stub otherwise — the bundler
      // equivalent of the backend's optional `require("./ee")`. Listed before
      // "@" so the bare "@ee" specifier resolves here, not via "@/…".
      "@ee": fs.existsSync(path.resolve(__dirname, "./src/ee/index.tsx"))
        ? path.resolve(__dirname, "./src/ee/index.tsx")
        : path.resolve(__dirname, "./src/ee.stub.tsx"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // This project uses NO Tailwind/PostCSS — the design CSS is served verbatim via
  // <link> from public/styles. Pin an empty inline PostCSS config so Vite does NOT
  // search up the directory tree and pick up an inherited (and broken) Tailwind
  // postcss config when a component imports a stylesheet (e.g. rrweb/dist/style.css).
  css: { postcss: { plugins: [] } },
  build: {
    // Evergreen-only. The design already depends on :has(), backdrop-filter and
    // container queries, so there is nothing to gain from shipping down-level
    // transpiles or a modulepreload polyfill for legacy engines — dropping them
    // trims the bundle at zero cost. (Vite already never emits ES5; this just
    // moves the floor up to native async / optional-chaining / etc.)
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Per-library vendor chunks — fine-grained cache invalidation:
        // bumping one heavy dependency no longer busts the cached chunk for all
        // the others. Only the big, independently-versioned libraries are pinned;
        // everything else falls to Rollup's per-route splitting. Notes:
        //  • react + react-dom share ONE chunk so there is never a 2nd React.
        //  • rrweb is only imported by the lazy Recordings route, so its chunk is
        //    still fetched on demand — it's just independently cacheable now.
        //  • stripe is billing-only; markdown/prism power the AI + comments views.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/rrweb")) return "rrweb";
          if (id.includes("/motion/")) return "motion";
          if (id.includes("/@tanstack/")) return "tanstack";
          if (id.includes("/@stripe/")) return "stripe";
          if (
            id.includes("/prismjs") ||
            id.includes("/react-markdown") ||
            id.includes("/remark-") ||
            id.includes("/react-simple-code-editor")
          )
            return "markdown";
          if (id.includes("/react-router")) return "router";
          if (id.includes("/react-dom/") || id.includes("/react/")) return "react";
        },
      },
    },
  },
  server: { port: 5173 },
});
