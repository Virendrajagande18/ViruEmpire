# Viru Empire CEO Panel — standalone deploy (Render free tier)

The CEO panel as a standalone server: the same React panel (light iOS-style
UI) + the same actions + a REST API the Trimurti Laundry app syncs to.

**No demo data, ever.** The panel starts empty and only ever shows rows the
CEO (or a synced shop app) created. There is no seed, no sample shop, key or
payment anywhere in the code, the database, or the UI. A fresh panel shows
₹0 everywhere and empty lists.

## What is in this folder

- `server.ts` — Bun server. Serves the panel UI, `POST /actions` (the panel),
  and REST `/api/*` (shop apps — laundry, oil dealership, LIC & Star Health
  office, fataka stall): `login`, `products`, `shops`, `keys`, `payments`,
  `dashboard`, `export`, `import`, `shop-token`, `devices`, `sync`.
- `src/` — the panel's real logic, copied from the space: `schema.ts`,
  `actions.ts` (all actions incl. change password, suspend/resume software,
  edit payment, import backup, clear-all, activity log), `privileged.ts`,
  plus `sdk-shim.ts` (a tiny local stand-in for the Hatch SDK, used only here).
- `src/products.ts` — **the one place that defines the products** (the 4
  canonical names + short aliases an app may send). Business logic never
  hardcodes a product list; the client fetches it from `GET /api/products`.
- `tests/panel.test.ts` — bun tests (fresh DB stays empty, one shop per
  product, per-product totals, keys for every product, Oil devices, LIC
  sync with non-laundry record kinds, laundry regression, rate limit).
  Run: `bun test tests/panel.test.ts`
- `client-dist/` — the prebuilt panel client (built by `build-client.mjs`).
- `Dockerfile`, `render.yaml` — Render free-tier deploy.
- `build-client.mjs` — rebuilds the client from the space source after UI edits.

## Products — all four are first-class

The panel sells four software products: **Laundry Management System, Oil
Dealership Software, LIC & Star Health Office System, Fataka Stall
Website**. Every feature works the same for all four — shops, licence keys,
payments, devices, sync, per-product dashboard totals, and the activity
log (which names the product on every entry, e.g. "Generated licence key
… for Test Fataka Stall (Fataka Stall Website)").

- **Devices + sync are product-agnostic.** A device registers with the
  shop's product (the shop's software field is the source of truth; a
  device announcing the wrong product is rejected with 400). Sync accepts
  any record kind — laundry syncs order/customer/payment/rate/setting, an
  LIC office syncs policy/customer/payment/…, an oil dealership syncs
  stock/scheme/… — only the shape (a short lowercase slug) is checked.
  Rules unchanged: up to 3 active devices per shop, first = main, only
  the main can revoke, revoked = view-only, one licence covers the shop.
- **Adding a 5th product** = one line in `src/products.ts` (add the full
  name to `PRODUCTS`, plus any short alias to `ALIASES`), then deploy —
  about 5 minutes. The client fetches `GET /api/products`, so the
  dropdowns, filters, dashboard cards and Devices lists pick the new
  product up with **no client rebuild**. A shop can also carry any custom
  software name ("Other" in the UI) — unknown names pass through
  unchanged, so a new product never breaks existing shops.

## Cinematic startup intro (panel only, NOT the laundry app)

On every page load the panel shows a ~**1.2-second** Viru Empire logo
reveal before the login screen (or dashboard): dark cinematic backdrop, a
blue V mark and "VIRU EMPIRE / CEO PANEL" fading and scaling in with a
soft glow, a gold line sweeping under, then the overlay fades out. Tap or
click anywhere skips it at once. The login screen and dashboard mount
underneath immediately, so it never delays anything; it plays once per
page load, never on in-app navigation. Pure CSS/JS, no new libraries, no
sound, no extra network load. It works in all three themes (the overlay
is dark on purpose) and on mobile, and it is skipped entirely when the
user prefers reduced motion.

## Panel features

- **Overview** — totals that never change with filters (total revenue, active
  shops, live keys, pending payments); expiring-soon alert; clean welcome
  screen with "Add your first shop" when the panel is empty.
- **Shops / Keys / Payments** — search by name/phone/note, status filter,
  sort, pagination (20 per page). Payments totals are computed by the server
  over ALL payments, so the numbers always match the dashboard.
- **Themes** — Light / Dark / Glass (transparent) toggle in the header and
  sidebar, saved in the browser, applied to every screen including login.
- **Activity log** — every key generate/revoke/renew, shop add/edit/suspend/
  resume/delete, payment record/edit/delete, backup import and full data wipe
  is recorded with date and time, visible on the Activity tab. The log is kept
  even when all other data is cleared, so a wipe stays on record.
- **Clear all data** — in Backup & Export → Danger zone. Type CLEAR to
  confirm; deletes every shop, key and payment at once. Deleting one shop
  also deletes that shop's keys and payments — no orphan "No shop linked"
  rows ever again.
- **Licence keys** — format `VIRU-XXXX-XXXX-XXXX` with a checksum block, so a
  mistyped or guessed key is caught. Keys are bound to one shop; a key cannot
  be reused for another shop. Revoked and expired keys are rejected by the
  panel and by the app on sync.
- **Security** — CEO login with salted password hash; 5 wrong logins per IP
  block logins for 15 minutes (429 + Retry-After); sessions expire after 30
  days, so a token left on a shared phone stops working on its own; shop
  tokens are scoped to ONE shop and can never call the panel actions, export
  a backup, generate keys, or see another shop. The CEO account must exist
  via `CEO_USERNAME` / `CEO_PASSWORD` env vars before first boot.

## Deploy (2 steps, ~5 minutes)

**Step 1 — put this folder on GitHub.**
Repo: `Virendrajagande18/ViruEmpire` (already created, empty).
Push this folder's contents to it (web-UI upload works if git push is blocked).

**Step 2 — Render.**
1. Go to https://render.com → sign up / log in (free, no card for the free tier).
2. **New + → Blueprint** → pick the `ViruEmpire` repo. Render reads
   `render.yaml` and starts the deploy.
3. When Render asks for env vars, set:
   - `CEO_USERNAME` — the CEO login username the user chose
   - `CEO_PASSWORD` — the CEO login password the user chose
   - `TURSO_DATABASE_URL` — libSQL URL of the Turso database
   - `TURSO_AUTH_TOKEN` — auth token for that Turso database
   (Render keeps these secret; they are never written in any file.)
4. Wait for the deploy to finish. Render gives a URL like
   `https://viru-empire-ceo-panel.onrender.com` — that is the live panel URL.

**Data note:** all panel data lives in Turso (a hosted database), not in a
file on the Render server. Shops, keys, payments and devices survive
sleeps AND redeploys. The panel's Export / Backup (JSON) stays as a
second safety net — export regularly anyway. The server refuses to start
if the Turso variables are missing, so a misconfigured deploy fails
loudly instead of silently losing data. Do NOT import a backup downloaded
before the 2026-11-08 cleanup: old backups contain the demo shops and
payments and would bring them back. Export a fresh backup instead.

## Connect a shop app

In any Viru Empire shop app (laundry, oil, LIC office, fataka…) → Settings → Viru Empire CEO Panel, enter:
- **Server URL:** the Render URL above (e.g. `https://viru-empire-ceo-panel.onrender.com`)
- **CEO panel username / password:** the same login
- Tap **Save & Sync Now**. The shop and its data then sync to the panel.
The app announces its product when it registers/syncs; the panel checks
it against the shop's product, so a laundry app can never sync into an
oil shop by mistake.

## Free-tier limits (honest)

- **Sleeps:** the free service sleeps after ~15 minutes with no traffic.
  The first visit or sync after a sleep takes ~30–60 seconds to wake up.
  The panel shows a clear loading state and retries a failed first load
  once, so a wake-up never looks like lost data.
- **Data:** everything lives in Turso, so sleeps and redeploys no longer
  wipe anything. Keep a regular **Export / Backup** (JSON) from the
  panel as a second safety net.
- **No card** is needed for Render's free tier.

## Local test

```sh
bun ./build-client.mjs   # rebuild client after panel UI edits
bun ./server.ts          # serves on http://localhost:3000
```

With env vars, the server creates the CEO account on first run:
```sh
CEO_USERNAME=viru CEO_PASSWORD='...' TURSO_DATABASE_URL='file:/tmp/test.db' bun ./server.ts
```

Use a throwaway local database for tests: `TURSO_DATABASE_URL='file:/tmp/test.db' bun ./server.ts`.
Without TURSO_DATABASE_URL the server exits at once with a clear error.

## Verified 2026-11-08 (local, fresh empty DB)

- Login (panel + REST), wrong-password rejection, change password round-trip
- Dashboard, shops CRUD + search, suspend/resume (revokes keys on suspend)
- Licence keys: generate, masked list, reveal, revoke, renew
- Payments: create, edit (amount/method/status), mark received/pending, delete
- Export JSON + CSV shapes; import backup round-trip (7 shops, 11 keys,
  13 payments restored; re-import skips all 31 as duplicates)
- App-style REST: shop upsert, payment with status `paid` + shop name +
  epoch-ms date, dashboard, keys list, unauthenticated rejection
- Client serves (index + JS + CSS, light iOS theme)
- **Cleanup re-verified 2026-11-08 (29 checks, all pass):** fresh DB stays
  empty on every load (dashboard ₹0, no shops/keys/payments, activity log
  empty); add/edit/delete flows work; delete-shop cascades (1 key + 2
  payments removed with the shop, zero orphans); clear-all wipes everything
  and stays empty on reload while the activity log survives; server payment
  totals stay identical when the list is filtered; edit-shop keeps the
  original joined date; empty-expiry key gets the plan default (30 days);
  5 bad logins → 429 block; a 31-day-old session is rejected; a shop token
  is rejected by `/actions` and sees only its own shop via `/api`.
  No demo name, amount or seed function remains in the code or the built
  bundle (checked: all 6 demo shops, all demo amounts incl. ₹4,82,937 /
  ₹77,981 / ₹4,999, and `seedIfEmpty` — zero matches).

## Verified 2026-11-08 (multi-product optimization, this change)

- `bun test tests/panel.test.ts` — **13 tests, 96 assertions, all pass**
  (fresh DB empty; 4 products from `GET /api/products`; one shop per
  product with alias normalization; per-product dashboard totals; Fataka
  key generate/checksum/revoke/renew; keys for laundry/oil/LIC; Oil
  devices register ×3 + cap + revoke-frees-slot + wrong-software 400;
  LIC sync with `policy`/`customer` kinds + bad type skipped + wrong
  software 400; laundry sync regression; devices list + CEO set-main for
  any shop; shop token rejected by `/actions`; activity log names the
  product; 5 bad logins → 429).
- Client typecheck clean (`tsc --noEmit`, 0 errors); server bundles
  (`bun build ./server.ts`, 195 modules); client rebuilt
  (`bun ./build-client.mjs` — new `client-dist` assets).
