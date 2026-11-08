# Viru Empire CEO Panel — standalone deploy (Render free tier)

The CEO panel as a standalone server: the same React panel (light iOS-style
UI) + the same actions + a REST API the Trimurti Laundry app syncs to.

## What is in this folder

- `server.ts` — Bun server. Serves the panel UI, `POST /actions` (the panel),
  and REST `/api/*` (the laundry app): `login`, `shops`, `keys`, `payments`,
  `dashboard`, `export`, `import`.
- `src/` — the panel's real logic, copied from the space: `schema.ts`,
  `actions.ts` (all actions incl. change password, suspend/resume software,
  edit payment, import backup), `privileged.ts`, plus `sdk-shim.ts` (a tiny
  local stand-in for the Hatch SDK, used only here).
- `client-dist/` — the prebuilt panel client (built by `build-client.mjs`).
- `Dockerfile`, `render.yaml` — Render free-tier deploy.
- `build-client.mjs` — rebuilds the client from the space source after UI edits.

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

## Verified 2026-11-08 (local)

- Login (panel + REST), wrong-password rejection, change password round-trip
- Dashboard, shops CRUD + search, suspend/resume (revokes keys on suspend)
- Licence keys: generate, masked list, reveal, revoke, renew
- Payments: create, edit (amount/method/status), mark received/pending, delete
- Export JSON + CSV shapes; import backup round-trip (7 shops, 11 keys,
  13 payments restored; re-import skips all 31 as duplicates)
- App-style REST: shop upsert, payment with status `paid` + shop name +
  epoch-ms date, dashboard, keys list, unauthenticated rejection
- Client serves (index + JS + CSS, light iOS theme)
