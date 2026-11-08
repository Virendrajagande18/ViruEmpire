# Viru Empire CEO Panel — standalone deploy (Render free tier)

The CEO panel as a standalone server: the same React panel (light iOS-style
UI) + the same actions + a REST API the Trimurti Laundry app syncs to.

**No demo data, ever.** The panel starts empty and only ever shows rows the
CEO (or a synced shop app) created. There is no seed, no sample shop, key or
payment anywhere in the code, the database, or the UI. A fresh panel shows
₹0 everywhere and empty lists.

## What is in this folder

- `server.ts` — Bun server. Serves the panel UI, `POST /actions` (the panel),
  and REST `/api/*` (the laundry app): `login`, `shops`, `keys`, `payments`,
  `dashboard`, `export`, `import`, `shop-token`.
- `src/` — the panel's real logic, copied from the space: `schema.ts`,
  `actions.ts` (all actions incl. change password, suspend/resume software,
  edit payment, import backup, clear-all, activity log), `privileged.ts`,
  plus `sdk-shim.ts` (a tiny local stand-in for the Hatch SDK, used only here).
- `client-dist/` — the prebuilt panel client (built by `build-client.mjs`).
- `Dockerfile`, `render.yaml` — Render free-tier deploy.
- `build-client.mjs` — rebuilds the client from the space source after UI edits.

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
   (Render keeps these secret; they are never written in any file.)
4. Wait for the deploy to finish. Render gives a URL like
   `https://viru-empire-ceo-panel.onrender.com` — that is the live panel URL.

**Redeploy note:** a redeploy wipes the Render SQLite database. That is what
clears the old fake demo entries from the live panel — with the seed removed,
the redeployed panel comes back empty (₹0 everywhere, empty lists) and stays
empty. Do NOT import a backup downloaded before the cleanup: old backups
contain the demo shops and payments and would bring them back. Export a fresh
backup after the redeploy instead.

## Connect the laundry app

In the Trimurti Laundry app → Settings → Viru Empire CEO Panel, enter:
- **Server URL:** the Render URL above (e.g. `https://viru-empire-ceo-panel.onrender.com`)
- **CEO panel username / password:** the same login
- Tap **Save & Sync Now**. The shop and its payments then sync to the panel.

## Free-tier limits (honest)

- **Sleeps:** the free service sleeps after ~15 minutes with no traffic.
  The first visit or sync after a sleep takes ~30–60 seconds to wake up.
- **Data:** the SQLite database file survives sleeps and restarts, but is
  **wiped on redeploy**. Keep a regular **Export / Backup** (JSON) from the
  panel and re-import it if a redeploy ever clears the data.
- **No card** is needed for Render's free tier.

## Local test

```sh
bun ./build-client.mjs   # rebuild client after panel UI edits
bun ./server.ts          # serves on http://localhost:3000
```

With env vars, the server creates the CEO account on first run:
```sh
CEO_USERNAME=viru CEO_PASSWORD='...' bun ./server.ts
```

Use a throwaway DB for tests: `DB_PATH=/tmp/test.db bun ./server.ts`.

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
