// Viru Empire CEO Panel — phone numbers.
//
// ONE place defines what "the same phone number" means. The phone
// number is the shop's identity (v1.1.16): owner name, shop name,
// email and address are display details only and must never decide
// which shop a phone belongs to. Mirrors the app's canonicalPhone:
// digits only, the "91" country code and a leading 0 are dropped, so
// "+91 92849 46237", "9284946237", "09284946237" and "92849 46237"
// are the same shop. "" stays "" and never matches another blank.

/** Canonical phone number for matching, or "" when there is none. */
export function canonicalPhone(phone: unknown): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d.length > 10 ? d.slice(-10) : d;
}
