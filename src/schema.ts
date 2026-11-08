// Viru Empire CEO Panel — schema.
//
// admin_account: the single CEO login (username + salted password hash).
// sessions: opaque login tokens issued at login, checked on every
//   protected action.
// shops: businesses running Viru Empire software.
// license_keys: licence keys issued to shops, one row per key.
// payments: money received (or pending) from shops.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const adminAccount = sqliteTable("admin_account", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  username: text("username").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// activity_log: append-only record of every change the CEO makes
// (shop/key/payment changes, suspend/resume, deletes, clear-all,
// password change, imports). Clear-all keeps the log, so the wipe
// itself stays on record.
export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// shop_tokens: one token per shop, minted by the CEO via the server's
// POST /api/shop-token. The shop phone stores ONLY this token. It can
// never call /actions and the server scopes every /api/* call to its
// own shop. Revoked by deleting the row (or minting a replacement).
export const shopTokens = sqliteTable("shop_tokens", {
  token: text("token").primaryKey(),
  shopId: integer("shop_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ownerName: text("owner_name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  city: text("city").notNull().default(""),
  software: text("software").notNull().default(""),
  status: text("status", {
    enum: ["active", "trial", "suspended", "closed"],
  })
    .notNull()
    .default("active"),
  notes: text("notes").notNull().default(""),
  joinedAt: integer("joined_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const licenseKeys = sqliteTable("license_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  keyCode: text("key_code").notNull(),
  shopId: integer("shop_id"),
  plan: text("plan", {
    enum: ["monthly", "quarterly", "yearly", "lifetime"],
  })
    .notNull()
    .default("yearly"),
  status: text("status", {
    enum: ["unused", "active", "expired", "revoked"],
  })
    .notNull()
    .default("unused"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id"),
  amountInr: integer("amount_inr").notNull(),
  method: text("method", {
    enum: ["upi", "cash", "card", "bank", "other"],
  })
    .notNull()
    .default("upi"),
  status: text("status", {
    enum: ["received", "pending", "failed", "refunded"],
  })
    .notNull()
    .default("received"),
  note: text("note").notNull().default(""),
  paidAt: integer("paid_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// devices: a shop's phones/tablets, up to 3 per shop, whatever app the
// shop runs (laundry, oil, LIC office, fataka...). One shop token is
// shared by the shop's devices, so a device is told apart by its own
// device_id (a UUID the app makes at first setup and stores on the
// phone — never in a backup). The FIRST device registered for a shop is
// the main device (slot 1); it alone can remove other devices. A revoked
// device stops syncing and goes view-only. `software` records the
// shop's product on the device row (copied from the shop at registration)
// so the panel's Devices list can show which app each device runs.
export const devices = sqliteTable("devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  deviceId: text("device_id").notNull(),
  name: text("name").notNull().default(""),
  software: text("software").notNull().default(""),
  slot: integer("slot").notNull().default(1),
  isMain: integer("is_main").notNull().default(0),
  revoked: integer("revoked").notNull().default(0),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// sync_records: the shop's shared dataset, one row per entity per shop
// (the latest version — not a history). entity_type is the app's record
// kind — laundry syncs order/customer/payment/rate/setting, other apps
// sync their own kinds (policy, stock, scheme, bill, ...); entity_id is
// the app's sync_id (UUID); payload is the entity JSON; updated_at
// decides last-write-wins; deleted=1 is a tombstone so a delete
// propagates to other devices.
export const syncRecords = sqliteTable("sync_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: text("payload").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull().default(0),
  deviceId: text("device_id").notNull().default(""),
  deleted: integer("deleted").notNull().default(0),
});

// sync_meta: one row per shop. epoch is a random id made when the shop's
// first device registers; it changes only when the server database is
// wiped (redeploy). A device that sees a different epoch than the one it
// last synced with knows the server is fresh and re-pushes its full
// local dataset — that is how shop data comes back after a wipe.
export const syncMeta = sqliteTable("sync_meta", {
  shopId: integer("shop_id").primaryKey(),
  epoch: text("epoch").notNull(),
});
