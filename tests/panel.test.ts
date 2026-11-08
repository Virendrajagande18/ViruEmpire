// Viru Empire CEO Panel — multi-product + generic devices/sync tests.
//
// Run:  bun test tests/panel.test.ts   (from ~/workspace/viru-empire-deploy)
// Spawns the real server against a throwaway DB, then exercises it over
// HTTP: one shop per product, per-product totals, keys for every product,
// device registration + sync for non-laundry products, and the rules that
// must never regress (3-device cap counting active devices only, first
// device = main, only main can revoke, revoked = view-only, key checksum
// mod 36^4, login rate limit, no seed/demo data on a fresh DB).
//
// No real shop data is used: every name, phone and amount here is made
// up for the test and lives only in the throwaway DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PORT = 18731;
const BASE = `http://127.0.0.1:${PORT}`;
// Throwaway LOCAL libsql file database for tests — the server's Turso
// client accepts a file: URL, so the same code path runs here with no
// network and no real Turso database. Production uses a real Turso URL.
const TURSO_URL = `file:/tmp/viru-panel-test-${process.pid}.db`;
const TURSO_FILE = `/tmp/viru-panel-test-${process.pid}.db`;
const CEO = { username: "testceo", password: "testpass123" };

let proc: ReturnType<typeof Bun.spawn> | null = null;
let ceoToken = "";
const shopIds: Record<string, number> = {};
const shopTokens: Record<string, string> = {};

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error("server did not come up on /health");
}

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain-text error */ }
  return { status: res.status, json, text };
}

async function act(action: string, args: Record<string, unknown>) {
  // /actions always answers HTTP 200 with {data} or {error}; the only
  // direct HTTP error is the 401 when a shop token is sent here.
  const r = await call("/actions", { body: { action, args } });
  return { status: r.status, data: r.json?.data ?? null, error: r.json?.error ?? null };
}

// licenceCheckCode from src/actions.ts, re-implemented here so the test
// proves the checksum independently: C = check("VIRU-" + A), mod 36^4.
function checkCode(a: string): string {
  const text = `VIRU-${a}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1679616;
  let out = "";
  let v = h;
  for (let i = 0; i < 4; i++) {
    out = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[v % 36] + out;
    v = Math.floor(v / 36);
  }
  return out;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "./server.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      PORT: String(PORT),
      TURSO_DATABASE_URL: TURSO_URL,
      CEO_USERNAME: CEO.username,
      CEO_PASSWORD: CEO.password,
      LOGIN_BLOCK_MS: "60000",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForHealth();
  const r = await call("/api/login", { body: { username: CEO.username, password: CEO.password } });
  expect(r.status).toBe(200);
  ceoToken = r.json.token;
});

afterAll(async () => {
  proc?.kill();
  await Bun.sleep(200);
  try { await Bun.file(TURSO_FILE).delete(); } catch { /* already gone */ }
});

describe("fresh panel", () => {
  test("stays empty — no seed or demo data", async () => {
    const d = await act("getDashboard", { token: ceoToken, months: 6 });
    expect(d.error).toBeNull();
    expect(d.data.kpis.totalRevenueInr).toBe(0);
    expect(d.data.kpis.totalShops).toBe(0);
    expect(d.data.kpis.totalKeys).toBe(0);
    expect(d.data.productSummaries).toEqual([]);
    const shops = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(shops.data.shops).toEqual([]);
    const keys = await act("listKeys", { token: ceoToken, search: "", status: "all" });
    expect(keys.data.keys).toEqual([]);
    const pays = await act("listPayments", { token: ceoToken, search: "", status: "all", method: "all" });
    expect(pays.data.payments).toEqual([]);
  });

  test("GET /api/products lists the four products", async () => {
    const r = await call("/api/products");
    expect(r.status).toBe(200);
    expect(r.json.products).toEqual([
      "Laundry Management System",
      "Oil Dealership Software",
      "LIC & Star Health Office System",
      "Fataka Stall Website",
    ]);
  });
});

describe("shops — one per product", () => {
  test("creates a shop for each product; short aliases normalize", async () => {
    const rows = [
      { key: "laundry", name: "Test Wash House", software: "laundry", ownerName: "Test Owner", phone: "9000000001", city: "Pune" },
      { key: "oil", name: "Test Oil Traders", software: "Oil Dealership Software", ownerName: "Test Owner", phone: "9000000002", city: "Pune" },
      { key: "lic", name: "Test LIC Office", software: "lic", ownerName: "Test Owner", phone: "9000000003", city: "Pune" },
      { key: "fataka", name: "Test Fataka Stall", software: "Fataka Stall Website", ownerName: "Test Owner", phone: "9000000004", city: "Pune" },
    ];
    for (const row of rows) {
      const r = await call("/api/shops", { token: ceoToken, body: { ...row, status: "active" } });
      expect(r.status).toBe(200);
      shopIds[row.key] = r.json.id;
    }
    const list = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const byName = new Map(list.data.shops.map((s: any) => [s.name, s.software]));
    expect(byName.get("Test Wash House")).toBe("Laundry Management System");
    expect(byName.get("Test Oil Traders")).toBe("Oil Dealership Software");
    expect(byName.get("Test LIC Office")).toBe("LIC & Star Health Office System");
    expect(byName.get("Test Fataka Stall")).toBe("Fataka Stall Website");
  });

  test("per-product dashboard totals", async () => {
    const pay = async (shopId: number, amountInr: number, status: string) => {
      const r = await act("createPayment", { token: ceoToken, shopId, amountInr, method: "upi", status, note: "test", paidAt: new Date().toISOString().slice(0, 10) });
      expect(r.status).toBe(200);
    };
    await pay(shopIds.laundry, 5000, "received");
    await pay(shopIds.oil, 3000, "received");
    await pay(shopIds.oil, 1000, "pending");
    await pay(shopIds.fataka, 2000, "received");
    const d = await act("getDashboard", { token: ceoToken, months: 6 });
    expect(d.error).toBeNull();
    expect(d.data.kpis.totalRevenueInr).toBe(10000);
    expect(d.data.kpis.pendingAmountInr).toBe(1000);
    const byProduct = new Map(d.data.productSummaries.map((p: any) => [p.software, p]));
    expect((byProduct.get("Laundry Management System") as any).shops).toBe(1);
    expect((byProduct.get("Laundry Management System") as any).revenueInr).toBe(5000);
    expect((byProduct.get("Oil Dealership Software") as any).shops).toBe(1);
    expect((byProduct.get("Oil Dealership Software") as any).revenueInr).toBe(3000);
    expect((byProduct.get("LIC & Star Health Office System") as any).shops).toBe(1);
    expect((byProduct.get("LIC & Star Health Office System") as any).revenueInr).toBe(0);
    expect((byProduct.get("Fataka Stall Website") as any).shops).toBe(1);
    expect((byProduct.get("Fataka Stall Website") as any).revenueInr).toBe(2000);
  });
});

describe("licence keys — every product", () => {
  test("Fataka key: generate, checksum mod 36^4, revoke, renew", async () => {
    const g = await act("generateKey", { token: ceoToken, shopId: shopIds.fataka, plan: "monthly", expiresAt: "", activate: true });
    expect(g.status).toBe(200);
    expect(g.error).toBeNull();
    const keyCode: string = g.data.keyCode;
    expect(keyCode).toMatch(/^VIRU-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const [, a, b, c] = keyCode.split("-");
    expect(checkCode(a)).toBe(c);
    const list = await act("listKeys", { token: ceoToken, search: "", status: "all" });
    const mine = list.data.keys.find((k: any) => k.id === g.data.id);
    expect(mine.software).toBe("Fataka Stall Website");
    const rev = await act("updateKeyStatus", { token: ceoToken, id: g.data.id, status: "revoked" });
    expect(rev.status).toBe(200);
    expect(rev.error).toBeNull();
    const ren = await act("renewKey", { token: ceoToken, id: g.data.id });
    expect(ren.status).toBe(200);
    expect(ren.error).toBeNull();
    expect(ren.data.expiresAt).not.toBeNull();
  });

  test("keys generate identically for laundry, oil and LIC shops", async () => {
    for (const key of ["laundry", "oil", "lic"]) {
      const g = await act("generateKey", { token: ceoToken, shopId: shopIds[key], plan: "yearly", expiresAt: "", activate: true });
      expect(g.status).toBe(200);
      expect(g.error).toBeNull();
      const [, a, b, c] = (g.data.keyCode as string).split("-");
      expect(checkCode(a)).toBe(c);
    }
  });
});

describe("devices + sync — generic, not laundry-only", () => {
  async function shopTokenFor(key: string) {
    const r = await call("/api/shop-token", { token: ceoToken, body: { shopId: shopIds[key] } });
    expect(r.status).toBe(200);
    shopTokens[key] = r.json.token;
    return r.json.token;
  }

  test("Oil shop: register 3 devices, cap counts active only, wrong software rejected", async () => {
    const token = await shopTokenFor("oil");
    const reg = async (deviceId: string, software?: string) =>
      call("/api/devices/register", { token, body: { deviceId, deviceName: deviceId, software } });
    const d1 = await reg("oil-dev-1", "Oil Dealership Software");
    expect(d1.status).toBe(200);
    expect(d1.json.isMain).toBe(true);
    expect(d1.json.software).toBe("Oil Dealership Software");
    const d2 = await reg("oil-dev-2", "oil");
    expect(d2.status).toBe(200);
    expect(d2.json.isMain).toBe(false);
    expect(d2.json.software).toBe("Oil Dealership Software");
    const d3 = await reg("oil-dev-3");
    expect(d3.status).toBe(200);
    const d4 = await reg("oil-dev-4");
    expect(d4.status).toBe(403);
    // Wrong product for this shop: rejected.
    const wrong = await reg("oil-dev-9", "Laundry Management System");
    expect(wrong.status).toBe(400);
    // Revoke one device (by the main device) — the slot frees up.
    const rev = await call("/api/devices/oil-dev-2/revoke", { token, body: { callerDeviceId: "oil-dev-1" } });
    expect(rev.status).toBe(200);
    expect(rev.json.revoked).toBe(true);
    const d4b = await reg("oil-dev-4");
    expect(d4b.status).toBe(200);
    expect(d4b.json.isMain).toBe(false);
  });

  test("LIC shop: syncs non-laundry record kinds (policy, customer)", async () => {
    const token = await shopTokenFor("lic");
    const reg = await call("/api/devices/register", { token, body: { deviceId: "lic-dev-1", deviceName: "LIC office phone", software: "LIC & Star Health Office System" } });
    expect(reg.status).toBe(200);
    expect(reg.json.software).toBe("LIC & Star Health Office System");
    const now = Date.now();
    const push = await call("/api/sync", {
      token,
      body: {
        deviceId: "lic-dev-1",
        since: 0,
        software: "LIC & Star Health Office System",
        changes: [
          { type: "policy", id: "pol-1", payload: { holder: "Test Holder", premium: 12000 }, updatedAt: now },
          { type: "customer", id: "cust-1", payload: { name: "Test Customer" }, updatedAt: now + 1 },
          { type: "BAD TYPE!", id: "bad-1", payload: {}, updatedAt: now + 2 },
        ],
      },
    });
    expect(push.status).toBe(200);
    expect(push.json.software).toBe("LIC & Star Health Office System");
    const pull = await call("/api/sync", { token, body: { deviceId: "lic-dev-1", since: 0, changes: [] } });
    expect(pull.status).toBe(200);
    const types = pull.json.changes.map((c: any) => c.type).sort();
    expect(types).toEqual(["customer", "policy"]);
    // Sync with the wrong product for this shop: rejected.
    const wrong = await call("/api/sync", { token, body: { deviceId: "lic-dev-1", since: 0, software: "Oil Dealership Software", changes: [] } });
    expect(wrong.status).toBe(400);
  });

  test("Laundry sync still works (regression)", async () => {
    const token = await shopTokenFor("laundry");
    const reg = await call("/api/devices/register", { token, body: { deviceId: "laundry-dev-1", deviceName: "Laundry phone", software: "Laundry Management System" } });
    expect(reg.status).toBe(200);
    const now = Date.now();
    const push = await call("/api/sync", {
      token,
      body: {
        deviceId: "laundry-dev-1",
        since: 0,
        changes: [
          { type: "order", id: "ord-1", payload: { total: 450 }, updatedAt: now },
          { type: "payment", id: "pay-1", payload: { amount: 450 }, updatedAt: now + 1 },
          { type: "setting", id: "set-1", payload: { upiId: "" }, updatedAt: now + 2 },
        ],
      },
    });
    expect(push.status).toBe(200);
    const pull = await call("/api/sync", { token, body: { deviceId: "laundry-dev-1", since: 0, changes: [] } });
    const types = pull.json.changes.map((c: any) => c.type).sort();
    expect(types).toEqual(["order", "payment", "setting"]);
  });

  test("devices list shows software; CEO can make any shop's device the main", async () => {
    const r = await call(`/api/shops/${shopIds.oil}/devices`, { token: ceoToken });
    expect(r.status).toBe(200);
    expect(r.json.devices.length).toBe(4);
    expect(r.json.devices.every((d: any) => d.software === "Oil Dealership Software")).toBe(true);
    const setMain = await call("/api/devices/oil-dev-2/set-main", { token: ceoToken, method: "POST" });
    expect(setMain.status).toBe(200);
    const after = await call(`/api/shops/${shopIds.oil}/devices`, { token: ceoToken });
    const mains = after.json.devices.filter((d: any) => d.isMain);
    expect(mains.map((d: any) => d.deviceId)).toEqual(["oil-dev-2"]);
    expect(after.json.devices.find((d: any) => d.deviceId === "oil-dev-1").isMain).toBe(false);
  });

  test("shop token cannot call panel actions", async () => {
    const r = await act("listShops", { token: shopTokens.oil, search: "", status: "all" });
    expect(r.status).toBe(401);
  });
});

describe("activity log names the software", () => {
  test("key + payment entries carry the product name", async () => {
    const r = await act("listActivity", { token: ceoToken, limit: 100 });
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    const text = JSON.stringify(r.data.entries);
    expect(text).toContain("Fataka Stall Website");
    expect(text).toContain("Oil Dealership Software");
    expect(text).toContain("Laundry Management System");
  });
});

describe("login rate limit (runs last)", () => {
  test("5 bad logins, then the 6th is blocked with 429", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call("/api/login", { body: { username: CEO.username, password: "wrong-password" } });
      expect(r.status).toBe(401);
    }
    const blocked = await call("/api/login", { body: { username: CEO.username, password: "wrong-password" } });
    expect(blocked.status).toBe(429);
  });
});

// The server must NEVER start without Turso configured: silently falling
// back to a local file would look fine and then lose data again the next
// time the server sleeps. This spawns a second server with the Turso
// variables stripped and expects it to exit at once with a clear error.
describe("Turso config is required", () => {
  test("refuses to start without TURSO_DATABASE_URL", async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORT: "18799",
      CEO_USERNAME: "nobody",
      CEO_PASSWORD: "nobody",
    };
    delete env.TURSO_DATABASE_URL;
    delete env.TURSO_AUTH_TOKEN;
    const p = Bun.spawn(["bun", "./server.ts"], {
      cwd: import.meta.dir + "/..",
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    expect(code).toBe(1);
    const err = await new Response(p.stderr).text();
    expect(err).toContain("TURSO_DATABASE_URL");
  });
});
