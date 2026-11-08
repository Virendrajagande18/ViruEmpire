// Viru Empire CEO Panel — actions.
//
// Auth: one CEO account (username + salted SHA-256 password hash) created
// on first run via setupAccount. login() issues an opaque session token;
// every data action takes that token and rejects unknown ones. Demo data
// is seeded once (seedIfEmpty) so the dashboard opens alive; every row is
// a normal row the CEO can edit or delete.

import { defineAction, z, type ActionsModule, type Ctx } from "./sdk-shim.ts";
import { privileged } from "./privileged.ts";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- helpers ----------

async function hashPassword(ctx: Ctx, password: string, salt: string): Promise<string> {
  const { hash } = await ctx.executePrivileged(privileged.hashPassword, { password, salt });
  return hash;
}

async function requireSession(ctx: Ctx, token: string): Promise<string> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.token, token))
    .limit(1);
  const session = rows[0];
  if (!session) throw new Error("UNAUTHORIZED");
  return session.username;
}

function dateFromDay(day: string | null | undefined): Date | null {
  if (!day) return null;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayString(d: Date | null): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function genKeyCode(ctx: Ctx): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const { values } = await ctx.executePrivileged(privileged.randomValues, { count: 12 });
  const block = (offset: number) => {
    let out = "";
    for (let i = 0; i < 4; i++) out += alphabet[(values[offset + i] ?? 0) % alphabet.length];
    return out;
  };
  return `VIRU-${block(0)}-${block(4)}-${block(8)}`;
}

function maskKeyCode(code: string): string {
  const parts = code.split("-");
  if (parts.length < 2) return code;
  return parts
    .map((part, i) => (i === 0 || i === parts.length - 1 ? part : "••••"))
    .join("-");
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- seed (runs once, only when every table is empty) ----------

async function seedIfEmpty(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select({ id: schema.shops.id }).from(schema.shops).limit(1);
  if (existing.length > 0) return;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const shopSeed: Array<{
    name: string; ownerName: string; phone: string; city: string;
    software: string; status: "active" | "trial" | "suspended" | "closed";
    notes: string; joinedDaysAgo: number;
  }> = [
    { name: "FreshWash Laundry", ownerName: "Ramesh Patil", phone: "98220 41107", city: "Pune", software: "Laundry Management System", status: "active", notes: "First shop onboarded. WhatsApp billing enabled.", joinedDaysAgo: 168 },
    { name: "Sparkle Clean Hub", ownerName: "Sneha Kulkarni", phone: "98901 22345", city: "Nashik", software: "Laundry Management System", status: "active", notes: "Two counters running on one licence.", joinedDaysAgo: 141 },
    { name: "Shree Balaji Oil Agency", ownerName: "Suresh Pawar", phone: "97300 88112", city: "Ahmednagar", software: "Oil Dealership Software", status: "active", notes: "Tracks tanker stock, dealer billing and credit ledger.", joinedDaysAgo: 118 },
    { name: "Sujit Shinde — LIC & Star Health Office", ownerName: "Sujit Shinde", phone: "98225 67431", city: "Pune", software: "LIC & Star Health Office System", status: "active", notes: "Policy renewals and client records for the office.", joinedDaysAgo: 96 },
    { name: "Royal Fataka Stall", ownerName: "Vikram Jadhav", phone: "96571 30984", city: "Pune", software: "Fataka Stall Website", status: "trial", notes: "Seasonal stall site — trial before Diwali season rush.", joinedDaysAgo: 12 },
    { name: "QuickWash Express", ownerName: "Pooja Mane", phone: "98909 45120", city: "Ahmednagar", software: "Laundry Management System", status: "suspended", notes: "Payment overdue — licence paused until cleared.", joinedDaysAgo: 74 },
  ];

  const shopIds: number[] = [];
  for (const s of shopSeed) {
    const joined = new Date(now - s.joinedDaysAgo * day);
    const [row] = await db
      .insert(schema.shops)
      .values({
        name: s.name, ownerName: s.ownerName, phone: s.phone, city: s.city,
        software: s.software, status: s.status, notes: s.notes,
        joinedAt: joined, createdAt: joined,
      })
      .returning({ id: schema.shops.id });
    if (row) shopIds.push(row.id);
  }

  const keySeed: Array<{
    shop: number; plan: "monthly" | "quarterly" | "yearly" | "lifetime";
    status: "unused" | "active" | "expired" | "revoked";
    expiresInDays: number | null; createdDaysAgo: number;
  }> = [
    { shop: 0, plan: "yearly", status: "active", expiresInDays: 197, createdDaysAgo: 168 },
    { shop: 1, plan: "yearly", status: "active", expiresInDays: 224, createdDaysAgo: 141 },
    { shop: 2, plan: "yearly", status: "active", expiresInDays: 247, createdDaysAgo: 118 },
    { shop: 3, plan: "monthly", status: "active", expiresInDays: 18, createdDaysAgo: 12 },
    { shop: 4, plan: "yearly", status: "active", expiresInDays: 269, createdDaysAgo: 96 },
    { shop: 5, plan: "quarterly", status: "expired", expiresInDays: -9, createdDaysAgo: 83 },
    { shop: 1, plan: "monthly", status: "active", expiresInDays: 9, createdDaysAgo: 21 },
    { shop: -1, plan: "yearly", status: "unused", expiresInDays: null, createdDaysAgo: 3 },
    { shop: -1, plan: "lifetime", status: "unused", expiresInDays: null, createdDaysAgo: 3 },
    { shop: 0, plan: "monthly", status: "revoked", expiresInDays: 40, createdDaysAgo: 60 },
  ];
  for (const k of keySeed) {
    const created = new Date(now - k.createdDaysAgo * day);
    await db.insert(schema.licenseKeys).values({
      keyCode: await genKeyCode(ctx),
      shopId: k.shop >= 0 ? (shopIds[k.shop] ?? null) : null,
      plan: k.plan,
      status: k.status,
      expiresAt: k.expiresInDays === null ? null : new Date(now + k.expiresInDays * day),
      createdAt: created,
    });
  }

  const paySeed: Array<{
    shop: number; amount: number;
    method: "upi" | "cash" | "card" | "bank" | "other";
    status: "received" | "pending" | "failed" | "refunded";
    note: string; daysAgo: number;
  }> = [
    { shop: 0, amount: 11999, method: "upi", status: "received", note: "Yearly licence — Laundry Management System", daysAgo: 168 },
    { shop: 1, amount: 11999, method: "bank", status: "received", note: "Yearly licence — Laundry Management System", daysAgo: 141 },
    { shop: 2, amount: 17999, method: "upi", status: "received", note: "Yearly licence — Oil Dealership Software", daysAgo: 118 },
    { shop: 3, amount: 14999, method: "card", status: "received", note: "Yearly licence — LIC & Star Health Office System", daysAgo: 96 },
    { shop: 5, amount: 3499, method: "upi", status: "received", note: "Quarterly licence — Laundry Management System", daysAgo: 83 },
    { shop: 1, amount: 1499, method: "upi", status: "received", note: "Extra counter add-on", daysAgo: 47 },
    { shop: 0, amount: 2499, method: "upi", status: "received", note: "WhatsApp billing add-on", daysAgo: 33 },
    { shop: 2, amount: 2999, method: "card", status: "received", note: "Credit-ledger module add-on", daysAgo: 21 },
    { shop: 1, amount: 1499, method: "upi", status: "received", note: "Monthly licence — second counter", daysAgo: 21 },
    { shop: 4, amount: 4999, method: "upi", status: "pending", note: "Fataka Stall Website — season package", daysAgo: 2 },
    { shop: 5, amount: 3499, method: "upi", status: "pending", note: "Quarterly renewal — overdue", daysAgo: 9 },
    { shop: 3, amount: 3999, method: "bank", status: "pending", note: "Renewal-reminder add-on — invoice sent", daysAgo: 4 },
  ];
  for (const p of paySeed) {
    const when = new Date(now - p.daysAgo * day);
    await db.insert(schema.payments).values({
      shopId: p.shop >= 0 ? (shopIds[p.shop] ?? null) : null,
      amountInr: p.amount, method: p.method, status: p.status,
      note: p.note, paidAt: when, createdAt: when,
    });
  }
}

// ---------- shared row shapes ----------

const shopShape = z.object({
  id: z.number(),
  name: z.string(),
  ownerName: z.string(),
  phone: z.string(),
  city: z.string(),
  software: z.string(),
  status: z.string(),
  notes: z.string(),
  joinedAt: z.string(),
  keyCount: z.number(),
  totalPaidInr: z.number(),
});

const keyShape = z.object({
  id: z.number(),
  keyMasked: z.string(),
  shopId: z.number().nullable(),
  shopName: z.string().nullable(),
  software: z.string().nullable(),
  plan: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const paymentShape = z.object({
  id: z.number(),
  shopId: z.number().nullable(),
  shopName: z.string().nullable(),
  software: z.string().nullable(),
  amountInr: z.number(),
  method: z.string(),
  status: z.string(),
  note: z.string(),
  paidAt: z.string(),
});

const tokenReq = { token: z.string().min(1) };

const exportShopShape = z.object({
  id: z.number(),
  name: z.string(),
  ownerName: z.string(),
  phone: z.string(),
  city: z.string(),
  software: z.string(),
  status: z.string(),
  notes: z.string(),
  joinedAt: z.string(),
  createdAt: z.string(),
});

const exportKeyShape = z.object({
  id: z.number(),
  keyCode: z.string(),
  shopId: z.number().nullable(),
  shopName: z.string().nullable(),
  software: z.string().nullable(),
  plan: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const exportPaymentShape = z.object({
  id: z.number(),
  shopId: z.number().nullable(),
  shopName: z.string().nullable(),
  software: z.string().nullable(),
  amountInr: z.number(),
  method: z.string(),
  status: z.string(),
  note: z.string(),
  paidAt: z.string(),
  createdAt: z.string(),
});

function isoString(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

// ---------- actions ----------

export const Actions = {
  getAuthStatus: defineAction({
    description: "Reports whether the CEO account has been created yet, for the login screen.",
    request: z.object({}),
    response: z.object({ hasAccount: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ id: schema.adminAccount.id }).from(schema.adminAccount).limit(1);
      return { hasAccount: rows.length > 0 };
    },
  }),

  setupAccount: defineAction({
    description: "Creates the single CEO login account on first run and returns a session token.",
    request: z.object({
      username: z.string().trim().min(3).max(40),
      password: z.string().min(6).max(100),
    }),
    response: z.object({ token: z.string(), username: z.string() }),
    privileged: [privileged.newSalt, privileged.hashPassword, privileged.newToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ id: schema.adminAccount.id }).from(schema.adminAccount).limit(1);
      if (rows.length > 0) throw new Error("Account already exists — please log in.");
      const { salt } = await ctx.executePrivileged(privileged.newSalt, {});
      await db.insert(schema.adminAccount).values({
        username: args.username,
        passwordHash: await hashPassword(ctx, args.password, salt),
        salt,
      });
      const { token } = await ctx.executePrivileged(privileged.newToken, {});
      await db.insert(schema.sessions).values({ token, username: args.username });
      return { token, username: args.username };
    },
  }),

  login: defineAction({
    description: "Verifies the CEO username and password and returns a session token.",
    request: z.object({
      username: z.string().trim().min(1).max(40),
      password: z.string().min(1).max(100),
    }),
    response: z.object({ token: z.string(), username: z.string() }),
    privileged: [privileged.hashPassword, privileged.secureEqual, privileged.newToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.adminAccount)
        .where(eq(schema.adminAccount.username, args.username))
        .limit(1);
      const account = rows[0];
      if (!account) throw new Error("Invalid username or password.");
      const candidate = await hashPassword(ctx, args.password, account.salt);
      const { equal } = await ctx.executePrivileged(privileged.secureEqual, {
        a: candidate,
        b: account.passwordHash,
      });
      if (!equal) throw new Error("Invalid username or password.");
      const { token } = await ctx.executePrivileged(privileged.newToken, {});
      await db.insert(schema.sessions).values({ token, username: account.username });
      return { token, username: account.username };
    },
  }),

  logout: defineAction({
    description: "Ends the CEO session for the given token.",
    request: z.object({ token: z.string() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.sessions).where(eq(schema.sessions.token, args.token));
      return { ok: true };
    },
  }),

  changePassword: defineAction({
    description: "Changes the CEO login password. Verifies the current password first, then signs out every other session.",
    request: z.object({
      token: z.string().min(1),
      currentPassword: z.string().min(1).max(100),
      newPassword: z.string().min(6).max(100),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.newSalt, privileged.hashPassword, privileged.secureEqual],
    async handler(ctx, args): Promise<{ ok: true }> {
      const username = await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.adminAccount)
        .where(eq(schema.adminAccount.username, username))
        .limit(1);
      const account = rows[0];
      if (!account) throw new Error("Account not found.");
      const candidate = await hashPassword(ctx, args.currentPassword, account.salt);
      const { equal } = await ctx.executePrivileged(privileged.secureEqual, {
        a: candidate,
        b: account.passwordHash,
      });
      if (!equal) throw new Error("Current password is wrong.");
      const { salt } = await ctx.executePrivileged(privileged.newSalt, {});
      await db
        .update(schema.adminAccount)
        .set({ passwordHash: await hashPassword(ctx, args.newPassword, salt), salt })
        .where(eq(schema.adminAccount.id, account.id));
      // Every other session is signed out; this session keeps working.
      const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.username, username));
      for (const s of sessions) {
        if (s.token !== args.token) {
          await db.delete(schema.sessions).where(eq(schema.sessions.token, s.token));
        }
      }
      return { ok: true };
    },
  }),

  getMe: defineAction({
    description: "Validates a session token and returns the logged-in CEO username.",
    request: z.object({ token: z.string() }),
    response: z.object({ username: z.string() }),
    async handler(ctx, args) {
      const username = await requireSession(ctx, args.token);
      return { username };
    },
  }),

  getDashboard: defineAction({
    description: "Returns KPIs, revenue series and breakdowns for the CEO overview and analytics views.",
    request: z.object({ ...tokenReq, months: z.number().int().min(3).max(24).default(6) }),
    response: z.object({
      kpis: z.object({
        totalRevenueInr: z.number(),
        revenueThisMonthInr: z.number(),
        activeShops: z.number(),
        totalShops: z.number(),
        liveKeys: z.number(),
        totalKeys: z.number(),
        expiringSoon: z.number(),
        pendingAmountInr: z.number(),
        pendingCount: z.number(),
      }),
      revenueSeries: z.array(z.object({ month: z.string(), revenueInr: z.number(), payments: z.number() })),
      methodBreakdown: z.array(z.object({ method: z.string(), amountInr: z.number(), count: z.number() })),
      planBreakdown: z.array(z.object({ plan: z.string(), count: z.number() })),
      softwareBreakdown: z.array(z.object({ software: z.string(), count: z.number() })),
      productSummaries: z.array(z.object({
        software: z.string(),
        shops: z.number(),
        liveKeys: z.number(),
        expiringSoon: z.number(),
        revenueInr: z.number(),
      })),
      recentPayments: z.array(paymentShape),
      expiringKeys: z.array(keyShape),
      recentShops: z.array(shopShape),
    }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      await seedIfEmpty(ctx);
      const db = ctx.db<typeof schema>();
      const [shopRows, keyRows, payRows] = await Promise.all([
        db.select().from(schema.shops).orderBy(desc(schema.shops.id)),
        db.select().from(schema.licenseKeys).orderBy(desc(schema.licenseKeys.id)),
        db.select().from(schema.payments).orderBy(desc(schema.payments.paidAt)),
      ]);

      const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
      const shopSoftware = new Map(shopRows.map((s) => [s.id, s.software]));
      const now = new Date();
      const received = payRows.filter((p) => p.status === "received");
      const totalRevenueInr = received.reduce((sum, p) => sum + p.amountInr, 0);
      const revenueThisMonthInr = received
        .filter((p) => p.paidAt.getFullYear() === now.getFullYear() && p.paidAt.getMonth() === now.getMonth())
        .reduce((sum, p) => sum + p.amountInr, 0);
      const pending = payRows.filter((p) => p.status === "pending");
      const expiringSoon = keyRows.filter(
        (k) => k.status === "active" && k.expiresAt !== null &&
          k.expiresAt.getTime() >= now.getTime() &&
          k.expiresAt.getTime() - now.getTime() <= THIRTY_DAYS_MS,
      ).length;

      // Monthly revenue series, oldest → newest, zero-filled.
      const seriesMap = new Map<string, { revenueInr: number; payments: number; label: string }>();
      const labels: string[] = [];
      for (let i = args.months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const label = d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
        seriesMap.set(key, { revenueInr: 0, payments: 0, label });
        labels.push(key);
      }
      for (const p of received) {
        const key = `${p.paidAt.getFullYear()}-${p.paidAt.getMonth()}`;
        const bucket = seriesMap.get(key);
        if (bucket) {
          bucket.revenueInr += p.amountInr;
          bucket.payments += 1;
        }
      }
      const revenueSeries = labels.map((key) => {
        const b = seriesMap.get(key) ?? { revenueInr: 0, payments: 0, label: key };
        return { month: b.label, revenueInr: b.revenueInr, payments: b.payments };
      });

      const methodMap = new Map<string, { amountInr: number; count: number }>();
      for (const p of received) {
        const cur = methodMap.get(p.method) ?? { amountInr: 0, count: 0 };
        cur.amountInr += p.amountInr;
        cur.count += 1;
        methodMap.set(p.method, cur);
      }
      const methodBreakdown = [...methodMap.entries()].map(([method, v]) => ({ method, ...v }));

      const planMap = new Map<string, number>();
      for (const k of keyRows) planMap.set(k.plan, (planMap.get(k.plan) ?? 0) + 1);
      const planBreakdown = [...planMap.entries()].map(([plan, count]) => ({ plan, count }));

      const swMap = new Map<string, number>();
      for (const s of shopRows) {
        const sw = s.software.trim() || "Unspecified";
        swMap.set(sw, (swMap.get(sw) ?? 0) + 1);
      }
      const softwareBreakdown = [...swMap.entries()].map(([software, count]) => ({ software, count }));

      const toPayment = (p: (typeof payRows)[number]) => ({
        id: p.id,
        shopId: p.shopId,
        shopName: p.shopId !== null ? (shopName.get(p.shopId) ?? null) : null,
        software: p.shopId !== null ? (shopSoftware.get(p.shopId) ?? null) : null,
        amountInr: p.amountInr,
        method: p.method,
        status: p.status,
        note: p.note,
        paidAt: dayString(p.paidAt) ?? "",
      });
      const toKey = (k: (typeof keyRows)[number]) => ({
        id: k.id,
        keyMasked: maskKeyCode(k.keyCode),
        shopId: k.shopId,
        shopName: k.shopId !== null ? (shopName.get(k.shopId) ?? null) : null,
        software: k.shopId !== null ? (shopSoftware.get(k.shopId) ?? null) : null,
        plan: k.plan,
        status: k.status,
        expiresAt: dayString(k.expiresAt),
        createdAt: dayString(k.createdAt) ?? "",
      });
      const paidByShop = new Map<number, number>();
      for (const p of received) {
        if (p.shopId !== null) paidByShop.set(p.shopId, (paidByShop.get(p.shopId) ?? 0) + p.amountInr);
      }
      const keysByShop = new Map<number, number>();
      for (const k of keyRows) {
        if (k.shopId !== null) keysByShop.set(k.shopId, (keysByShop.get(k.shopId) ?? 0) + 1);
      }
      const toShop = (s: (typeof shopRows)[number]) => ({
        id: s.id,
        name: s.name,
        ownerName: s.ownerName,
        phone: s.phone,
        city: s.city,
        software: s.software,
        status: s.status,
        notes: s.notes,
        joinedAt: dayString(s.joinedAt) ?? "",
        keyCount: keysByShop.get(s.id) ?? 0,
        totalPaidInr: paidByShop.get(s.id) ?? 0,
      });

      return {
        kpis: {
          totalRevenueInr,
          revenueThisMonthInr,
          activeShops: shopRows.filter((s) => s.status === "active").length,
          totalShops: shopRows.length,
          liveKeys: keyRows.filter((k) => k.status === "active").length,
          totalKeys: keyRows.length,
          expiringSoon,
          pendingAmountInr: pending.reduce((sum, p) => sum + p.amountInr, 0),
          pendingCount: pending.length,
        },
        revenueSeries,
        methodBreakdown,
        planBreakdown,
        softwareBreakdown,
        productSummaries: softwareBreakdown.map((sw) => {
          const productShops = shopRows.filter((s) => (s.software.trim() || "Unspecified") === sw.software);
          const ids = new Set(productShops.map((s) => s.id));
          const productKeys = keyRows.filter((k) => k.shopId !== null && ids.has(k.shopId));
          return {
            software: sw.software,
            shops: productShops.length,
            liveKeys: productKeys.filter((k) => k.status === "active").length,
            expiringSoon: productKeys.filter(
              (k) => k.status === "active" && k.expiresAt !== null &&
                k.expiresAt.getTime() >= now.getTime() &&
                k.expiresAt.getTime() - now.getTime() <= THIRTY_DAYS_MS,
            ).length,
            revenueInr: received
              .filter((p) => p.shopId !== null && ids.has(p.shopId))
              .reduce((sum, p) => sum + p.amountInr, 0),
          };
        }),
        recentPayments: payRows.slice(0, 5).map(toPayment),
        expiringKeys: keyRows
          .filter((k) => k.status === "active" && k.expiresAt !== null)
          .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
          .slice(0, 5)
          .map(toKey),
        recentShops: shopRows.slice(0, 5).map(toShop),
      };
    },
  }),

  listShops: defineAction({
    description: "Lists shops, optionally filtered by a search term and status.",
    request: z.object({
      ...tokenReq,
      search: z.string().max(100).default(""),
      status: z.string().max(20).default("all"),
    }),
    response: z.object({ shops: z.array(shopShape) }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      await seedIfEmpty(ctx);
      const db = ctx.db<typeof schema>();
      const [shopRows, keyRows, payRows] = await Promise.all([
        db.select().from(schema.shops).orderBy(desc(schema.shops.id)),
        db.select().from(schema.licenseKeys),
        db.select().from(schema.payments),
      ]);
      const q = args.search.trim().toLowerCase();
      const filtered = shopRows.filter((s) => {
        if (args.status !== "all" && s.status !== args.status) return false;
        if (!q) return true;
        return [s.name, s.ownerName, s.city, s.software, s.phone]
          .some((f) => f.toLowerCase().includes(q));
      });
      const paidByShop = new Map<number, number>();
      for (const p of payRows) {
        if (p.status === "received" && p.shopId !== null) {
          paidByShop.set(p.shopId, (paidByShop.get(p.shopId) ?? 0) + p.amountInr);
        }
      }
      const keysByShop = new Map<number, number>();
      for (const k of keyRows) {
        if (k.shopId !== null) keysByShop.set(k.shopId, (keysByShop.get(k.shopId) ?? 0) + 1);
      }
      return {
        shops: filtered.map((s) => ({
          id: s.id, name: s.name, ownerName: s.ownerName, phone: s.phone,
          city: s.city, software: s.software, status: s.status, notes: s.notes,
          joinedAt: dayString(s.joinedAt) ?? "",
          keyCount: keysByShop.get(s.id) ?? 0,
          totalPaidInr: paidByShop.get(s.id) ?? 0,
        })),
      };
    },
  }),

  createShop: defineAction({
    description: "Adds a new shop running Viru Empire software.",
    request: z.object({
      ...tokenReq,
      name: z.string().trim().min(1).max(120),
      ownerName: z.string().trim().max(80).default(""),
      phone: z.string().trim().max(30).default(""),
      city: z.string().trim().max(60).default(""),
      software: z.string().trim().max(80).default(""),
      status: z.enum(["active", "trial", "suspended", "closed"]).default("active"),
      notes: z.string().trim().max(500).default(""),
      joinedAt: z.string().max(10).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const [row] = await db
        .insert(schema.shops)
        .values({
          name: args.name, ownerName: args.ownerName, phone: args.phone,
          city: args.city, software: args.software, status: args.status,
          notes: args.notes,
          joinedAt: dateFromDay(args.joinedAt) ?? new Date(),
        })
        .returning({ id: schema.shops.id });
      if (!row) throw new Error("Could not add the shop.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateShop: defineAction({
    description: "Edits an existing shop's details or status.",
    request: z.object({
      ...tokenReq,
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(120),
      ownerName: z.string().trim().max(80).default(""),
      phone: z.string().trim().max(30).default(""),
      city: z.string().trim().max(60).default(""),
      software: z.string().trim().max(80).default(""),
      status: z.enum(["active", "trial", "suspended", "closed"]),
      notes: z.string().trim().max(500).default(""),
      joinedAt: z.string().max(10).default(""),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shops)
        .set({
          name: args.name, ownerName: args.ownerName, phone: args.phone,
          city: args.city, software: args.software, status: args.status,
          notes: args.notes,
          joinedAt: dateFromDay(args.joinedAt) ?? new Date(),
        })
        .where(eq(schema.shops.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteShop: defineAction({
    description: "Deletes a shop and unlinks its licence keys and payments.",
    request: z.object({ ...tokenReq, id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db.update(schema.licenseKeys).set({ shopId: null }).where(eq(schema.licenseKeys.shopId, args.id));
      await db.update(schema.payments).set({ shopId: null }).where(eq(schema.payments.shopId, args.id));
      await db.delete(schema.shops).where(eq(schema.shops.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setShopEnabled: defineAction({
    description: "Turns a shop's software off or on. Switching off suspends the shop and revokes its active licence keys at once; switching on re-activates the shop (keys are re-activated one by one from Licence Keys).",
    request: z.object({ ...tokenReq, id: z.number().int().positive(), enabled: z.boolean() }),
    response: z.object({ ok: z.literal(true), keysRevoked: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; keysRevoked: number }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      let keysRevoked = 0;
      if (!args.enabled) {
        await db
          .update(schema.shops)
          .set({ status: "suspended" })
          .where(eq(schema.shops.id, args.id));
        const active = await db
          .select({ id: schema.licenseKeys.id })
          .from(schema.licenseKeys)
          .where(eq(schema.licenseKeys.shopId, args.id));
        for (const k of active) {
          const row = await db
            .select({ status: schema.licenseKeys.status })
            .from(schema.licenseKeys)
            .where(eq(schema.licenseKeys.id, k.id))
            .limit(1);
          if (row[0]?.status === "active") {
            await db
              .update(schema.licenseKeys)
              .set({ status: "revoked" })
              .where(eq(schema.licenseKeys.id, k.id));
            keysRevoked += 1;
          }
        }
      } else {
        await db
          .update(schema.shops)
          .set({ status: "active" })
          .where(eq(schema.shops.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true, keysRevoked };
    },
  }),

  listKeys: defineAction({
    description: "Lists licence keys, optionally filtered by search term, status and shop.",
    request: z.object({
      ...tokenReq,
      search: z.string().max(100).default(""),
      status: z.string().max(20).default("all"),
      shopId: z.number().int().default(0),
    }),
    response: z.object({ keys: z.array(keyShape) }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      await seedIfEmpty(ctx);
      const db = ctx.db<typeof schema>();
      const [keyRows, shopRows] = await Promise.all([
        db.select().from(schema.licenseKeys).orderBy(desc(schema.licenseKeys.id)),
        db.select().from(schema.shops),
      ]);
      const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
      const shopSoftware = new Map(shopRows.map((s) => [s.id, s.software]));
      const q = args.search.trim().toLowerCase();
      const filtered = keyRows.filter((k) => {
        if (args.status !== "all" && k.status !== args.status) return false;
        if (args.shopId > 0 && k.shopId !== args.shopId) return false;
        if (!q) return true;
        const name = k.shopId !== null ? (shopName.get(k.shopId) ?? "") : "";
        return k.keyCode.toLowerCase().includes(q) || name.toLowerCase().includes(q);
      });
      return {
        keys: filtered.map((k) => ({
          id: k.id, keyMasked: maskKeyCode(k.keyCode), shopId: k.shopId,
          shopName: k.shopId !== null ? (shopName.get(k.shopId) ?? null) : null,
          software: k.shopId !== null ? (shopSoftware.get(k.shopId) ?? null) : null,
          plan: k.plan, status: k.status,
          expiresAt: dayString(k.expiresAt),
          createdAt: dayString(k.createdAt) ?? "",
        })),
      };
    },
  }),

  generateKey: defineAction({
    description: "Generates a new VIRU licence key, optionally assigned to a shop with a plan and expiry.",
    request: z.object({
      ...tokenReq,
      shopId: z.number().int().default(0),
      plan: z.enum(["monthly", "quarterly", "yearly", "lifetime"]).default("yearly"),
      status: z.enum(["unused", "active"]).default("unused"),
      expiresAt: z.string().max(10).default(""),
    }),
    response: z.object({ id: z.number(), keyCode: z.string() }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const keyCode = await genKeyCode(ctx);
      const [row] = await db
        .insert(schema.licenseKeys)
        .values({
          keyCode,
          shopId: args.shopId > 0 ? args.shopId : null,
          plan: args.plan,
          status: args.status,
          expiresAt: args.plan === "lifetime" ? null : dateFromDay(args.expiresAt),
        })
        .returning({ id: schema.licenseKeys.id });
      if (!row) throw new Error("Could not generate the key.");
      ctx.invalidateQueries();
      return { id: row.id, keyCode };
    },
  }),

  updateKeyStatus: defineAction({
    description: "Changes a licence key's status (activate, revoke, mark expired, back to unused).",
    request: z.object({
      ...tokenReq,
      id: z.number().int().positive(),
      status: z.enum(["unused", "active", "expired", "revoked"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db.update(schema.licenseKeys).set({ status: args.status }).where(eq(schema.licenseKeys.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  revealKey: defineAction({
    description: "Returns one full licence key for an authenticated copy or reveal request; list responses only ever carry the masked form.",
    request: z.object({ ...tokenReq, id: z.number().int().positive() }),
    response: z.object({ keyCode: z.string() }),
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.licenseKeys)
        .where(eq(schema.licenseKeys.id, args.id))
        .limit(1);
      const key = rows[0];
      if (!key) throw new Error("That licence key no longer exists.");
      return { keyCode: key.keyCode };
    },
  }),

  renewKey: defineAction({
    description: "Renews a licence key in one click: extends its expiry by the plan length and reactivates it.",
    request: z.object({ ...tokenReq, id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true), expiresAt: z.string().nullable() }),
    async handler(ctx, args): Promise<{ ok: true; expiresAt: string | null }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.licenseKeys)
        .where(eq(schema.licenseKeys.id, args.id))
        .limit(1);
      const key = rows[0];
      if (!key) throw new Error("That licence key no longer exists.");
      if (key.plan === "lifetime") {
        await db
          .update(schema.licenseKeys)
          .set({ status: "active", expiresAt: null })
          .where(eq(schema.licenseKeys.id, args.id));
        ctx.invalidateQueries();
        return { ok: true, expiresAt: null };
      }
      const planDays: Record<string, number> = { monthly: 30, quarterly: 90, yearly: 365 };
      const days = planDays[key.plan] ?? 365;
      const nowMs = Date.now();
      const base = key.expiresAt && key.expiresAt.getTime() > nowMs ? key.expiresAt.getTime() : nowMs;
      const next = new Date(base + days * 24 * 60 * 60 * 1000);
      await db
        .update(schema.licenseKeys)
        .set({ status: "active", expiresAt: next })
        .where(eq(schema.licenseKeys.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, expiresAt: dayString(next) };
    },
  }),

  deleteKey: defineAction({
    description: "Deletes a licence key permanently.",
    request: z.object({ ...tokenReq, id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db.delete(schema.licenseKeys).where(eq(schema.licenseKeys.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listPayments: defineAction({
    description: "Lists payments, optionally filtered by search term, status and method.",
    request: z.object({
      ...tokenReq,
      search: z.string().max(100).default(""),
      status: z.string().max(20).default("all"),
      method: z.string().max(20).default("all"),
    }),
    response: z.object({ payments: z.array(paymentShape) }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      await seedIfEmpty(ctx);
      const db = ctx.db<typeof schema>();
      const [payRows, shopRows] = await Promise.all([
        db.select().from(schema.payments).orderBy(desc(schema.payments.paidAt)),
        db.select().from(schema.shops),
      ]);
      const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
      const shopSoftware = new Map(shopRows.map((s) => [s.id, s.software]));
      const q = args.search.trim().toLowerCase();
      const filtered = payRows.filter((p) => {
        if (args.status !== "all" && p.status !== args.status) return false;
        if (args.method !== "all" && p.method !== args.method) return false;
        if (!q) return true;
        const name = p.shopId !== null ? (shopName.get(p.shopId) ?? "") : "";
        return name.toLowerCase().includes(q) || p.note.toLowerCase().includes(q);
      });
      return {
        payments: filtered.map((p) => ({
          id: p.id, shopId: p.shopId,
          shopName: p.shopId !== null ? (shopName.get(p.shopId) ?? null) : null,
          software: p.shopId !== null ? (shopSoftware.get(p.shopId) ?? null) : null,
          amountInr: p.amountInr, method: p.method, status: p.status,
          note: p.note, paidAt: dayString(p.paidAt) ?? "",
        })),
      };
    },
  }),

  createPayment: defineAction({
    description: "Records a payment from a shop (received, pending, failed or refunded).",
    request: z.object({
      ...tokenReq,
      shopId: z.number().int().default(0),
      amountInr: z.number().int().positive().max(100000000),
      method: z.enum(["upi", "cash", "card", "bank", "other"]).default("upi"),
      status: z.enum(["received", "pending", "failed", "refunded"]).default("received"),
      note: z.string().trim().max(300).default(""),
      paidAt: z.string().max(10).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const [row] = await db
        .insert(schema.payments)
        .values({
          shopId: args.shopId > 0 ? args.shopId : null,
          amountInr: args.amountInr, method: args.method, status: args.status,
          note: args.note, paidAt: dateFromDay(args.paidAt) ?? new Date(),
        })
        .returning({ id: schema.payments.id });
      if (!row) throw new Error("Could not record the payment.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updatePaymentStatus: defineAction({
    description: "Changes a payment's status, e.g. marking a pending payment as received.",
    request: z.object({
      ...tokenReq,
      id: z.number().int().positive(),
      status: z.enum(["received", "pending", "failed", "refunded"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db.update(schema.payments).set({ status: args.status }).where(eq(schema.payments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  updatePayment: defineAction({
    description: "Edits a payment record — correct the amount, method, status, note or date.",
    request: z.object({
      ...tokenReq,
      id: z.number().int().positive(),
      shopId: z.number().int().default(0),
      amountInr: z.number().int().positive().max(100000000),
      method: z.enum(["upi", "cash", "card", "bank", "other"]).default("upi"),
      status: z.enum(["received", "pending", "failed", "refunded"]).default("received"),
      note: z.string().trim().max(300).default(""),
      paidAt: z.string().max(10).default(""),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.payments)
        .set({
          shopId: args.shopId > 0 ? args.shopId : null,
          amountInr: args.amountInr,
          method: args.method,
          status: args.status,
          note: args.note,
          paidAt: dateFromDay(args.paidAt) ?? new Date(),
        })
        .where(eq(schema.payments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  exportBackup: defineAction({
    description: "Returns a full backup of all panel data (shops, licence keys with full codes, and payments) for the logged-in CEO to download and save to Drive, PC or mobile.",
    request: z.object({ ...tokenReq }),
    response: z.object({
      exportedAt: z.string(),
      exportedBy: z.string(),
      version: z.number(),
      counts: z.object({
        shops: z.number(),
        licenseKeys: z.number(),
        payments: z.number(),
      }),
      shops: z.array(exportShopShape),
      licenseKeys: z.array(exportKeyShape),
      payments: z.array(exportPaymentShape),
    }),
    privileged: [privileged.randomValues],
    async handler(ctx, args) {
      const username = await requireSession(ctx, args.token);
      await seedIfEmpty(ctx);
      const db = ctx.db<typeof schema>();
      const [shopRows, keyRows, payRows] = await Promise.all([
        db.select().from(schema.shops).orderBy(desc(schema.shops.id)),
        db.select().from(schema.licenseKeys).orderBy(desc(schema.licenseKeys.id)),
        db.select().from(schema.payments).orderBy(desc(schema.payments.paidAt)),
      ]);
      const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
      const shopSoftware = new Map(shopRows.map((s) => [s.id, s.software]));
      return {
        exportedAt: new Date().toISOString(),
        exportedBy: username,
        version: 1,
        counts: {
          shops: shopRows.length,
          licenseKeys: keyRows.length,
          payments: payRows.length,
        },
        shops: shopRows.map((s) => ({
          id: s.id,
          name: s.name,
          ownerName: s.ownerName,
          phone: s.phone,
          city: s.city,
          software: s.software,
          status: s.status,
          notes: s.notes,
          joinedAt: isoString(s.joinedAt) ?? "",
          createdAt: isoString(s.createdAt) ?? "",
        })),
        licenseKeys: keyRows.map((k) => ({
          id: k.id,
          keyCode: k.keyCode,
          shopId: k.shopId,
          shopName: k.shopId !== null ? (shopName.get(k.shopId) ?? null) : null,
          software: k.shopId !== null ? (shopSoftware.get(k.shopId) ?? null) : null,
          plan: k.plan,
          status: k.status,
          expiresAt: isoString(k.expiresAt),
          createdAt: isoString(k.createdAt) ?? "",
        })),
        payments: payRows.map((p) => ({
          id: p.id,
          shopId: p.shopId,
          shopName: p.shopId !== null ? (shopName.get(p.shopId) ?? null) : null,
          software: p.shopId !== null ? (shopSoftware.get(p.shopId) ?? null) : null,
          amountInr: p.amountInr,
          method: p.method,
          status: p.status,
          note: p.note,
          paidAt: isoString(p.paidAt) ?? "",
          createdAt: isoString(p.createdAt) ?? "",
        })),
      };
    },
  }),

  deletePayment: defineAction({
    description: "Deletes a payment record permanently.",
    request: z.object({ ...tokenReq, id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      await db.delete(schema.payments).where(eq(schema.payments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  importBackup: defineAction({
    description: "Restores a panel backup file (the JSON from Export / Backup). Shops are matched by name + phone, keys by their code, and payments are skipped when an identical record already exists — re-importing the same backup never duplicates anything.",
    request: z.object({
      ...tokenReq,
      backup: z.object({
        version: z.number().optional(),
        shops: z.array(z.object({
          name: z.string(),
          ownerName: z.string().optional().default(""),
          phone: z.string().optional().default(""),
          city: z.string().optional().default(""),
          software: z.string().optional().default(""),
          status: z.string().optional().default("active"),
          notes: z.string().optional().default(""),
          joinedAt: z.string().optional().default(""),
          createdAt: z.string().optional().default(""),
        })).default([]),
        licenseKeys: z.array(z.object({
          keyCode: z.string(),
          shopId: z.number().nullable().optional(),
          shopName: z.string().nullable().optional(),
          plan: z.string().optional().default("yearly"),
          status: z.string().optional().default("unused"),
          expiresAt: z.string().nullable().optional(),
          createdAt: z.string().optional().default(""),
        })).default([]),
        payments: z.array(z.object({
          shopId: z.number().nullable().optional(),
          shopName: z.string().nullable().optional(),
          amountInr: z.number(),
          method: z.string().optional().default("upi"),
          status: z.string().optional().default("received"),
          note: z.string().optional().default(""),
          paidAt: z.string().optional().default(""),
          createdAt: z.string().optional().default(""),
        })).default([]),
      }),
    }),
    response: z.object({
      ok: z.literal(true),
      importedShops: z.number(),
      importedKeys: z.number(),
      importedPayments: z.number(),
      skipped: z.number(),
    }),
    async handler(ctx, args) {
      await requireSession(ctx, args.token);
      const db = ctx.db<typeof schema>();
      const b = args.backup;
      let importedShops = 0;
      let importedKeys = 0;
      let importedPayments = 0;
      let skipped = 0;

      // Shops, matched by name + phone so a re-import never duplicates.
      const shopIdByKey = new Map<string, number>();
      const existingShops = await db.select().from(schema.shops);
      for (const s of existingShops) shopIdByKey.set(`${s.name}|||${s.phone}`, s.id);
      const shopNameToId = new Map<string, number>();
      for (const s of existingShops) {
        if (!shopNameToId.has(s.name)) shopNameToId.set(s.name, s.id);
      }
      const validStatus = (v: string): "active" | "trial" | "suspended" | "closed" =>
        v === "trial" || v === "suspended" || v === "closed" ? v : "active";
      for (const s of b.shops) {
        const key = `${s.name}|||${s.phone}`;
        if (shopIdByKey.has(key)) { skipped += 1; continue; }
        const joined = s.joinedAt ? new Date(s.joinedAt) : new Date();
        const [row] = await db
          .insert(schema.shops)
          .values({
            name: s.name, ownerName: s.ownerName ?? "", phone: s.phone ?? "",
            city: s.city ?? "", software: s.software ?? "",
            status: validStatus(s.status ?? "active"), notes: s.notes ?? "",
            joinedAt: Number.isNaN(joined.getTime()) ? new Date() : joined,
          })
          .returning({ id: schema.shops.id });
        if (row) {
          shopIdByKey.set(key, row.id);
          if (!shopNameToId.has(s.name)) shopNameToId.set(s.name, row.id);
          importedShops += 1;
        }
      }

      // Keys, matched by their full code.
      const validPlan = (v: string): "monthly" | "quarterly" | "yearly" | "lifetime" =>
        v === "monthly" || v === "quarterly" || v === "lifetime" ? v : "yearly";
      const validKeyStatus = (v: string): "unused" | "active" | "expired" | "revoked" =>
        v === "active" || v === "expired" || v === "revoked" ? v : "unused";
      const existingKeys = await db.select({ keyCode: schema.licenseKeys.keyCode }).from(schema.licenseKeys);
      const knownCodes = new Set(existingKeys.map((k) => k.keyCode));
      for (const k of b.licenseKeys) {
        if (knownCodes.has(k.keyCode)) { skipped += 1; continue; }
        // The backup's shopId refers to the old database — resolve by shop name instead.
        const shopId = k.shopName ? (shopNameToId.get(k.shopName) ?? null) : null;
        const expires = k.expiresAt ? new Date(k.expiresAt) : null;
        await db.insert(schema.licenseKeys).values({
          keyCode: k.keyCode,
          shopId,
          plan: validPlan(k.plan ?? "yearly"),
          status: validKeyStatus(k.status ?? "unused"),
          expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
        });
        knownCodes.add(k.keyCode);
        importedKeys += 1;
      }

      // Payments, matched on shop + amount + method + status + note + date.
      const validMethod = (v: string): "upi" | "cash" | "card" | "bank" | "other" =>
        v === "cash" || v === "card" || v === "bank" || v === "other" ? v : "upi";
      const validPayStatus = (v: string): "received" | "pending" | "failed" | "refunded" =>
        v === "pending" || v === "failed" || v === "refunded" ? v : "received";
      const existingPays = await db.select().from(schema.payments);
      const payKey = (shopId: number | null, amount: number, method: string, status: string, note: string, paidMs: number) =>
        `${shopId ?? ""}|${amount}|${method}|${status}|${note}|${paidMs}`;
      const knownPays = new Set(
        existingPays.map((p) => payKey(p.shopId, p.amountInr, p.method, p.status, p.note, p.paidAt.getTime())),
      );
      for (const p of b.payments) {
        const shopId = p.shopName ? (shopNameToId.get(p.shopName) ?? null) : null;
        const paid = p.paidAt ? new Date(p.paidAt) : new Date();
        const paidMs = Number.isNaN(paid.getTime()) ? Date.now() : paid.getTime();
        const key = payKey(shopId, p.amountInr, validMethod(p.method ?? "upi"), validPayStatus(p.status ?? "received"), p.note ?? "", paidMs);
        if (knownPays.has(key)) { skipped += 1; continue; }
        await db.insert(schema.payments).values({
          shopId,
          amountInr: p.amountInr,
          method: validMethod(p.method ?? "upi"),
          status: validPayStatus(p.status ?? "received"),
          note: p.note ?? "",
          paidAt: new Date(paidMs),
        });
        knownPays.add(key);
        importedPayments += 1;
      }

      ctx.invalidateQueries();
      return { ok: true as const, importedShops, importedKeys, importedPayments, skipped };
    },
  }),
} satisfies ActionsModule;
