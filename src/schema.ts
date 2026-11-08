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
