// CLINICA store tests (owner 2026-09-26): range-based replace-in-range import
// for invoices + visits, and re-import overwrite (a source-removed bill/visit
// disappears). Run:  node --import tsx scripts/test-clinica-db.ts

import fs from "node:fs";
import path from "node:path";
import type { ClinicaInvoiceParse, ClinicaOpdParse } from "../src/lib/clinica-parse";

const TMP = path.join(process.cwd(), "data", "test-clinica-db.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const cdb = await import("../src/lib/clinica-db");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const q1 = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('clinic','AT HOME')").run().lastInsertRowid);

  const bill = (billNo: string, date: string, net: number, due: number, itemNames: string[]): ClinicaInvoiceParse["bills"][number] => ({
    billNo, date, time: "17:00:00", hn: `HN-${billNo}`, payerGroup: due > 0 ? "ประกันกลุ่ม เอ" : "ผู้ป่วยทั่วไป", staff: "แอดมิน",
    gross: net, billDiscount: 0, net, paid: net - due, due,
    items: itemNames.map((name) => ({ code: "X", name, qty: 1, unit: "ครั้ง", lineGross: net / itemNames.length, lineDiscount: 0, lineNet: net / itemNames.length }))
  });
  // Range derived from the bills, exactly like the real parser.
  const invParse = (bills: ClinicaInvoiceParse["bills"]): ClinicaInvoiceParse => {
    const ds = bills.map((b) => b.date).filter(Boolean).sort();
    return {
      kind: "invoice", rangeStart: ds[0] ?? "", rangeEnd: ds[ds.length - 1] ?? "", bills,
      billCount: bills.length, patientCount: new Set(bills.map((b) => b.hn)).size,
      totalNet: bills.reduce((s, b) => s + b.net, 0), totalPaid: bills.reduce((s, b) => s + b.paid, 0), totalDue: bills.reduce((s, b) => s + b.due, 0)
    };
  };

  // Import BL1 (2 items, cash) + BL2 (1 item, insurance AR).
  cdb.importInvoice(branch, invParse([bill("BL1", "2026-08-01", 380, 0, ["บริการ", "ยา"]), bill("BL2", "2026-08-02", 450, 450, ["แล็บ"])]));
  ok("import: 2 bills, 3 items", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch) === 2 && q1("SELECT COUNT(*) n FROM clinica_bill_items") === 3);
  ok("import: total net 830, AR 450", near(q1("SELECT COALESCE(SUM(net),0) n FROM clinica_bills WHERE branch_id=?", branch), 830) && near(q1("SELECT COALESCE(SUM(due),0) n FROM clinica_bills WHERE branch_id=?", branch), 450));

  // Re-import the SAME span (08-01..08-02) with BL2 replaced by BL3 on 08-02 →
  // range-replace clears both days, BL2 gone, BL3 in.
  cdb.importInvoice(branch, invParse([bill("BL1", "2026-08-01", 380, 0, ["บริการ", "ยา"]), bill("BL3", "2026-08-02", 200, 0, ["ยา"])]));
  ok("re-import same span: BL2 replaced by BL3 → 2 bills, BL2 gone", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch) === 2 && q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=? AND bill_no='BL2'", branch) === 0 && q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=? AND bill_no='BL3'", branch) === 1);
  ok("re-import: items cascaded correctly → 3 (BL1×2 + BL3×1)", q1("SELECT COUNT(*) n FROM clinica_bill_items") === 3);

  // Partial re-import (only 08-01) replaces ONLY that day — 08-02's BL3 survives.
  cdb.importInvoice(branch, invParse([bill("BL1", "2026-08-01", 380, 0, ["บริการ", "ยา"])]));
  ok("partial re-import replaces only its day; other days untouched", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch) === 2 && q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=? AND bill_no='BL3'", branch) === 1);
  ok("partial re-import: no duplicate BL1", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=? AND bill_no='BL1'", branch) === 1);

  // A different month import doesn't touch August.
  cdb.importInvoice(branch, invParse([bill("BL9", "2026-09-01", 100, 0, ["x"])]));
  ok("import another month keeps August", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch) === 3);

  // Visits: import + dedup key + re-import overwrite.
  const visit = (visitNo: string, date: string, dx: string, doctor = "นพ.เอ"): ClinicaOpdParse["visits"][number] =>
    ({ visitNo, date, time: "17:00:00", hn: `HN-${visitNo}`, gender: "ชาย", birthDate: "1990-01-01", doctor, dxCode: dx, dxTh: "หวัด", dxEn: "cold" });
  const opdParse = (visits: ClinicaOpdParse["visits"]): ClinicaOpdParse => {
    const ds = visits.map((v) => v.date).filter(Boolean).sort();
    return { kind: "opd", rangeStart: ds[0] ?? "", rangeEnd: ds[ds.length - 1] ?? "", visits, visitCount: new Set(visits.map((v) => v.visitNo)).size, patientCount: new Set(visits.map((v) => v.hn)).size };
  };
  cdb.importOpd(branch, opdParse([visit("V1", "2026-08-01", "J00"), visit("V1", "2026-08-01", "J20"), visit("V2", "2026-08-02", "J00")]));
  ok("import visits: 3 rows (V1 has 2 dx)", q1("SELECT COUNT(*) n FROM clinica_visits WHERE branch_id=?", branch) === 3);
  // Re-import the same span with V1's J20 dropped → span-replace clears it.
  cdb.importOpd(branch, opdParse([visit("V1", "2026-08-01", "J00"), visit("V2", "2026-08-02", "J00")]));
  ok("re-import visits overwrites span → V1 J20 gone → 2 rows", q1("SELECT COUNT(*) n FROM clinica_visits WHERE branch_id=?", branch) === 2 && q1("SELECT COUNT(*) n FROM clinica_visits WHERE branch_id=? AND visit_no='V1'", branch) === 1);

  ok("isClinicaBranch true", cdb.isClinicaBranch(branch) === true);
  ok("isClinicaBranch false for other branch", cdb.isClinicaBranch(999999) === false);
  const range = cdb.clinicaImportedRange(branch);
  ok("clinicaImportedRange spans Aug–Sep bills", range.billsFrom === "2026-08-01" && range.billsTo === "2026-09-01");

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
