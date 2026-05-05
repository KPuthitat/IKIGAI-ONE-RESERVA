import { getDb } from "./db";

const DEFAULT_RETENTION_DAYS = 60;

export function purgeOldBookings(retentionDays?: number): number {
  const days = retentionDays ?? Number(process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const db = getDb();
  const info = db.prepare(
    "DELETE FROM bookings WHERE booking_date < ?"
  ).run(cutoff);
  // expired sessions
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return info.changes;
}
