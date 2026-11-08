// Viru Empire CEO Panel — standalone server (Render free tier).
//
// Serves the same React client the Hatch space uses, plus:
//  - POST /actions  {action, args} -> {data} | {error}   (the panel web UI)
//    CEO session tokens ONLY — a shop token is rejected here, so the
//    phone's token can never call revealKey / exportBackup / generateKey.
//  - REST /api/* for the Trimurti Laundry app sync client:
//      POST /api/login    {username, password} -> {token, username}
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
// Data lives in a SQLite file (data/viru-empire.db). On Render's free tier
// the file survives sleeps and restarts, but is wiped on redeploy — the
// panel's Export / Backup is the safety net, so export regularly.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { Actions } from "./src/actions";
import * as schema from "./src/schema";
import { privilegedHandlers } from "./src/privileged";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "./data/viru-empire.db";
const CLIENT_DIR = "./client-dist";

// ---------- database ----------

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
const db = drizzle(sqlite, { schema });

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
`;
sqlite.exec(CREATE_TABLES);

// First-run CEO account from environment variables (set in the Render
// dashboard, never in a file): if no account exists yet, create the one
// named by CEO_USERNAME / CEO_PASSWORD. The password is only ever read
// from the process environment and stored as a salted hash.
const envUser = process.env.CEO_USERNAME?.trim();
const envPass = process.env.CEO_PASSWORD ?? "";
if (envUser && envPass) {
  const existing = sqlite.query("SELECT id FROM admin_account LIMIT 1").get();
  if (!existing) {
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(`${salt}:${envPass}`).digest("hex");
    sqlite
      .prepare("INSERT INTO admin_account (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)")
      .run(envUser, hash, salt, Date.now());
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
  const shopRows = sqlite
    .query("SELECT shop_id FROM shop_tokens WHERE token = ?")
    .all(token) as { shop_id: number }[];
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

// The laundry app sends software as "Laundry" — that is the panel's
// "Laundry Management System" product, so map it to the full name.
function mapSoftware(s: unknown): string {
  const v = String(s ?? "").trim();
  if (v.toLowerCase() === "laundry") return "Laundry Management System";
  return v;
}

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

    // ---- REST API for the laundry app ----
    if (path.startsWith("/api/")) {
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
                software: "Laundry Management System", status: "active",
                notes: "Added by CEO for shop-token setup.",
              })
              .returning({ id: schema.shops.id });
            shopId = row?.id ?? null;
          }
        }
        if (!shopId) return bad("Shop not found.");
        if (body?.revoke === true) {
          const deleted = sqlite.query("DELETE FROM shop_tokens WHERE shop_id = ?").run(shopId);
          return json({ revoked: deleted.changes ?? 0, shopId });
        }
        sqlite.query("DELETE FROM shop_tokens WHERE shop_id = ?").run(shopId);
        const shopToken = randomBytes(32).toString("hex");
        sqlite
          .query("INSERT INTO shop_tokens (token, shop_id, created_at) VALUES (?, ?, ?)")
          .run(shopToken, shopId, Date.now());
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
            software: mapSoftware(body?.software ?? match.software ?? ""),
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
          software: mapSoftware(body?.software ?? ""),
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

console.log(`Viru Empire CEO Panel live on port ${PORT} (DB: ${DB_PATH})`);
