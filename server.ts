// Viru Empire CEO Panel — standalone server (Render free tier).
//
// Serves the same React client the Hatch space uses, plus:
//  - POST /actions  {action, args} -> {data} | {error}   (the panel web UI)
//  - REST /api/* for the Trimurti Laundry app sync client:
//      POST /api/login    {username, password} -> {token, username}
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

// ---------- REST auth (same session tokens as the panel) ----------

async function requireToken(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
  return rows[0] ? token : null;
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
    if (path === "/actions" && req.method === "POST") {
      const body = await readJson(req);
      const result = await callAction(String(body?.action ?? ""), body?.args ?? {});
      return json(result);
    }

    // ---- REST API for the laundry app ----
    if (path.startsWith("/api/")) {
      if (path === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        const r = await callAction("login", { username: body?.username ?? "", password: body?.password ?? "" });
        if (r.error) return bad(r.error, 401);
        return json(r.data);
      }
      const token = await requireToken(req);
      if (!token) return bad("UNAUTHORIZED", 401);

      if (path === "/api/dashboard" && req.method === "GET") {
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
        return json(r.data);
      }
      if (path === "/api/shops" && req.method === "POST") {
        const body = await readJson(req);
        const name = String(body?.name ?? "").trim();
        if (!name) return bad("Shop name is required.");
        const phone = String(body?.phone ?? "").trim();
        const existing = await db.select().from(schema.shops);
        const match = existing.find((s) => s.name === name && s.phone === phone);
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
          shopId: Number(url.searchParams.get("shopId") ?? 0) || 0,
        });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/keys" && req.method === "POST") {
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
        const shopId = await resolveShopId(body?.shopId);
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
        const r = await callAction("exportBackup", { token });
        if (r.error) return bad(r.error, 400);
        return json(r.data);
      }
      if (path === "/api/import" && req.method === "POST") {
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
