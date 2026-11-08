// Viru Empire CEO Panel — standalone server (Render free tier).
//
// Serves the same React client the Hatch space uses, plus:
//  - POST /actions  {action, args} -> {data} | {error}   (the panel web UI)
//    CEO session tokens ONLY — a shop token is rejected here, so the
//    phone's token can never call revealKey / exportBackup / generateKey.
//  - REST /api/* for shop-app sync clients (any Viru Empire software —
//    laundry, oil dealership, LIC & Star Health office, fataka stall):
//      POST /api/login    {username, password} -> {token, username}
//      GET  /api/products -> {products}  (public catalogue, no auth)
//      POST /api/shop-token {shopName, shopPhone} | {shopId} -> {token, shopId}
//                           {shopId, revoke: true} -> {revoked}
//                           CEO only. Mints a SHOP-SCOPED token: the phone
//                           stores only this token, never the CEO password.
//                           A shop token can only touch its own shop:
//                           GET /api/shops (own row only), POST /api/shops
//                           (own row only, no create), GET /api/keys (own
//                           shopId forced), POST /api/payments (own shop
//                           only, no auto-create). Dashboard, export,
//                           import and POST /api/keys are CEO-only (403).
//      GET  /api/dashboard                     -> dashboard summary
//      GET  /api/shops    ?search=&status=     -> {shops}
//      POST /api/shops    {name, ownerName, phone, city, software, status}
//      GET  /api/keys                          -> {keys}
//      POST /api/keys     {shopId, plan, status, expiresAt} -> {id, keyCode}
//      POST /api/payments {amountInr, method, status, shopId, paidAt, note}
//      GET  /api/export                        -> full backup JSON
//      POST /api/import   {backup}             -> import counts
//  - GET  /health -> {ok:true}
//
//  Login rate limiting: 5 failed logins per IP -> 15 minute block
//  (429 + Retry-After). Success clears the counter. Block length via
//  LOGIN_BLOCK_MS (ms) for testing; default 15 minutes.
//  Licence keys: VIRU-A-B-C where C is a checksum of A
//  (licenceCheckCode in src/actions.ts — must match the app's
//  licenceCheckCode in Licence.kt). The app verifies the checksum
//  offline from the masked key, so guessed keys fail.
//
// Data lives in Turso (a hosted SQLite-compatible database) — NOT in a
// file on this server. Render's free tier wipes the server's own files
// whenever it sleeps (~15 min idle) or redeploys, which is how shops
// added to the panel vanished overnight. Turso keeps the data no matter
// how often the server sleeps or restarts — the panel's Export / Backup
// stays as a second safety net, so export regularly anyway.

import { createClient, type Client } from "@libsql/client";
import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { Actions } from "./src/actions";
import * as schema from "./src/schema";
import { normalizeSoftware, PRODUCTS } from "./src/products";
import { privilegedHandlers } from "./src/privileged";

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_DIR = "./client-dist";

// ---------- database ----------
// Turso is the ONLY store. The URL and auth token come from the Render
// dashboard (Environment) only — never from a file, never from the repo.
// If they are missing the server refuses to start rather than silently
// using a local file: a local file would look fine and then lose data
// again the next time the server sleeps. The token stays server-side
// only — it is never sent to the client bundle or any API response.
const TURSO_URL = process.env.TURSO_DATABASE_URL?.trim();
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim();
if (!TURSO_URL) {
  console.error(
    "FATAL: TURSO_DATABASE_URL is not set. The CEO panel stores its data in Turso — " +
      "set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Render dashboard (Environment) and redeploy. " +
      "The server will not start without them."
  );
  process.exit(1);
}
const turso: Client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
const db = drizzle(turso, { schema });

// Raw SQL through the Turso client. One execute per old bun:sqlite call —
// no extra queries. Rows come back as plain objects keyed by column name,
// the same shape the old code read.
async function sqlOne<T>(sql: string, ...args: (string | number | null)[]): Promise<T | undefined> {
  const r = await turso.execute({ sql, args });
  return r.rows[0] as T | undefined;
}
async function sqlAll<T>(sql: string, ...args: (string | number | null)[]): Promise<T[]> {
  const r = await turso.execute({ sql, args });
  return r.rows as T[];
}
async function sqlRun(sql: string, ...args: (string | number | null)[]): Promise<{ changes: number }> {
  const r = await turso.execute({ sql, args });
  return { changes: Number(r.rowsAffected ?? 0) };
}

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS admin_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_tokens (
  token TEXT PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  software TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS license_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_code TEXT NOT NULL,
  shop_id INTEGER,
  plan TEXT NOT NULL DEFAULT 'yearly',
  status TEXT NOT NULL DEFAULT 'unused',
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER,
  amount_inr INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'upi',
  status TEXT NOT NULL DEFAULT 'received',
  note TEXT NOT NULL DEFAULT '',
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  software TEXT NOT NULL DEFAULT '',
  slot INTEGER NOT NULL DEFAULT 1,
  is_main INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_shop_device ON devices (shop_id, device_id);
CREATE TABLE IF NOT EXISTS sync_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_records_shop_entity ON sync_records (shop_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_records_updated ON sync_records (shop_id, updated_at);
CREATE TABLE IF NOT EXISTS sync_meta (
  shop_id INTEGER PRIMARY KEY,
  epoch TEXT NOT NULL
);
`;
await turso.executeMultiple(CREATE_TABLES);

// No additive migration is needed here: a Turso database is created
// fresh, so CREATE TABLE above already includes the devices.software
// column. (The old local SQLite files — the only databases that could
// lack the column — are abandoned with this move; their data is gone
// with the wiped files, which is exactly the bug being fixed.)

// First-run CEO account from environment variables (set in the Render
// dashboard, never in a file): if no account exists yet, create the one
// named by CEO_USERNAME / CEO_PASSWORD. The password is only ever read
// from the process environment and stored as a salted hash.
const envUser = process.env.CEO_USERNAME?.trim();
const envPass = process.env.CEO_PASSWORD ?? "";
if (envUser && envPass) {
  const existing = await sqlOne<{ id: number }>("SELECT id FROM admin_account LIMIT 1");
  if (!existing) {
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(`${salt}:${envPass}`).digest("hex");
    await sqlRun(
      "INSERT INTO admin_account (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
      envUser,
      hash,
      salt,
      Date.now()
    );
    console.log(`CEO account created for '${envUser}' from environment.`);
  }
}

// ---------- action runtime (mirrors the space runtime) ----------

const ctx: any = {
  db: () => db,
  executePrivileged: async (contract: any, args: any) => {
    const fn = (privilegedHandlers as Map<number, (a: any) => any>).get(contract.__contractId);
    if (!fn) throw new Error("Unknown privileged call");
    return fn(args);
  },
  invalidateQueries: () => {},
};

async function callAction(name: string, args: any): Promise<{ data?: any; error?: string }> {
  const def: any = (Actions as any)[name];
  if (!def) return { error: `Unknown action: ${name}` };
  try {
    const parsed = def.request ? def.request.parse(args ?? {}) : (args ?? {});
    const data = await def.handler(ctx, parsed);
    return { data };
  } catch (e: any) {
    return { error: e?.message ?? "Action failed." };
  }
}

// ---------- REST auth ----------
// Two token kinds share the Bearer header:
//  - CEO sessions (sessions table): full panel access, incl. /actions.
//    A CEO session expires 30 days after login, so a token left on a
//    shared phone stops working on its own — the CEO simply logs in again.
//  - Shop tokens (shop_tokens table): minted by the CEO for ONE shop via
//    POST /api/shop-token. A shop token can only touch its own shop —
//    its own shop row, its own keys, its own payments. It can never
//    call /actions, export/import the panel backup, generate keys, or
//    see any other shop. The shop phone stores ONLY its shop token.
// Shop tokens never expire on their own; the CEO revokes one with
// POST /api/shop-token {shopId, revoke: true}.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type ApiAuth =
  | { scope: "ceo"; token: string; shopId: null }
  | { scope: "shop"; token: string; shopId: number };

async function requireAuth(req: Request): Promise<ApiAuth | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
  if (sessions[0]) {
    if (Date.now() - sessions[0].createdAt.getTime() > SESSION_MAX_AGE_MS) {
      await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
      return null;
    }
    return { scope: "ceo", token, shopId: null };
  }
  const shopRows = await sqlAll<{ shop_id: number }>("SELECT shop_id FROM shop_tokens WHERE token = ?", token);
  if (shopRows[0]) return { scope: "shop", token, shopId: shopRows[0].shop_id };
  return null;
}

/** True when the token is a live (unexpired) CEO session token — the only kind /actions accepts. */
async function isCeoToken(token: string): Promise<boolean> {
  if (!token) return false;
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
  const session = rows[0];
  if (!session) return false;
  if (Date.now() - session.createdAt.getTime() > SESSION_MAX_AGE_MS) {
    await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
    return false;
  }
  return true;
}

// ---------- login rate limiting ----------
// 5 failed logins per IP -> 15 minute block (429 + Retry-After header).
// A successful login clears the counter, so mistyping a few times never
// locks anyone out. In-memory only: a server restart clears the blocks,
// which is acceptable for this single-instance free service. Behind
// Render the real client IP comes from X-Forwarded-For.
// LOGIN_BLOCK_MS exists only so the block can be tested quickly.
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS ?? 15 * 60 * 1000);
const loginFails = new Map<string, { fails: number; blockedUntil: number }>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

function loginBlockedSeconds(ip: string): number {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.blockedUntil > Date.now()) return Math.ceil((rec.blockedUntil - Date.now()) / 1000);
  return 0;
}

function loginFailed(ip: string): void {
  const rec = loginFails.get(ip) ?? { fails: 0, blockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
  loginFails.set(ip, rec);
}

function loginSucceeded(ip: string): void {
  loginFails.delete(ip);
}

function tooManyLogins(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many failed sign-ins — try again in 15 minutes." }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
        "access-control-allow-origin": "*",
      },
    }
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Normalize the app's payment payload: status "paid" -> "received",
// shopId may be a shop NAME string, paidAt may be epoch millis.
async function resolveShopId(shopId: unknown): Promise<number | null> {
  if (typeof shopId === "number" && Number.isInteger(shopId) && shopId > 0) return shopId;
  if (typeof shopId === "string" && shopId.trim()) {
    const name = shopId.trim();
    const rows = await db.select().from(schema.shops).where(eq(schema.shops.name, name)).limit(1);
    if (rows[0]) return rows[0].id;
    const [row] = await db
      .insert(schema.shops)
      .values({ name, ownerName: "", phone: "", city: "", software: "", status: "active", notes: "Added by app sync." })
      .returning({ id: schema.shops.id });
    return row?.id ?? null;
  }
  return null;
}

function normalizeStatus(s: unknown): "received" | "pending" | "failed" | "refunded" {
  if (s === "pending" || s === "failed" || s === "refunded") return s;
  return "received"; // "paid" and anything else count as received
}

function normalizeMethod(m: unknown): "upi" | "cash" | "card" | "bank" | "other" {
  if (m === "cash" || m === "card" || m === "bank" || m === "other") return m;
  return "upi";
}

// Product names are normalized through src/products.ts — the one place
// that defines the products. An app may send a short alias ("Laundry");
// the panel stores the canonical name ("Laundry Management System").
// Unknown names pass through unchanged ("Other" software).

function normalizeDate(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof v === "string" && v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return new Date().toISOString().slice(0, 10);
}

// ---------- static client ----------

const indexHtml = await Bun.file(`${CLIENT_DIR}/index.html`).text().catch(() => null);

async function serveStatic(path: string): Promise<Response | null> {
  const file = Bun.file(`${CLIENT_DIR}${path}`);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "cache-control": "public, max-age=3600" },
    });
  }
  return null;
}

// ---------- server ----------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (path === "/health") return json({ ok: true });

    // ---- panel web UI: POST /actions ----
    // CEO sessions ONLY. A shop token is rejected here even though it is
    // a valid Bearer token for /api/* — otherwise the phone's token could
    // call revealKey / exportBackup / generateKey through the panel UI.
    if (path === "/actions" && req.method === "POST") {
      const body = await readJson(req);
      const actionName = String(body?.action ?? "");
      const tokenArg = body?.args?.token;
      if (typeof tokenArg === "string" && tokenArg) {
        if (!(await isCeoToken(tokenArg))) return bad("UNAUTHORIZED", 401);
      }
      if (actionName === "login") {
        const ip = clientIp(req);
        const blocked = loginBlockedSeconds(ip);
        if (blocked > 0) return tooManyLogins(blocked);
        const result = await callAction("login", body?.args ?? {});
        if (result.error) loginFailed(ip); else loginSucceeded(ip);
        return json(result);
      }
      const result = await callAction(actionName, body?.args ?? {});
      return json(result);
    }

    // ---- REST API for shop apps (any Viru Empire software) ----
    if (path.startsWith("/api/")) {
      // Public product catalogue — the client fetches this so a new
      // product appears in every dropdown and filter with no client
      // rebuild. Product names are not sensitive.
      if (path === "/api/products" && req.method === "GET") {
        return json({ products: [...PRODUCTS] });
      }
      if (path === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        const ip = clientIp(req);
        const blocked = loginBlockedSeconds(ip);
        if (blocked > 0) return tooManyLogins(blocked);
        const r = await callAction("login", { username: body?.username ?? "", password: body?.password ?? "" });
        if (r.error) {
          loginFailed(ip);
          return bad(r.error, 401);
        }
        loginSucceeded(ip);
        return json(r.data);
      }
      const auth = await requireAuth(req);
      if (!auth) return bad("UNAUTHORIZED", 401);
      const token = auth.token;
      const isShop = auth.scope === "shop";

      // CEO-only: mint or revoke a shop-scoped token for one shop.
      // Body: {shopId} or {shopName, shopPhone}; {revoke: true} deletes
      // the shop's tokens. Minting replaces any older token for the shop,
      // so a lost phone's token dies the moment a new one is issued.
      if (path === "/api/shop-token" && req.method === "POST") {
        if (isShop) return bad("Only the CEO can mint shop tokens.", 403);
        const body = await readJson(req);
        let shopId: number | null = null;
        if (typeof body?.shopId === "number" && Number.isInteger(body.shopId) && body.shopId > 0) {
          const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, body.shopId)).limit(1);
          if (!rows[0]) return bad("Shop not found.");
          shopId = rows[0].id;
        } else {
          const name = String(body?.shopName ?? "").trim();
          const phone = String(body?.shopPhone ?? "").trim();
          if (!name) return bad("Shop name is required.");
          const rows = await db.select().from(schema.shops);
          const match = rows.find((s) => s.name === name && s.phone === phone)
            ?? rows.find((s) => s.name === name);
          if (match) {
            shopId = match.id;
          } else {
            const [row] = await db
              .insert(schema.shops)
              .values({
                name, ownerName: "", phone, city: "",
                // The caller's software, normalized — never a hardcoded
                // product. A shop created without one stays unspecified.
                software: normalizeSoftware(body?.software ?? ""), status: "active",
                notes: "Added by CEO for shop-token setup.",
              })
              .returning({ id: schema.shops.id });
            shopId = row?.id ?? null;
          }
        }
        if (!shopId) return bad("Shop not found.");
        if (body?.revoke === true) {
          const deleted = await sqlRun("DELETE FROM shop_tokens WHERE shop_id = ?", shopId);
          return json({ revoked: deleted.changes ?? 0, shopId });
        }
        await sqlRun("DELETE FROM shop_tokens WHERE shop_id = ?", shopId);
        const shopToken = randomBytes(32).toString("hex");
        await sqlRun(
          "INSERT INTO shop_tokens (token, shop_id, created_at) VALUES (?, ?, ?)",
          shopToken,
          shopId,
          Date.now()
        );
        return json({ token: shopToken, shopId });
      }

      if (path === "/api/dashboard" && req.method === "GET") {
        if (isShop) return bad("Only the CEO can read the dashboard.", 403);
        const r = await callAction("getDashboard", { token, months: 6 });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/shops" && req.method === "GET") {
        const r = await callAction("listShops", {
          token,
          search: url.searchParams.get("search") ?? "",
          status: url.searchParams.get("status") ?? "all",
        });
        if (r.error) return bad(r.error, 400);
        // A shop token sees only its own shop row — the list is filtered
        // here even though the action itself is scope-blind.
        if (isShop) {
          const shops = Array.isArray((r.data as any)?.shops) ? (r.data as any).shops : [];
          return json({ shops: shops.filter((s: any) => s.id === auth.shopId) });
        }
        return json(r.data);
      }
      if (path === "/api/shops" && req.method === "POST") {
        const body = await readJson(req);
        const name = String(body?.name ?? "").trim();
        if (!name) return bad("Shop name is required.");
        const phone = String(body?.phone ?? "").trim();
        const existing = await db.select().from(schema.shops);
        const match = existing.find((s) => s.name === name && s.phone === phone);
        if (isShop) {
          // A shop token may only update its OWN row (same name + phone);
          // it can never create a shop or touch another shop.
          if (!match || match.id !== auth.shopId) {
            return bad("This phone can only sync its own shop.", 403);
          }
        }
        if (match) {
          const r = await callAction("updateShop", {
            token, id: match.id, name,
            ownerName: String(body?.ownerName ?? match.ownerName ?? ""),
            phone, city: String(body?.city ?? match.city ?? ""),
            software: normalizeSoftware(body?.software ?? match.software ?? ""),
            status: body?.status ?? match.status,
            notes: match.notes ?? "", joinedAt: "",
          });
          if (r.error) return bad(r.error, 400);
          return json({ id: match.id, updated: true });
        }
        const r = await callAction("createShop", {
          token, name,
          ownerName: String(body?.ownerName ?? ""),
          phone, city: String(body?.city ?? ""),
          software: normalizeSoftware(body?.software ?? ""),
          status: body?.status ?? "active",
          notes: "", joinedAt: "",
        });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/keys" && req.method === "GET") {
        const r = await callAction("listKeys", {
          token,
          search: url.searchParams.get("search") ?? "",
          status: url.searchParams.get("status") ?? "all",
          // A shop token is forced to its own shopId, whatever it asked for.
          shopId: isShop ? auth.shopId : (Number(url.searchParams.get("shopId") ?? 0) || 0),
        });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/keys" && req.method === "POST") {
        if (isShop) return bad("Only the CEO can generate licence keys.", 403);
        const body = await readJson(req);
        const r = await callAction("generateKey", {
          token,
          shopId: Number(body?.shopId ?? 0) || 0,
          plan: body?.plan ?? "yearly",
          status: body?.status ?? "unused",
          expiresAt: String(body?.expiresAt ?? ""),
        });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/payments" && req.method === "POST") {
        const body = await readJson(req);
        const amount = Number(body?.amountInr);
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
          return bad("Enter a valid amount in rupees (whole number above 0).");
        }
        let shopId: number | null;
        if (isShop) {
          // No auto-create for a shop token: the payment must belong to
          // its own shop, resolved by id or by its own name.
          if (typeof body?.shopId === "number" && body.shopId === auth.shopId) {
            shopId = auth.shopId;
          } else if (typeof body?.shopId === "string" && body.shopId.trim()) {
            const rows = await db.select().from(schema.shops).where(eq(schema.shops.name, body.shopId.trim())).limit(1);
            shopId = rows[0]?.id === auth.shopId ? auth.shopId : null;
          } else {
            shopId = auth.shopId;
          }
          if (!shopId) return bad("This phone can only record payments for its own shop.", 403);
        } else {
          shopId = await resolveShopId(body?.shopId);
        }
        const r = await callAction("createPayment", {
          token, shopId: shopId ?? 0, amountInr: amount,
          method: normalizeMethod(body?.method),
          status: normalizeStatus(body?.status),
          note: String(body?.note ?? ""),
          paidAt: normalizeDate(body?.paidAt),
        });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/export" && req.method === "GET") {
        if (isShop) return bad("Only the CEO can export the panel backup.", 403);
        const r = await callAction("exportBackup", { token });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/import" && req.method === "POST") {
        if (isShop) return bad("Only the CEO can import a panel backup.", 403);
        const body = await readJson(req);
        const r = await callAction("importBackup", { token, backup: body?.backup ?? body });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      // ---- Multi-device sync (any shop app) ----
      // The shop's devices share ONE shop token, so a device is told
      // apart by its own deviceId (a UUID the app makes at first setup
      // and stores on the phone — never in a backup). Every call below
      // is shop-scoped: a token can only touch its own shop's devices
      // and data. Licence/token endpoints above are untouched.
      // Devices and sync are product-agnostic: the shop's software
      // (from its shop row) is the source of truth for which app a
      // device runs, and sync accepts any record kind — laundry syncs
      // order/customer/payment/rate/setting, an LIC office syncs
      // policy/customer/payment/..., an oil dealership syncs
      // stock/scheme/... The server stores the payload as-is and never
      // requires laundry fields.
      const MAX_DEVICES = 3;
      // Entity types are NOT a fixed list: every product syncs its own
      // kinds of records. Only the SHAPE is checked — a short lowercase
      // slug — so a new product never needs a server change to sync.
      const SYNC_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
      async function shopEpoch(shopId: number): Promise<string> {
        const row = await sqlOne<{ epoch: string }>("SELECT epoch FROM sync_meta WHERE shop_id = ?", shopId);
        if (row) return row.epoch;
        const epoch = randomBytes(16).toString("hex");
        await sqlRun("INSERT INTO sync_meta (shop_id, epoch) VALUES (?, ?)", shopId, epoch);
        return epoch;
      }
      async function deviceRow(shopId: number, deviceId: string): Promise<any> {
        return sqlOne("SELECT * FROM devices WHERE shop_id = ? AND device_id = ?", shopId, deviceId);
      }
      async function shopSoftwareOf(shopId: number): Promise<string> {
        const row = await sqlOne<{ software: string }>("SELECT software FROM shops WHERE id = ?", shopId);
        return normalizeSoftware(row?.software ?? "");
      }
      // The app may announce which product it is (software / app). When
      // the shop already has a product set, the announced one must match
      // it — a laundry app must never register against an oil shop.
      // Returns the shop's software (the source of truth) or an error.
      async function checkAppSoftware(shopId: number, body: any): Promise<{ software: string } | { error: string }> {
        const shopSoftware = await shopSoftwareOf(shopId);
        const announced = normalizeSoftware(body?.software ?? body?.app ?? body?.appType ?? "");
        if (announced && shopSoftware && announced !== shopSoftware) {
          return { error: `This shop runs ${shopSoftware}, not ${announced}.` };
        }
        return { software: shopSoftware };
      }

      // Register a device for the shop. First device = main (slot 1).
      // Idempotent: re-registering the same deviceId returns its record.
      if (path === "/api/devices/register" && req.method === "POST") {
        if (!isShop) return bad("Only a shop device can register.", 403);
        const body = await readJson(req);
        const deviceId = String(body?.deviceId ?? "").trim().slice(0, 64);
        const name = String(body?.deviceName ?? "").trim().slice(0, 80);
        if (!deviceId) return bad("deviceId is required.");
        const shopId = auth.shopId!;
        const app = await checkAppSoftware(shopId, body);
        if ("error" in app) return bad(app.error, 400);
        const existing = await deviceRow(shopId, deviceId);
        if (existing) {
          return json({ deviceId, slot: existing.slot, isMain: existing.is_main === 1, revoked: existing.revoked === 1, software: app.software, epoch: await shopEpoch(shopId) });
        }
        // The cap counts ACTIVE devices only: a revoked device frees
        // its slot, so a replacement phone can join after the old one
        // is removed (device lost). Revoked rows stay listed in the
        // panel/devices list — they just do not hold a slot.
        const countRow = await sqlOne<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE shop_id = ? AND revoked = 0", shopId);
        if ((countRow?.n ?? 0) >= MAX_DEVICES) {
          return bad("This shop already has 3 devices. Remove one from the main device first.", 403);
        }
        const slotRow = await sqlOne<{ m: number }>("SELECT COALESCE(MAX(slot), 0) AS m FROM devices WHERE shop_id = ?", shopId);
        const slot = (slotRow?.m ?? 0) + 1;
        const isMain = (countRow?.n ?? 0) === 0 ? 1 : 0;
        await sqlRun(
          "INSERT INTO devices (shop_id, device_id, name, software, slot, is_main, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
          shopId, deviceId, name, app.software, slot, isMain, Date.now()
        );
        return json({ deviceId, slot, isMain: isMain === 1, revoked: false, software: app.software, epoch: await shopEpoch(shopId) });
      }

      // List the shop's devices (for the main device's Settings screen).
      if (path === "/api/devices" && req.method === "GET") {
        if (!isShop) return bad("Only a shop device can list devices.", 403);
        const shopId = auth.shopId!;
        const rows = await sqlAll<any>(
          "SELECT device_id AS deviceId, name, software, slot, is_main AS isMain, revoked, last_sync_at AS lastSyncAt FROM devices WHERE shop_id = ? ORDER BY slot",
          shopId
        );
        return json({ devices: rows.map((r) => ({ ...r, isMain: r.isMain === 1, revoked: r.revoked === 1 })) });
      }

      // List a shop's devices for the CEO panel (main-device-lost
      // recovery: the panel shows which device is main and lets the CEO
      // assign a new one). CEO only — a shop token cannot list another
      // shop's devices, and it has no shop id of its own to ask about.
      if (path.startsWith("/api/shops/") && path.endsWith("/devices") && req.method === "GET") {
        if (isShop) return bad("Only the CEO can list a shop's devices.", 403);
        const shopId = Number(path.split("/")[3] ?? "");
        if (!shopId) return bad("Shop id is required.");
        const rows = await sqlAll<any>(
          "SELECT device_id AS deviceId, name, software, slot, is_main AS isMain, revoked, last_sync_at AS lastSyncAt FROM devices WHERE shop_id = ? ORDER BY slot",
          shopId
        );
        return json({ devices: rows.map((r) => ({ ...r, isMain: r.isMain === 1, revoked: r.revoked === 1 })) });
      }

      // Push + pull in one request (delta sync). Body:
      // {deviceId, since, changes: [{type, id, payload, updatedAt, deleted}]}
      // Last-write-wins by updatedAt per entity; a tie keeps the higher
      // deviceId so every device agrees. Payments are separate records,
      // so two payments on one order never overwrite each other.
      // `type` is the app's own record kind — any product's kinds work
      // (laundry: order/customer/payment/rate/setting; an LIC office:
      // policy/customer/payment/...). The payload is stored as-is.
      if (path === "/api/sync" && req.method === "POST") {
        if (!isShop) return bad("Only a shop device can sync data.", 403);
        const body = await readJson(req);
        const deviceId = String(body?.deviceId ?? "").trim().slice(0, 64);
        const since = Number(body?.since ?? 0) || 0;
        const shopId = auth.shopId!;
        const app = await checkAppSoftware(shopId, body);
        if ("error" in app) return bad(app.error, 400);
        const dev = await deviceRow(shopId, deviceId);
        if (!dev) return bad("Unknown device — register this device first.", 401);
        if (dev.revoked === 1) return json({ revoked: true, error: "This device was removed by the main device." }, 403);
        const changes = Array.isArray(body?.changes) ? body.changes : [];
        if (changes.length > 500) return bad("Too many changes in one sync (max 500).");
        const now = Date.now();
        for (const c of changes) {
          const type = String(c?.type ?? "");
          const id = String(c?.id ?? "").trim().slice(0, 128);
          const updatedAt = Number(c?.updatedAt ?? 0) || 0;
          if (!SYNC_TYPE_RE.test(type) || !id || updatedAt <= 0) continue;
          const payload = typeof c?.payload === "string" ? c.payload : JSON.stringify(c?.payload ?? {});
          const deleted = c?.deleted === true || c?.deleted === 1 ? 1 : 0;
          const cur = await sqlOne<{ updated_at: number; device_id: string }>(
            "SELECT updated_at, device_id FROM sync_records WHERE shop_id = ? AND entity_type = ? AND entity_id = ?",
            shopId, type, id
          );
          if (cur && (cur.updated_at > updatedAt || (cur.updated_at === updatedAt && cur.device_id >= deviceId))) continue;
          await sqlRun(
            "INSERT INTO sync_records (shop_id, entity_type, entity_id, payload, updated_at, device_id, deleted) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, device_id = excluded.device_id, deleted = excluded.deleted",
            shopId, type, id, payload, updatedAt, deviceId, deleted
          );
        }
        await sqlRun("UPDATE devices SET last_sync_at = ? WHERE shop_id = ? AND device_id = ?", now, shopId, deviceId);
        const pulled = await sqlAll<any>(
          "SELECT entity_type AS type, entity_id AS id, payload, updated_at AS updatedAt, deleted FROM sync_records WHERE shop_id = ? AND updated_at > ? ORDER BY updated_at ASC",
          shopId, since
        );
        const deviceCountRow = await sqlOne<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE shop_id = ? AND revoked = 0", shopId);
        const deviceCount = deviceCountRow?.n ?? 0;
        return json({
          changes: pulled.map((r) => ({ ...r, deleted: r.deleted === 1, payload: JSON.parse(r.payload || "{}") })),
          serverTime: now,
          revoked: false,
          isMain: dev.is_main === 1,
          deviceCount,
          software: app.software,
          epoch: await shopEpoch(shopId),
        });
      }

      // Revoke / re-add a device. Caller must be the shop's main device
      // (it sends its own deviceId as callerDeviceId). The main device
      // itself can never be removed — assign a new main first.
      if (path.startsWith("/api/devices/") && path.endsWith("/revoke") && req.method === "POST") {
        if (!isShop) return bad("Only a shop device can remove devices.", 403);
        const targetId = decodeURIComponent(path.split("/")[3] ?? "");
        const body = await readJson(req);
        const callerId = String(body?.callerDeviceId ?? "").trim().slice(0, 64);
        const shopId = auth.shopId!;
        const caller = await deviceRow(shopId, callerId);
        if (!caller || caller.is_main !== 1 || caller.revoked === 1) {
          return bad("Only the main device can remove devices.", 403);
        }
        const target = await deviceRow(shopId, targetId);
        if (!target) return bad("Device not found.");
        if (target.is_main === 1) {
          return bad("The main device cannot be removed. Assign a new main device first.");
        }
        const revoked = body?.revoked === false ? 0 : 1;
        await sqlRun("UPDATE devices SET revoked = ? WHERE shop_id = ? AND device_id = ?", revoked, shopId, targetId);
        return json({ deviceId: targetId, revoked: revoked === 1 });
      }

      // Assign a new main device — CEO only (panel control for the
      // "main device lost" case). The new main picks it up on next sync.
      if (path.startsWith("/api/devices/") && path.endsWith("/set-main") && req.method === "POST") {
        if (isShop) return bad("Only the CEO can assign the main device.", 403);
        const targetId = decodeURIComponent(path.split("/")[3] ?? "");
        const target = await sqlOne<any>("SELECT * FROM devices WHERE device_id = ?", targetId);
        if (!target) return bad("Device not found.");
        await sqlRun("UPDATE devices SET is_main = 0 WHERE shop_id = ?", target.shop_id);
        await sqlRun("UPDATE devices SET is_main = 1, revoked = 0 WHERE shop_id = ? AND device_id = ?", target.shop_id, targetId);
        return json({ deviceId: targetId, shopId: target.shop_id, isMain: true });
      }

      return bad("Unknown API endpoint.", 404);
    }

    // ---- static client ----
    if (req.method === "GET") {
      if (path === "/" || path === "/index.html") {
        if (indexHtml === null) return new Response("Panel client not built yet.", { status: 500 });
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const file = await serveStatic(path);
      if (file) return file;
      if (indexHtml !== null) {
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("Not found.", { status: 404 });
    }

    return new Response("Not found.", { status: 404 });
  },
});

console.log(`Viru Empire CEO Panel live on port ${PORT} (DB: Turso)`);
