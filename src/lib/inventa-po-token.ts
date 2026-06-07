import { randomBytes } from "node:crypto";
import { getDb } from "./db";

// Public share token for a purchase order's supplier-facing PDF
// (owner 2026-06-08). The supplier opens the PDF via a link the owner
// forwards — no staff login, and cost prices are hidden. The token is a
// random 32-hex string stored on the order, generated lazily on first
// use so existing orders get one too.

/** Return the order's share token, creating + persisting one if absent. */
export function ensureOrderToken(orderId: number): string | null {
  const db = getDb();
  const row = db.prepare("SELECT public_token FROM inventa_orders WHERE id = ?")
    .get(orderId) as { public_token: string | null } | undefined;
  if (!row) return null;
  if (row.public_token) return row.public_token;
  const token = randomBytes(16).toString("hex");
  db.prepare("UPDATE inventa_orders SET public_token = ? WHERE id = ?").run(token, orderId);
  return token;
}

/** True iff `token` matches the order's stored share token. */
export function orderTokenValid(orderId: number, token: string | null | undefined): boolean {
  if (!token || !/^[0-9a-f]{32}$/.test(token)) return false;
  const row = getDb().prepare("SELECT public_token FROM inventa_orders WHERE id = ?")
    .get(orderId) as { public_token: string | null } | undefined;
  return !!row?.public_token && row.public_token === token;
}
