// One-off (owner 2026-08): remove leftover DEMO/test data from ONE revshare
// partner + ONE month — the daily sales rows someone imported while testing the
// GP flow (e.g. partner #1, มิ.ย. 2569, whose amounts match the sample deck in
// /admin/notifications-catalog). It ALSO removes anything those rows posted into
// ACCOUNTA รายรับ, so no branch total is left inflated:
//   • the daily gross mirrored into the partner's income branch (source='revshare')
//   • the settled GP posted on "paid"                          (source='revshare_gp')
// plus the month's settlement snapshot.
//
// Why deleting is safe for other totals:
//   - revshare_rounds feeds ONLY the revshare settlement calc — no branch daybook
//     / รายรับ reads it. Deleting rounds cannot move another branch's numbers.
//   - The only rows that touch a branch's รายรับ are the source='revshare' /
//     'revshare_gp' income rows above; this script lists and (with --apply)
//     removes exactly those, so the total returns to reflecting real entries.
//
// SAFE BY DEFAULT — dry run prints exactly what it would delete; nothing changes
// until you pass --apply. Scope is limited to ONE partner + ONE month.
//
// Run on the VPS from /var/www/reserva:
//   node --import tsx scripts/cleanup-revshare-test-data.ts                          # dry run (partner 1, 2026-06)
//   node --import tsx scripts/cleanup-revshare-test-data.ts --partner=1 --month=2026-06
//   node --import tsx scripts/cleanup-revshare-test-data.ts --apply                  # actually delete

import { getDb } from "../src/lib/db";

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
}
const APPLY = process.argv.includes("--apply");
const partnerId = Number(arg("partner", "1"));
const month = arg("month", "2026-06"); // YYYY-MM
const m = /^(\d{4})-(\d{2})$/.exec(month);
if (!Number.isInteger(partnerId) || !m) {
  console.error("ใช้: --partner=<id> --month=YYYY-MM [--apply]");
  process.exit(1);
}
const yy = Number(m[1]);
const mm = Number(m[2]);

const db = getDb();
const money = (n: number) => `฿${Number(n || 0).toFixed(2)}`;
const branchName = (id: number | null) =>
  id == null ? "—" : ((db.prepare("SELECT name FROM branches WHERE id=?").get(id) as { name?: string } | undefined)?.name ?? `#${id}`);

const partner = db.prepare(
  "SELECT id, name, venue, branch_id, income_branch_id, vat_enabled FROM revshare_partners WHERE id = ?"
).get(partnerId) as
  | { id: number; name: string; venue: string | null; branch_id: number; income_branch_id: number | null; vat_enabled: number }
  | undefined;
if (!partner) { console.error(`ไม่พบคู่ค้า id=${partnerId}`); process.exit(1); }
const shop = (partner.venue && partner.venue.trim()) || partner.name;

console.log("\n=== ล้างข้อมูลทดสอบ revshare ===");
console.log(`คู่ค้า #${partner.id}: ${partner.name}${shop !== partner.name ? ` (ร้าน: ${shop})` : ""}`);
console.log(`สาขาคู่ค้า: ${branchName(partner.branch_id)} · สาขาที่ลงรายรับ (income_branch): ${branchName(partner.income_branch_id)}`);
console.log(`เดือนเป้าหมาย: ${month}`);
console.log(`โหมด: ${APPLY ? "APPLY (ลบจริง)" : "DRY RUN (ยังไม่ลบ)"}\n`);

// [1] daily sales rounds — used ONLY by the settlement calc
const rounds = db.prepare(
  "SELECT id, period_start, sales_amount, source, sent_at FROM revshare_rounds WHERE partner_id=? AND period_year=? AND period_month=? ORDER BY period_start"
).all(partnerId, yy, mm) as Array<{ id: number; period_start: string; sales_amount: number; source: string; sent_at: string | null }>;
const roundsTotal = rounds.reduce((s, r) => s + r.sales_amount, 0);
console.log(`[1] revshare_rounds (ยอดขายรายวันของคู่ค้า): ${rounds.length} แถว รวม ${money(roundsTotal)}`);
for (const r of rounds) console.log(`    ${r.period_start} · ${money(r.sales_amount)} · ${r.source}${r.sent_at ? " · ส่งแล้ว" : ""}`);
console.log("    → ตารางนี้ใช้คำนวณส่วนแบ่งเท่านั้น ลบแล้วไม่กระทบยอดรายรับสาขาใด\n");

// [2] settlement snapshot(s) keyed at this month + any combined settlement covering it
const setts = db.prepare(
  "SELECT id, settle_year, settle_month, status, billed_gp FROM revshare_settlements WHERE partner_id=? AND settle_year=? AND settle_month=?"
).all(partnerId, yy, mm) as Array<{ id: number; settle_year: number; settle_month: number; status: string; billed_gp: number }>;
const combined = db.prepare(
  "SELECT id, settle_year, settle_month, covered_months, status FROM revshare_settlements WHERE partner_id=? AND covered_months LIKE ? AND NOT (settle_year=? AND settle_month=?)"
).all(partnerId, `%${month}%`, yy, mm) as Array<{ id: number; settle_year: number; settle_month: number; covered_months: string | null; status: string }>;
console.log(`[2] revshare_settlements (ใบสรุป/วางบิลของเดือนนี้): ${setts.length} แถว`);
for (const s of setts) console.log(`    #${s.id} · ${s.settle_month}/${s.settle_year} · สถานะ ${s.status} · GP ${money(s.billed_gp)}`);
if (combined.length) {
  console.log("    ⚠️ พบใบสรุปเดือนอื่นที่ \"รวม\" เดือนนี้ไว้ด้วย (สคริปต์จะไม่แตะอัตโนมัติ):");
  for (const s of combined) console.log(`       #${s.id} · keyed ${s.settle_month}/${s.settle_year} · covered ${s.covered_months} · ${s.status} — ถ้าจะล้าง ให้กด \"ย้อนกลับเป็นร่าง\" ในหน้าเว็บเองก่อน`);
}
console.log();

// [3] income posted into ACCOUNTA รายรับ from this data (the part that affects totals)
const grossCh = shop;                                   // daily mirror uses partnerShopName
const gpCh = `ส่วนแบ่งยอดขาย · ${partner.name}`;         // GP posting channel
const income = db.prepare(
  `SELECT id, branch_id, income_date, channel, amount, source
     FROM accounta_income
    WHERE substr(income_date,1,7)=?
      AND ( (source='revshare'    AND channel IS ?)
         OR (source='revshare_gp' AND channel IS ?) )
    ORDER BY income_date, id`
).all(month, grossCh, gpCh) as Array<{ id: number; branch_id: number; income_date: string; channel: string | null; amount: number; source: string }>;
const incomeTotal = income.reduce((s, r) => s + r.amount, 0);
console.log(`[3] accounta_income ที่โพสต์จากข้อมูลชุดนี้: ${income.length} แถว รวม ${money(incomeTotal)}`);
console.log("    (ส่วนนี้คือที่ \"กระทบยอดรายรับ\" จริง — ถ้ามี จะลบให้ยอดกลับมาถูก)");
for (const r of income) console.log(`    #${r.id} · ${r.income_date} · ${branchName(r.branch_id)} · ${r.channel} · ${money(r.amount)} · ${r.source}`);
console.log();

if (rounds.length === 0 && setts.length === 0 && income.length === 0) {
  console.log("ไม่พบข้อมูลทดสอบสำหรับคู่ค้า/เดือนนี้ — ไม่มีอะไรต้องลบ");
  process.exit(0);
}
if (!APPLY) {
  console.log("DRY RUN — ยังไม่ได้ลบอะไร ตรวจรายการด้านบนให้ชัวร์ว่าเป็น \"คู่ค้าและเดือน\" ที่ต้องการ แล้วรันซ้ำด้วย --apply เพื่อลบ");
  process.exit(0);
}

const res = db.transaction(() => {
  let inc = 0;
  for (const r of income) inc += db.prepare("DELETE FROM accounta_income WHERE id=?").run(r.id).changes;
  const dr = db.prepare("DELETE FROM revshare_rounds WHERE partner_id=? AND period_year=? AND period_month=?").run(partnerId, yy, mm).changes;
  let ds = 0;
  for (const s of setts) ds += db.prepare("DELETE FROM revshare_settlements WHERE id=?").run(s.id).changes;
  return { inc, dr, ds };
})();

console.log(`✓ ลบแล้ว — รายรับ ${res.inc} แถว · รอบยอดขาย ${res.dr} แถว · ใบสรุป ${res.ds} แถว`);
console.log("ยอดรายรับของสาขาที่เกี่ยวข้องกลับมาสะท้อนเฉพาะรายการจริงแล้ว");
