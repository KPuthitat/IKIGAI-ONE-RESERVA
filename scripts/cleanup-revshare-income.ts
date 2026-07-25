// One-off: remove the revenue-share daily income that was auto-posted into the
// WRONG branch (owner 2026-07-26). The "ส่งยอดวันนี้" flow briefly mirrored a
// partner's daily sales into the active (selling) branch's ACCOUNTA รายรับ —
// e.g. จ้อจี้'s 3,563.10 landed in HYPOPLARAEMIA's books instead of the
// partner's (ศาลาชิลล์). Those rows are tagged source='revshare'; this deletes
// them so the branch's รายรับ matches its own shift-close again.
//
// Run on the VPS, from /var/www/reserva:
//   node --import tsx scripts/cleanup-revshare-income.ts          # dry run
//   node --import tsx scripts/cleanup-revshare-income.ts --yes    # delete

import { getDb } from "../src/lib/db";

const db = getDb();

const rows = db.prepare(
  `SELECT ai.id, ai.branch_id, b.name AS branch, ai.income_date, ai.channel, ai.amount
     FROM accounta_income ai LEFT JOIN branches b ON b.id = ai.branch_id
    WHERE ai.source = 'revshare'
    ORDER BY ai.income_date, ai.id`
).all() as Array<{ id: number; branch_id: number; branch: string | null; income_date: string; channel: string | null; amount: number }>;

console.log(`source='revshare' income rows found: ${rows.length}`);
for (const r of rows) {
  console.log(`  #${r.id} · ${r.income_date} · ${r.branch ?? "?"} (branch ${r.branch_id}) · ${r.channel ?? "—"} · ${r.amount.toFixed(2)}`);
}

if (rows.length === 0) {
  console.log("\nNothing to clean up. Done.");
  process.exit(0);
}

if (!process.argv.includes("--yes")) {
  console.log("\nDRY RUN — no data changed. Re-run with --yes to delete the rows above.");
  process.exit(0);
}

const res = db.prepare("DELETE FROM accounta_income WHERE source = 'revshare'").run();
console.log(`\n✓ Deleted ${res.changes} revshare income row(s). The branch รายรับ now reflects only its own entries.`);
