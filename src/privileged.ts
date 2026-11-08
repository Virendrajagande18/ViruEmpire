// Privileged host functions for the CEO panel: all node:crypto work lives
// here (salted password hashing, session tokens, secure random values for
// licence keys) so action code never touches host modules directly.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "./sdk-shim.ts";

export const privileged = definePrivilegedContracts({
  newSalt: {
    request: z.object({}),
    response: z.object({ salt: z.string() }),
    timeoutMs: 10000,
  },
  hashPassword: {
    request: z.object({ password: z.string(), salt: z.string() }),
    response: z.object({ hash: z.string() }),
    timeoutMs: 10000,
  },
  secureEqual: {
    request: z.object({ a: z.string(), b: z.string() }),
    response: z.object({ equal: z.boolean() }),
    timeoutMs: 10000,
  },
  newToken: {
    request: z.object({}),
    response: z.object({ token: z.string() }),
    timeoutMs: 10000,
  },
  randomValues: {
    request: z.object({ count: z.number().int().min(1).max(64) }),
    response: z.object({ values: z.array(z.number()) }),
    timeoutMs: 10000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  newSalt() {
    return { salt: randomBytes(16).toString("hex") };
  },
  hashPassword(args) {
    return {
      hash: createHash("sha256").update(`${args.salt}:${args.password}`).digest("hex"),
    };
  },
  secureEqual(args) {
    const a = Buffer.from(args.a, "utf8");
    const b = Buffer.from(args.b, "utf8");
    return { equal: a.length === b.length && timingSafeEqual(a, b) };
  },
  newToken() {
    return { token: randomUUID() };
  },
  randomValues(args) {
    return { values: Array.from(randomBytes(args.count)) };
  },
});
