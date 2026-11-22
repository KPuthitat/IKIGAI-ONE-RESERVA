// Remove the partner daily income that was mirrored into the SELLING branch's รายรับ (owner 2026-11-22):
// e.g. จ้อจี้ & friends' daily sales sitting in HYPOPLARAEMIA's ledger, although Hypo's POS sales already include
// them. Rows in the partner's own branch (e.g. ศาลาชิลล์) are left alone.
//
// Run on the VPS, from /var/www/reserva:
//   node --import tsx scripts/cleanup-revshare-seller-income.ts          # dry run (lists, changes nothing)
//   node --import tsx scripts/cleanup-revshare-seller-income.ts --yes    # delete

import { removeSellerBranchRevshareIncome } from "../src/lib/revshare-income-cleanup";

const apply = process.argv.includes("--yes");
const { rows, total } = removeSellerBranchRevshareIncome(apply);
console.log(`rows in the selling branch's รายรับ that double-count partner sales: ${rows.length} (total ${total.toFixed(2)})`);
for (const r of rows) console.log(`  #${r.id} · ${r.date} · ${r.branch ?? "?"} · ${r.channel} · ${r.amount.toFixed(2)}`);
const byMonth = new Map<string, number>();
for (const r of rows) byMonth.set(`${r.branch}|${r.date.slice(0, 7)}`, (byMonth.get(`${r.branch}|${r.date.slice(0, 7)}`) ?? 0) + r.amount);
for (const [k, v] of [...byMonth].sort()) console.log(`  per month  ${k.replace("|", " · ")}: ${v.toFixed(2)}`);
console.log(rows.length === 0 ? "\nNothing to clean up." : apply ? `\n✓ Deleted ${rows.length} row(s).` : "\nDRY RUN — nothing changed. Re-run with --yes to delete the rows above.");
