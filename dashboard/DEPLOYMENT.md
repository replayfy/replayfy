# Deployment runbook — dashboard

The dashboard is a static Vite/React SPA. `npm run build` emits `dist/` — plain
static files (HTML + hashed JS/CSS + assets). There is no server to run; you host
`dist/` on any static host + CDN.

Runtime for building: **Node 20.17.0** (`nvm use`).

---

## 1. Build-time environment (BAKED IN — set BEFORE building)

Vite only exposes `VITE_`-prefixed vars, and they are **frozen into the bundle at
build time**. Changing them in the deploy environment after the fact does nothing
— you must rebuild. Never build the production bundle from a developer checkout
whose `.env.local` carries dev values.

| Var | Required | Notes |
| --- | --- | --- |
| `VITE_API_URL` | **yes** | Prod ingest-API origin, no trailing slash (e.g. `https://us.replayfy.app`). A production build now **throws at load** if this is unset (instead of silently baking in `http://127.0.0.1:4000`). |
| `VITE_STRIPE_PUBLISHABLE_KEY` | for billing | `pk_live_…` from the **same** Stripe account/mode as the API's `STRIPE_SECRET_KEY`. Publishable (safe to ship); a test/live mismatch makes checkout fail to mount. |

Both are client-visible — never put a secret here.

---

## 2. Build

```bash
nvm use                 # Node 20.17.0
npm ci
VITE_API_URL="https://<prod-api-origin>" \
VITE_STRIPE_PUBLISHABLE_KEY="pk_live_…" \
npm run build           # tsc --noEmit && vite build → dist/
```

The build strips **all comments** from the shipped assets (JS via esbuild minify
+ `legalComments:"none"`; CSS/SVG — including the verbatim `public/styles/*.css`
and inline `<style>` blocks — via a build plugin) and emits **no source maps**, so
nothing readable leaks in the browser network tab.

---

## 3. Verify the build before shipping

```bash
grep -r "127.0.0.1" dist/assets        # must return NOTHING (else VITE_API_URL wasn't set)
find dist -name '*.map'                 # must return NOTHING (no source maps)
```

If `grep` finds `127.0.0.1`, the build picked up a localhost `VITE_API_URL` — do
**not** ship it; rebuild with the env injected. (Never deploy a hand-built `dist/`
from a dev checkout — build in a clean CI/deploy environment.)

---

## 4. Hosting

**Serve `dist/` at the domain ROOT.** Vite emits absolute asset paths (`/assets/…`),
so hosting under a sub-path breaks every asset unless you set `base` in
`vite.config.ts` and rebuild.

**SPA fallback is required.** The app uses the History API (`createBrowserRouter`),
so deep links and hard refreshes (`/recordings/:id`, `/settings/general`,
`/share/:token`, …) are real paths the host must rewrite to `/index.html` — else
they 404. Do **not** rewrite `/assets/*` or other real files; only unknown paths.

- **nginx:** `location / { try_files $uri /index.html; }`
- **Netlify / Cloudflare Pages:** a `public/_redirects` with `/* /index.html 200`
- **Vercel:** rewrite `/(.*)` → `/index.html`
- **S3 + CloudFront:** set the error document to `index.html` (403/404 → `/index.html`, 200)

**Cache headers:** `/assets/*` are content-hashed → `Cache-Control: public,
max-age=31536000, immutable`. `index.html` → `no-cache` (so a deploy is picked up
immediately).

---

## 5. Coordinate with the API

- `VITE_API_URL` must match the API's public origin, and that origin must be in the
  API's `CORS_ORIGINS` allowlist.
- The Stripe publishable key (here) and secret key (API) must be the same account
  and mode (both live, or both test).
