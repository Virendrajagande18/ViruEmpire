// Viru Empire CEO Panel — product registry.
//
// ONE place defines the software products this panel sells. Adding a new
// product is one entry in PRODUCTS below — no change to shops, keys,
// devices, sync, or the UI is needed:
//   1. Add the product's full name to PRODUCTS (one line).
//   2. Optionally add short aliases below (what an app might send instead
//      of the full name, e.g. "laundry").
//   3. Deploy. The client fetches the list from GET /api/products, so the
//      product dropdowns and filters pick the new product up with no
//      client rebuild.
// A shop can still carry any other software name ("Other" in the UI) —
// unknown names pass through normalizeSoftware unchanged, so custom
// software never breaks. Business logic must never hardcode a product
// list of its own; import PRODUCTS / normalizeSoftware from here.

export const PRODUCTS = [
  "Laundry Management System",
  "Oil Dealership Software",
  "LIC & Star Health Office System",
  "Fataka Stall Website",
] as const;

export type ProductName = (typeof PRODUCTS)[number];

// Short names an app (or a person typing) might send instead of the full
// product name. Keys are lowercase; values are the canonical names above.
const ALIASES: Record<string, string> = {
  laundry: "Laundry Management System",
  "laundry management": "Laundry Management System",
  "laundry management system": "Laundry Management System",
  oil: "Oil Dealership Software",
  "oil dealership": "Oil Dealership Software",
  "oil dealership software": "Oil Dealership Software",
  lic: "LIC & Star Health Office System",
  "star health": "LIC & Star Health Office System",
  "lic & star health": "LIC & Star Health Office System",
  "lic & star health office system": "LIC & Star Health Office System",
  fataka: "Fataka Stall Website",
  "fataka stall": "Fataka Stall Website",
  "fataka stall website": "Fataka Stall Website",
};

/** Canonical product name for any reasonable input, or the input trimmed
 *  when it is a custom ("Other") software name. "" stays "". */
export function normalizeSoftware(input: unknown): string {
  const v = String(input ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower]!;
  const known = PRODUCTS.find((p) => p.toLowerCase() === lower);
  if (known) return known;
  return v;
}

/** True when the name is one of the panel's products (after normalizing). */
export function isKnownSoftware(input: unknown): boolean {
  return PRODUCTS.includes(normalizeSoftware(input) as ProductName);
}

/** Short label for chips and charts ("Laundry", "Oil Dealership", ...). */
export function shortProductName(name: string): string {
  return name.replace(" System", "").replace(" Software", "");
}
