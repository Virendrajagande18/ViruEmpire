// Minimal local stand-in for the Hatch space SDK, for the standalone
// (Render) build only. The space artifact itself keeps using the real SDK.
// These shims preserve the exact semantics the panel's action code relies on:
//  - defineAction returns the action definition as-is.
//  - definePrivilegedContracts tags each contract with an id so the server
//    can map a contract to its handler.
//  - definePrivilegedHandlers returns a Map<contractId, handler>.
//  - z is plain zod.

import { z } from "zod";

export { z };

export type ActionsModule = Record<string, unknown>;
export type Ctx = {
  db: () => any;
  executePrivileged: (contract: any, args: any) => Promise<any>;
  invalidateQueries: () => void;
};

export const defineAction = (spec: any) => spec;

let nextContractId = 1;

export const definePrivilegedContracts = (contracts: Record<string, any>) => {
  for (const key of Object.keys(contracts)) {
    contracts[key] = { ...contracts[key], __contractId: nextContractId++, __key: key };
  }
  return contracts;
};

export const definePrivilegedHandlers = (
  contracts: Record<string, any>,
  handlers: Record<string, (args: any) => any>,
) => {
  const map = new Map<number, (args: any) => any>();
  for (const key of Object.keys(handlers)) {
    const id = contracts[key]?.__contractId;
    if (typeof id === "number") map.set(id, handlers[key]);
  }
  return map;
};
