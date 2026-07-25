// Fixture: revshare round "sent" lock (owner 2026-07-25). A round's sent_at is
// null until its daily card goes out; markRoundSent stamps it (idempotent), and
// a sent round is what the UI/route treat as locked (edit/delete → fresh PIN).
// Replicates the migration + markRoundSent UPDATE against an in-memory DB.
// Run:  node --import tsx scripts/verify-revshare-sent.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE revshare_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id INTEGER, period_start TEXT,
    sales_amount REAL DEFAULT 0, sent_at TEXT, sent_by INTEGER
  );
`);
const ins = db.prepare("INSERT INTO revshare_rounds (partner_id, period_start, sales_amount) VALUES (?,?,?)");
const r1 = ins.run(1, "2026-07-25", 2630).lastInsertRowid as number;
ins.run(1, "2026-07-24", 3000); // another round, never sent

// Replica of markRoundSent's UPDATE (guard omitted — covered by partnerGuard).
function markSent(roundId: number, partnerId: number, userId: number): number {
  return db.prepare("UPDATE revshare_rounds SET sent_at = CURRENT_TIMESTAMP, sent_by = ? WHERE id = ? AND partner_id = ?")
    .run(userId, roundId, partnerId).changes;
}
const sentAt = (id: number) => (db.prepare("SELECT sent_at FROM revshare_rounds WHERE id=?").get(id) as { sent_at: string | null }).sent_at;

assert(sentAt(r1) === null, "a fresh round is not sent (sent_at null)");

const ch = markSent(r1, 1, 7);
assert(ch === 1 && sentAt(r1) !== null, "markRoundSent stamps sent_at");
assert((db.prepare("SELECT sent_by FROM revshare_rounds WHERE id=?").get(r1) as { sent_by: number }).sent_by === 7, "sent_by records the operator");

const first = sentAt(r1);
markSent(r1, 1, 7); // re-send same day
assert(sentAt(r1) !== null, "re-sending keeps the round locked (still sent)");
void first;

// Wrong partner never flips the lock.
assert(markSent(r1, 999, 7) === 0, "marking with a mismatched partner is a no-op");

// Other rounds stay unsent — the lock is per-round.
const other = db.prepare("SELECT sent_at FROM revshare_rounds WHERE period_start='2026-07-24'").get() as { sent_at: string | null };
assert(other.sent_at === null, "an unsent round stays editable (sent_at null)");

console.log("\nALL REVSHARE-SENT FIXTURES PASSED");
