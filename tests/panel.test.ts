// Viru Empire CEO Panel — multi-product + generic devices/sync tests.
//
// Run:  bun test tests/panel.test.ts   (from ~/workspace/viru-empire-deploy)
// Spawns the real server against a throwaway DB, then exercises it over
// HTTP: one shop per product, per-product totals, keys for every product,
// device registration + sync for non-laundry products, and the rules that
// must never regress (3-device cap counting active devices only, first
// device = main, only main can revoke, revoked = view-only, key checksum
// mod 36^4, login rate limit, no seed/demo data on a fresh DB).
// v1.1.20: customer payments removed (POST /api/payments is a no-op,
// dashboard revenue stays 0, no payment log entries), licence payments
// (money shops pay for their licence — add/edit/delete + log), and the
// 3-day trial by phone number (first call starts it, reinstall gets no
// new trial, IST daysLeft math).
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

  test("per-product dashboard totals (customer payments removed — revenue stays 0)", async () => {
    // v1.1.20 item 9: recording a customer payment stores nothing and
    // the dashboard no longer reads the payments table, so every
    // payment-derived number stays 0. Shops per product still work.
    const pay = async (shopId: number, amountInr: number, status: string) => {
      const r = await act("createPayment", { token: ceoToken, shopId, amountInr, method: "upi", status, note: "test", paidAt: new Date().toISOString().slice(0, 10) });
      expect(r.status).toBe(200);
      expect(r.data.id).toBe(0); // no-op: nothing stored
    };
    await pay(shopIds.laundry, 5000, "received");
    await pay(shopIds.oil, 3000, "received");
    await pay(shopIds.oil, 1000, "pending");
    await pay(shopIds.fataka, 2000, "received");
    const d = await act("getDashboard", { token: ceoToken, months: 6 });
    expect(d.error).toBeNull();
    expect(d.data.kpis.totalRevenueInr).toBe(0);
    expect(d.data.kpis.revenueThisMonthInr).toBe(0);
    expect(d.data.kpis.pendingAmountInr).toBe(0);
    expect(d.data.kpis.pendingCount).toBe(0);
    expect(d.data.recentPayments).toEqual([]);
    const byProduct = new Map(d.data.productSummaries.map((p: any) => [p.software, p]));
    expect((byProduct.get("Laundry Management System") as any).shops).toBe(1);
    expect((byProduct.get("Laundry Management System") as any).revenueInr).toBe(0);
    expect((byProduct.get("Oil Dealership Software") as any).shops).toBe(1);
    expect((byProduct.get("Oil Dealership Software") as any).revenueInr).toBe(0);
    expect((byProduct.get("LIC & Star Health Office System") as any).shops).toBe(1);
    expect((byProduct.get("LIC & Star Health Office System") as any).revenueInr).toBe(0);
    expect((byProduct.get("Fataka Stall Website") as any).shops).toBe(1);
    expect((byProduct.get("Fataka Stall Website") as any).revenueInr).toBe(0);
    // And the payments table itself is untouched (still empty here).
    const pays = await act("listPayments", { token: ceoToken, search: "", status: "all", method: "all" });
    expect(pays.data.payments).toEqual([]);
    expect(pays.data.totals.count).toBe(0);
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
  test("key + shop entries carry the product name; no customer-payment entries", async () => {
    const r = await act("listActivity", { token: ceoToken, limit: 100 });
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    const text = JSON.stringify(r.data.entries);
    expect(text).toContain("Fataka Stall Website");
    expect(text).toContain("Oil Dealership Software");
    expect(text).toContain("Laundry Management System");
    // v1.1.20 item 9: customer-payment log entries are gone for good.
    const actions = r.data.entries.map((e: any) => e.action);
    expect(actions).not.toContain("Recorded payment");
    expect(actions).not.toContain("Deleted payment");
  });
});

describe("phone-only identity + device names (v1.1.16)", () => {
  let idShopId = 0;
  let idToken = "";
  const ID_PHONE = "9000000009";
  const ID_NAME = "Phone Identity Test Shop";

  test("setup: create the shop and mint its token", async () => {
    const c = await call("/api/shops", { token: ceoToken, body: { name: ID_NAME, software: "laundry", ownerName: "Test Owner", phone: ID_PHONE, city: "Pune", status: "active" } });
    expect(c.status).toBe(200);
    idShopId = c.json.id;
    const m = await call("/api/shop-token", { token: ceoToken, body: { shopId: idShopId } });
    expect(m.status).toBe(200);
    idToken = m.json.token;
  });

  test("mint with a renamed name + same phone returns the SAME shop, no duplicate row", async () => {
    const before = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const countBefore = before.data.shops.length;
    const m = await call("/api/shop-token", { token: ceoToken, body: { shopName: "Renamed Shop", shopPhone: ID_PHONE } });
    expect(m.status).toBe(200);
    expect(m.json.shopId).toBe(idShopId);
    // Minting replaces the shop's token: the new one is the live one.
    idToken = m.json.token;
    const after = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(after.data.shops.length).toBe(countBefore);
  });

  test("mint with a phone variant (+91 / spaces) returns the SAME shop", async () => {
    const m = await call("/api/shop-token", { token: ceoToken, body: { shopName: ID_NAME, shopPhone: "+91 90000 00009" } });
    expect(m.status).toBe(200);
    expect(m.json.shopId).toBe(idShopId);
    idToken = m.json.token;
  });

  test("mint with a new name + new phone creates ONE new shop (no silent reuse)", async () => {
    const before = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const m = await call("/api/shop-token", { token: ceoToken, body: { shopName: "Brand New Shop", shopPhone: "9000000019" } });
    expect(m.status).toBe(200);
    expect(m.json.shopId).not.toBe(idShopId);
    const after = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(after.data.shops.length).toBe(before.data.shops.length + 1);
  });

  test("shop-token POST /api/shops with a renamed name changes nothing", async () => {
    const before = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const countBefore = before.data.shops.length;
    const r = await call("/api/shops", { token: idToken, body: { name: "Renamed Shop", ownerName: "Someone Else", phone: ID_PHONE, city: "Mumbai" } });
    expect(r.status).toBe(200);
    expect(r.json.updated).toBe(false);
    const list = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(list.data.shops.length).toBe(countBefore);
    const row = list.data.shops.find((s: any) => s.id === idShopId);
    expect(row.name).toBe(ID_NAME);
    expect(row.ownerName).toBe("Test Owner");
    expect(row.city).toBe("Pune");
  });

  test("device name: blank at register, filled on the next sync, updated on re-register", async () => {
    const regBlank = await call("/api/devices/register", { token: idToken, body: { deviceId: "id-dev-1" } });
    expect(regBlank.status).toBe(200);
    let list = await call(`/api/shops/${idShopId}/devices`, { token: ceoToken });
    let row = list.json.devices.find((d: any) => d.deviceId === "id-dev-1");
    expect(row.name).toBe("");
    const sync = await call("/api/sync", { token: idToken, body: { deviceId: "id-dev-1", since: 0, deviceName: "Xiaomi Redmi Note 9 Pro", changes: [] } });
    expect(sync.status).toBe(200);
    list = await call(`/api/shops/${idShopId}/devices`, { token: ceoToken });
    row = list.json.devices.find((d: any) => d.deviceId === "id-dev-1");
    expect(row.name).toBe("Xiaomi Redmi Note 9 Pro");
    // Sync without a name, and with a blank name, never blanks it.
    await call("/api/sync", { token: idToken, body: { deviceId: "id-dev-1", since: 0, changes: [] } });
    await call("/api/sync", { token: idToken, body: { deviceId: "id-dev-1", since: 0, deviceName: "   ", changes: [] } });
    list = await call(`/api/shops/${idShopId}/devices`, { token: ceoToken });
    row = list.json.devices.find((d: any) => d.deviceId === "id-dev-1");
    expect(row.name).toBe("Xiaomi Redmi Note 9 Pro");
    // Re-register with a new name updates it.
    const re = await call("/api/devices/register", { token: idToken, body: { deviceId: "id-dev-1", deviceName: "Poco F7" } });
    expect(re.status).toBe(200);
    list = await call(`/api/shops/${idShopId}/devices`, { token: ceoToken });
    row = list.json.devices.find((d: any) => d.deviceId === "id-dev-1");
    expect(row.name).toBe("Poco F7");
  });

  test("payments: phone string, name string and an unknown string all record to the own shop", async () => {
    const pay = async (shopId: unknown) =>
      call("/api/payments", { token: idToken, body: { amountInr: 100, method: "upi", status: "paid", shopId, paidAt: Date.now() } });
    expect((await pay(ID_PHONE)).status).toBe(200);
    expect((await pay(ID_NAME)).status).toBe(200);
    expect((await pay("9999999999")).status).toBe(200);
  });
});

describe("panel backup import (v1.1.16)", () => {
  test("export then re-import: everything is skipped, nothing duplicates", async () => {
    const exp = await act("exportBackup", { token: ceoToken });
    expect(exp.status).toBe(200);
    expect(exp.error).toBeNull();
    const backup = exp.data;
    const total = backup.counts.shops + backup.counts.licenseKeys + backup.counts.payments;
    expect(total).toBeGreaterThan(0);
    const imp = await act("importBackup", { token: ceoToken, backup });
    expect(imp.status).toBe(200);
    expect(imp.error).toBeNull();
    expect(imp.data.importedShops).toBe(0);
    expect(imp.data.importedKeys).toBe(0);
    expect(imp.data.importedPayments).toBe(0);
    expect(imp.data.skipped).toBe(total);
  });

  test("corrupt backup (wrong shape) fails before anything is added", async () => {
    const before = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const countBefore = before.data.shops.length;
    const bad = await act("importBackup", { token: ceoToken, backup: { shops: "not an array" } });
    expect(bad.error).not.toBeNull();
    const after = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(after.data.shops.length).toBe(countBefore);
  });

  test("empty backup imports nothing and changes nothing", async () => {
    const imp = await act("importBackup", { token: ceoToken, backup: {} });
    expect(imp.error).toBeNull();
    expect(imp.data.importedShops).toBe(0);
    expect(imp.data.importedKeys).toBe(0);
    expect(imp.data.importedPayments).toBe(0);
    expect(imp.data.skipped).toBe(0);
  });

  test("renamed shop: no duplicate row, and its keys + payments still link by phone", async () => {
    const c = await call("/api/shops", { token: ceoToken, body: { name: "Import Link Shop", software: "laundry", ownerName: "Test Owner", phone: "9000000039", city: "Pune", status: "active" } });
    expect(c.status).toBe(200);
    const shopId = c.json.id;
    const g = await act("generateKey", { token: ceoToken, shopId, plan: "monthly", expiresAt: "", activate: true });
    expect(g.status).toBe(200);
    // The shop is RENAMED in the live panel (same phone)...
    const ren = await act("updateShop", { token: ceoToken, id: shopId, name: "Renamed Link Shop", ownerName: "Test Owner", phone: "9000000039", city: "Pune", software: "Laundry Management System", status: "active", notes: "", joinedAt: "" });
    expect(ren.error).toBeNull();
    // ...then a backup naming the OLD name is imported.
    const before = await act("listShops", { token: ceoToken, search: "", status: "all" });
    const backup = {
      shops: [{ name: "Import Link Shop", phone: "9000000039", city: "Pune", software: "Laundry Management System", status: "active" }],
      licenseKeys: [{ keyCode: "VIRU-IMPT-0001-AAAA", shopName: "Import Link Shop", plan: "yearly", status: "unused", expiresAt: null }],
      payments: [{ shopName: "Import Link Shop", amountInr: 777, method: "upi", status: "received", note: "import-link-test-777", paidAt: "2026-11-16" }],
    };
    const imp = await act("importBackup", { token: ceoToken, backup });
    expect(imp.error).toBeNull();
    expect(imp.data.importedShops).toBe(0);
    expect(imp.data.importedKeys).toBe(1);
    expect(imp.data.importedPayments).toBe(1);
    const after = await act("listShops", { token: ceoToken, search: "", status: "all" });
    expect(after.data.shops.length).toBe(before.data.shops.length);
    expect(after.data.shops.filter((s: any) => s.phone === "9000000039").length).toBe(1);
    const keys = await act("listKeys", { token: ceoToken, search: "", status: "all" });
    // listKeys returns the MASKED code (first + last block visible).
    const mine = keys.data.keys.find((k: any) => k.keyMasked === "VIRU-IMPT-••••-AAAA");
    expect(mine.shopId).toBe(shopId);
    const pays = await act("listPayments", { token: ceoToken, search: "import-link-test-777", status: "all", method: "all" });
    const pay = pays.data.payments.find((p: any) => p.note === "import-link-test-777");
    expect(pay.shopId).toBe(shopId);
    expect(pay.shopName).toBe("Renamed Link Shop");
  });
});

describe("customer payments removed (v1.1.20 item 9)", () => {
  test("POST /api/payments is a no-op: ok:true, stores nothing (CEO + shop token)", async () => {
    const before = await act("listPayments", { token: ceoToken, search: "", status: "all", method: "all" });
    const countBefore = before.data.totals.count;
    const r1 = await call("/api/payments", { token: ceoToken, body: { amountInr: 500, method: "upi", status: "paid", shopId: shopIds.laundry, paidAt: Date.now() } });
    expect(r1.status).toBe(200);
    expect(r1.json.ok).toBe(true);
    const r2 = await call("/api/payments", { token: shopTokens.laundry, body: { amountInr: 700, method: "cash", status: "paid", shopId: "9000000001", paidAt: Date.now() } });
    expect(r2.status).toBe(200);
    expect(r2.json.ok).toBe(true);
    // Even a malformed body succeeds silently (old phones must never break).
    const r3 = await call("/api/payments", { token: shopTokens.laundry, body: { amountInr: -5 } });
    expect(r3.status).toBe(200);
    expect(r3.json.ok).toBe(true);
    const after = await act("listPayments", { token: ceoToken, search: "", status: "all", method: "all" });
    expect(after.data.totals.count).toBe(countBefore);
  });

  test("POST /api/payments without a token is still rejected", async () => {
    const r = await call("/api/payments", { body: { amountInr: 100 } });
    expect(r.status).toBe(401);
  });

  test("no Recorded/Deleted payment entries in the activity log", async () => {
    const r = await act("listActivity", { token: ceoToken, limit: 200 });
    const actions = r.data.entries.map((e: any) => e.action);
    expect(actions).not.toContain("Recorded payment");
    expect(actions).not.toContain("Deleted payment");
  });
});

describe("licence payments (v1.1.20 item 12)", () => {
  let lpId = 0;

  test("record, list newest-first with shop name, total", async () => {
    const c1 = await act("createLicencePayment", { token: ceoToken, shopId: shopIds.laundry, amountInr: 5000, method: "upi", note: "Yearly licence", paidAt: "2026-11-01" });
    expect(c1.error).toBeNull();
    lpId = c1.data.id;
    const c2 = await act("createLicencePayment", { token: ceoToken, shopId: shopIds.oil, amountInr: 3000, method: "cash", note: "Monthly licence", paidAt: "2026-11-10" });
    expect(c2.error).toBeNull();
    const list = await act("listLicencePayments", { token: ceoToken });
    expect(list.error).toBeNull();
    expect(list.data.totalInr).toBe(8000);
    expect(list.data.payments.length).toBe(2);
    // Newest first (by paid date).
    expect(list.data.payments[0].id).toBe(c2.data.id);
    expect(list.data.payments[0].shopName).toBe("Test Oil Traders");
    expect(list.data.payments[0].software).toBe("Oil Dealership Software");
    expect(list.data.payments[1].shopName).toBe("Test Wash House");
    // The old customer-payments table is untouched by licence payments.
    const old = await act("listPayments", { token: ceoToken, search: "Yearly licence", status: "all", method: "all" });
    expect(old.data.payments).toEqual([]);
  });

  test("edit a licence payment", async () => {
    const u = await act("updateLicencePayment", { token: ceoToken, id: lpId, shopId: shopIds.laundry, amountInr: 5500, method: "bank", note: "Yearly licence (corrected)", paidAt: "2026-11-02" });
    expect(u.error).toBeNull();
    const list = await act("listLicencePayments", { token: ceoToken });
    const mine = list.data.payments.find((p: any) => p.id === lpId);
    expect(mine.amountInr).toBe(5500);
    expect(mine.method).toBe("bank");
    expect(mine.note).toBe("Yearly licence (corrected)");
    expect(mine.paidAt).toBe("2026-11-02");
    expect(list.data.totalInr).toBe(8500);
  });

  test("delete a licence payment; add/edit/delete are in the activity log", async () => {
    const d = await act("deleteLicencePayment", { token: ceoToken, id: lpId });
    expect(d.error).toBeNull();
    const list = await act("listLicencePayments", { token: ceoToken });
    expect(list.data.payments.find((p: any) => p.id === lpId)).toBeUndefined();
    expect(list.data.totalInr).toBe(3000);
    const log = await act("listActivity", { token: ceoToken, limit: 200 });
    const actions = log.data.entries.map((e: any) => e.action);
    expect(actions).toContain("Recorded licence payment");
    expect(actions).toContain("Edited licence payment");
    expect(actions).toContain("Deleted licence payment");
  });

  test("shop token cannot use licence payment actions", async () => {
    const r = await act("listLicencePayments", { token: shopTokens.laundry });
    expect(r.status).toBe(401);
  });
});

describe("3-day trial (v1.1.20 item 13)", () => {
  // Same IST math as the server (the API contract with the app).
  function istToday(): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function addDays(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  test("first call starts the trial today (IST), end = start + 2, daysLeft 2", async () => {
    const r = await call("/api/trial", { token: ceoToken, body: { phone: "9811111111" } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.trialStart).toBe(istToday());
    expect(r.json.trialEnd).toBe(addDays(istToday(), 2));
    expect(r.json.daysLeft).toBe(2);
  });

  test("second call with same phone (any format) returns the SAME start — reinstall gets no new trial", async () => {
    const r = await call("/api/trial", { token: shopTokens.laundry, body: { phone: "+91 98111 11111" } });
    expect(r.status).toBe(200);
    expect(r.json.trialStart).toBe(istToday());
    expect(r.json.daysLeft).toBe(2);
  });

  test("a different phone gets its own trial", async () => {
    const r = await call("/api/trial", { token: ceoToken, body: { phone: "9822222222" } });
    expect(r.status).toBe(200);
    expect(r.json.trialStart).toBe(istToday());
    expect(r.json.daysLeft).toBe(2);
  });

  test("daysLeft math: an old trial is over (negative), end day is 0", async () => {
    // Seed trial rows directly in the throwaway DB: one started 5 days
    // ago (end was 3 days ago -> daysLeft -3), one started 2 days ago
    // (today is the end day -> daysLeft 0). The API must return those
    // stored starts unchanged.
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: TURSO_URL });
    const oldStart = addDays(istToday(), -5);
    const endStart = addDays(istToday(), -2);
    await c.execute({ sql: "INSERT OR IGNORE INTO trials (phone, trial_start, created_at) VALUES (?, ?, ?)", args: ["9833333333", oldStart, Date.now()] });
    await c.execute({ sql: "INSERT OR IGNORE INTO trials (phone, trial_start, created_at) VALUES (?, ?, ?)", args: ["9844444444", endStart, Date.now()] });
    const old = await call("/api/trial", { token: ceoToken, body: { phone: "9833333333" } });
    expect(old.status).toBe(200);
    expect(old.json.trialStart).toBe(oldStart);
    expect(old.json.trialEnd).toBe(addDays(oldStart, 2));
    expect(old.json.daysLeft).toBe(-3);
    const end = await call("/api/trial", { token: ceoToken, body: { phone: "9844444444" } });
    expect(end.status).toBe(200);
    expect(end.json.trialStart).toBe(endStart);
    expect(end.json.daysLeft).toBe(0);
  });

  test("GET /api/trials lists all trials for the CEO; shop token is refused", async () => {
    const r = await call("/api/trials", { token: ceoToken });
    expect(r.status).toBe(200);
    const phones = r.json.trials.map((t: any) => t.phone);
    expect(phones).toContain("9811111111");
    expect(phones).toContain("9822222222");
    expect(phones).toContain("9833333333");
    const mine = r.json.trials.find((t: any) => t.phone === "9811111111");
    expect(mine.trialStart).toBe(istToday());
    expect(mine.trialEnd).toBe(addDays(istToday(), 2));
    expect(mine.daysLeft).toBe(2);
    const refused = await call("/api/trials", { token: shopTokens.laundry });
    expect(refused.status).toBe(403);
  });

  test("trial without a token is rejected; bad phone is rejected", async () => {
    const noAuth = await call("/api/trial", { body: { phone: "9855555555" } });
    expect(noAuth.status).toBe(401);
    const badPhone = await call("/api/trial", { token: ceoToken, body: { phone: "" } });
    expect(badPhone.status).toBe(400);
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

// The free panel sleeps when idle (Render): the first sync or register
// after a sleep fails, and the app retries once after 20 s (JVM-tested
// shouldRetrySync). This proves the server side: a stopped server
// refuses, and the SAME token + device work again the moment it is
// back, with no re-setup.
describe("panel asleep, then awake (v1.1.16)", () => {
  const WAKE_PORT = 18798;
  const WAKE_BASE = `http://127.0.0.1:${WAKE_PORT}`;
  const WAKE_DB = `/tmp/viru-panel-test-wake-${process.pid}.db`;
  async function waitFor(base: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const res = await fetch(`${base}/health`); if (res.ok) return; } catch { /* not up yet */ }
      await Bun.sleep(200);
    }
    throw new Error("server did not come up on /health");
  }
  async function callWake(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
    const res = await fetch(`${WAKE_BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain-text error */ }
    return { status: res.status, json, text };
  }
  function spawnWake() {
    return Bun.spawn(["bun", "./server.ts"], {
      cwd: import.meta.dir + "/..",
      env: {
        ...process.env,
        PORT: String(WAKE_PORT),
        TURSO_DATABASE_URL: `file:${WAKE_DB}`,
        CEO_USERNAME: CEO.username,
        CEO_PASSWORD: CEO.password,
        LOGIN_BLOCK_MS: "60000",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  test("register + sync work, server stops, same token + device work again after restart", async () => {
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      proc = spawnWake();
      await waitFor(WAKE_BASE);
      const login = await callWake("/api/login", { body: { username: CEO.username, password: CEO.password } });
      expect(login.status).toBe(200);
      const ceo = login.json.token;
      const shop = await callWake("/api/shops", { token: ceo, body: { name: "Wake Test Shop", software: "laundry", ownerName: "Test", phone: "9000000029", city: "Pune", status: "active" } });
      expect(shop.status).toBe(200);
      const mint = await callWake("/api/shop-token", { token: ceo, body: { shopId: shop.json.id } });
      expect(mint.status).toBe(200);
      const token = mint.json.token;
      const reg = await callWake("/api/devices/register", { token, body: { deviceId: "wake-dev-1", deviceName: "Wake Phone" } });
      expect(reg.status).toBe(200);
      const sync1 = await callWake("/api/sync", { token, body: { deviceId: "wake-dev-1", since: 0, changes: [] } });
      expect(sync1.status).toBe(200);
      // The panel "sleeps": stop the server. Calls now fail outright.
      proc.kill();
      await proc.exited;
      proc = null;
      let failed = false;
      try { await fetch(`${WAKE_BASE}/health`); } catch { failed = true; }
      expect(failed).toBe(true);
      // The panel "wakes": same DB file, same port, same token + device.
      proc = spawnWake();
      await waitFor(WAKE_BASE);
      const reg2 = await callWake("/api/devices/register", { token, body: { deviceId: "wake-dev-1", deviceName: "Wake Phone" } });
      expect(reg2.status).toBe(200);
      expect(reg2.json.slot).toBe(1);
      const sync2 = await callWake("/api/sync", { token, body: { deviceId: "wake-dev-1", since: 0, changes: [] } });
      expect(sync2.status).toBe(200);
    } finally {
      proc?.kill();
      try { await proc?.exited; } catch { /* already gone */ }
      try { await Bun.file(WAKE_DB).delete(); } catch { /* already gone */ }
    }
  });
});


describe("keep-alive ping + 3-phone sync (v1.1.19)", () => {
  const SOFTWARE = "Laundry Management System";
  let shop3: number;
  let token3: string;

  async function shopToken(shopId: number) {
    const r = await call("/api/shop-token", { token: ceoToken, body: { shopId } });
    expect(r.status).toBe(200);
    return r.json.token;
  }

  test("GET /ping answers without auth, no database hit, just awake", async () => {
    const t0 = Date.now();
    const r = await call("/ping");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.time).toBe("number");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("setup: a fresh laundry shop for the 3-phone flow", async () => {
    const r = await call("/api/shops", {
      token: ceoToken,
      body: { name: "Test Sync House", software: "laundry", ownerName: "Test Owner", phone: "9000000005", city: "Pune", status: "active" },
    });
    expect(r.status).toBe(200);
    shop3 = r.json.id;
    token3 = await shopToken(shop3);
  });

  test("3 phones register: first is main, 4th refused", async () => {
    const reg = async (deviceId: string) =>
      call("/api/devices/register", { token: token3, body: { deviceId, deviceName: deviceId, software: SOFTWARE } });
    const d1 = await reg("sync119-a");
    expect(d1.status).toBe(200);
    expect(d1.json.isMain).toBe(true);
    expect(d1.json.slot).toBe(1);
    const d2 = await reg("sync119-b");
    expect(d2.status).toBe(200);
    expect(d2.json.isMain).toBe(false);
    expect(d2.json.slot).toBe(2);
    const d3 = await reg("sync119-c");
    expect(d3.status).toBe(200);
    expect(d3.json.slot).toBe(3);
    const d4 = await reg("sync119-d");
    expect(d4.status).toBe(403);
  });

  test("phone 1 pushes a bill, phone 2 pulls it, phone 3 pulls it too", async () => {
    const now = Date.now();
    const push = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", since: 0, software: SOFTWARE,
        changes: [{ type: "order", id: "ord-119", payload: { code: "LD-1-1001", total: 210 }, updatedAt: now }],
      },
    });
    expect(push.status).toBe(200);
    // Push echo: the stored time is the pushed time for a normal change.
    expect(push.json.stored.length).toBe(1);
    expect(push.json.stored[0].type).toBe("order");
    expect(push.json.stored[0].id).toBe("ord-119");
    expect(push.json.stored[0].updatedAt).toBe(now);
    expect(push.json.stored[0].seq).toBeGreaterThan(0);
    expect(push.json.serverSeq).toBe(push.json.stored[0].seq);
    for (const dev of ["sync119-b", "sync119-c"]) {
      const pull = await call("/api/sync", { token: token3, body: { deviceId: dev, since: 0, software: SOFTWARE, changes: [] } });
      expect(pull.status).toBe(200);
      const ord = pull.json.changes.find((c: any) => c.type === "order" && c.id === "ord-119");
      expect(ord).toBeDefined();
      expect(ord.payload.total).toBe(210);
    }
  });

  test("two phones pay the same bill at once: both payments survive, none doubled", async () => {
    const now = Date.now();
    const p1 = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", since: 0, software: SOFTWARE,
        changes: [{ type: "payment", id: "pay-119-a", payload: { orderSyncId: "ord-119", amount: 100, method: "Cash" }, updatedAt: now }],
      },
    });
    expect(p1.status).toBe(200);
    const p2 = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-b", since: 0, software: SOFTWARE,
        changes: [{ type: "payment", id: "pay-119-b", payload: { orderSyncId: "ord-119", amount: 110, method: "UPI" }, updatedAt: now + 1 }],
      },
    });
    expect(p2.status).toBe(200);
    // A re-delivered payment is not stored twice: same id, same time.
    const again = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", since: 0, software: SOFTWARE,
        changes: [{ type: "payment", id: "pay-119-a", payload: { orderSyncId: "ord-119", amount: 100, method: "Cash" }, updatedAt: now }],
      },
    });
    expect(again.status).toBe(200);
    const pull = await call("/api/sync", { token: token3, body: { deviceId: "sync119-c", since: 0, software: SOFTWARE, changes: [] } });
    const pays = pull.json.changes.filter((c: any) => c.type === "payment");
    expect(pays.map((c: any) => c.id).sort()).toEqual(["pay-119-a", "pay-119-b"]);
    expect(pays.map((c: any) => c.payload.amount).sort()).toEqual([100, 110]);
  });

  test("offline change with an old stamp still reaches the other phone (seq pull)", async () => {
    // Phone B syncs first, so its cursor is at server time. Phone A
    // then pushes a bill stamped an hour ago (made offline, or a clock
    // behind the server). A timestamp pull would miss it forever; the
    // receipt sequence catches it, because the seq is handed out at
    // receipt time, not at the stamp's time.
    const pull1 = await call("/api/sync", { token: token3, body: { deviceId: "sync119-b", sinceSeq: 0, since: 0, software: SOFTWARE, changes: [] } });
    expect(pull1.status).toBe(200);
    const cursor = pull1.json.serverSeq;
    expect(cursor).toBeGreaterThan(0);
    const oldStamp = Date.now() - 3600 * 1000;
    const push = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", sinceSeq: 0, since: 0, software: SOFTWARE,
        changes: [{ type: "order", id: "ord-old", payload: { code: "LD-1-1003", total: 99 }, updatedAt: oldStamp }],
      },
    });
    expect(push.status).toBe(200);
    const pull2 = await call("/api/sync", { token: token3, body: { deviceId: "sync119-b", sinceSeq: cursor, since: Date.now(), software: SOFTWARE, changes: [] } });
    expect(pull2.status).toBe(200);
    const ord = pull2.json.changes.find((c: any) => c.type === "order" && c.id === "ord-old");
    expect(ord).toBeDefined();
    expect(ord.payload.total).toBe(99);
    expect(ord.seq).toBeGreaterThan(cursor);
  });

  test("wrong clock: a change stamped 2 hours ahead is clamped to server time", async () => {
    const future = Date.now() + 2 * 3600 * 1000;
    const push = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", since: 0, software: SOFTWARE,
        changes: [{ type: "order", id: "ord-clock", payload: { code: "LD-1-1002", total: 260 }, updatedAt: future }],
      },
    });
    expect(push.status).toBe(200);
    const stored = push.json.stored.find((s: any) => s.id === "ord-clock");
    expect(stored).toBeDefined();
    // Stored at server time, not the future stamp — and inside a few
    // seconds of now (the clamp), never the +2h value.
    expect(stored.updatedAt).toBeLessThan(future - 3600 * 1000);
    expect(Math.abs(stored.updatedAt - Date.now())).toBeLessThan(10_000);
    const pull = await call("/api/sync", { token: token3, body: { deviceId: "sync119-b", since: 0, software: SOFTWARE, changes: [] } });
    const ord = pull.json.changes.find((c: any) => c.type === "order" && c.id === "ord-clock");
    expect(ord.updatedAt).toBe(stored.updatedAt);
    expect(ord.payload.total).toBe(260);
  });

  test("delete-forever tombstone travels: the bill disappears on the other phones", async () => {
    const now = Date.now();
    const push = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-a", since: 0, software: SOFTWARE,
        changes: [{ type: "order", id: "ord-119", payload: { syncId: "ord-119", deleted: true, updatedAt: now }, deleted: true, updatedAt: now }],
      },
    });
    expect(push.status).toBe(200);
    const pull = await call("/api/sync", { token: token3, body: { deviceId: "sync119-b", since: 0, software: SOFTWARE, changes: [] } });
    const ord = pull.json.changes.find((c: any) => c.type === "order" && c.id === "ord-119");
    expect(ord).toBeDefined();
    expect(ord.deleted).toBe(true);
  });

  test("shop isolation: another shop's phone sees none of this shop's bills", async () => {
    const r = await call("/api/shops", {
      token: ceoToken,
      body: { name: "Test Other House", software: "laundry", ownerName: "Test Owner", phone: "9000000006", city: "Pune", status: "active" },
    });
    expect(r.status).toBe(200);
    const otherToken = await shopToken(r.json.id);
    const reg = await call("/api/devices/register", { token: otherToken, body: { deviceId: "other-dev-1", deviceName: "Other Phone", software: SOFTWARE } });
    expect(reg.status).toBe(200);
    const pull = await call("/api/sync", { token: otherToken, body: { deviceId: "other-dev-1", since: 0, software: SOFTWARE, changes: [] } });
    expect(pull.status).toBe(200);
    expect(pull.json.changes).toEqual([]);
  });

  test("revoked phone's sync is refused, the others keep syncing", async () => {
    const rev = await call("/api/devices/sync119-c/revoke", { token: token3, body: { callerDeviceId: "sync119-a" } });
    expect(rev.status).toBe(200);
    expect(rev.json.revoked).toBe(true);
    const refused = await call("/api/sync", { token: token3, body: { deviceId: "sync119-c", since: 0, software: SOFTWARE, changes: [] } });
    expect(refused.status).toBe(403);
    expect(refused.json.revoked).toBe(true);
    const ok = await call("/api/sync", { token: token3, body: { deviceId: "sync119-b", since: 0, software: SOFTWARE, changes: [] } });
    expect(ok.status).toBe(200);
    // A secondary cannot revoke, and the main can never be removed.
    const no = await call("/api/devices/sync119-a/revoke", { token: token3, body: { callerDeviceId: "sync119-b" } });
    expect(no.status).toBe(403);
    // Removing the main is refused too (400 = a request that is never
    // allowed; the message says to assign a new main first).
    const never = await call("/api/devices/sync119-a/revoke", { token: token3, body: { callerDeviceId: "sync119-a" } });
    expect(never.status).toBe(400);
  });

  test("scalable push (2026-11-21): 500 changes in one sync all store, older re-push is skipped", async () => {
    const base = Date.now() - 60_000;
    const changes = Array.from({ length: 500 }, (_, i) => ({
      type: "order",
      id: `scale-${i}`,
      payload: { code: `LD-S-${i}`, total: i },
      updatedAt: base + i * 10,
    }));
    const t0 = Date.now();
    const push = await call("/api/sync", {
      token: token3,
      body: { deviceId: "sync119-b", since: 0, software: SOFTWARE, changes },
    });
    const elapsed = Date.now() - t0;
    expect(push.status).toBe(200);
    expect(push.json.stored.length).toBe(500);
    expect(push.json.serverSeq).toBe(push.json.stored[499].seq);
    // Batched push must stay well under the old per-change cost.
    expect(elapsed).toBeLessThan(10_000);
    // Re-pushing the same 500 with older stamps stores nothing
    // (last-write-wins unchanged by batching).
    const again = await call("/api/sync", {
      token: token3,
      body: {
        deviceId: "sync119-b", since: 0, software: SOFTWARE,
        changes: changes.map((c) => ({ ...c, updatedAt: c.updatedAt - 1000 })),
      },
    });
    expect(again.status).toBe(200);
    expect(again.json.stored.length).toBe(0);
    // A fresh pull by seq sees all 500 scale bills exactly once.
    const pull = await call("/api/sync", {
      token: token3,
      body: { deviceId: "sync119-b", sinceSeq: 0, since: 0, software: SOFTWARE, changes: [] },
    });
    expect(pull.status).toBe(200);
    const scale = pull.json.changes.filter((c: any) => c.type === "order" && String(c.id).startsWith("scale-"));
    expect(scale.length).toBe(500);
  });
});
