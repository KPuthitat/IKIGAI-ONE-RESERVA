// CLINICA analytics tests (owner 2026-09-26): month KPIs, payer/AR aging,
// revenue categories, top items, diagnoses, doctors, hours.
// Run:  node --import tsx scripts/test-clinica-analytics.ts

import fs from "node:fs";
import path from "node:path";
import type { ClinicaInvoiceParse, ClinicaOpdParse } from "../src/lib/clinica-parse";

const TMP = path.join(process.cwd(), "data", "test-clinica-analytics.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const cdb = await import("../src/lib/clinica-db");
  const ca = await import("../src/lib/clinica-analytics");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('clinic','AT HOME')").run().lastInsertRowid);

  const item = (code: string, name: string, net: number) => ({ code, name, qty: 1, unit: "ครั้ง", lineGross: net, lineDiscount: 0, lineNet: net });
  const bill = (billNo: string, date: string, time: string, payer: string, net: number, paid: number, due: number, items: ReturnType<typeof item>[]): ClinicaInvoiceParse["bills"][number] =>
    ({ billNo, date, time, hn: `HN-${billNo}`, payerGroup: payer, staff: "แอดมิน", gross: net, billDiscount: 0, net, paid, due, items });
  const invParse = (rs: string, re: string, bills: ClinicaInvoiceParse["bills"]): ClinicaInvoiceParse =>
    ({ kind: "invoice", rangeStart: rs, rangeEnd: re, bills, billCount: bills.length, patientCount: new Set(bills.map((b) => b.hn)).size, totalNet: 0, totalPaid: 0, totalDue: 0 });

  // Previous month (for MoM).
  cdb.importInvoice(branch, invParse("2026-07-05", "2026-07-05", [bill("BL0", "2026-07-05", "17:00:00", "ผู้ป่วยทั่วไป", 1000, 1000, 0, [item("GEN001", "[HSC] บริการ", 1000)])]));
  // Current month: cash service+drug bill, and an insurance lab bill (AR).
  cdb.importInvoice(branch, invParse("2026-08-05", "2026-08-10", [
    bill("BL1", "2026-08-05", "17:30:00", "ผู้ป่วยทั่วไป", 300, 300, 0, [item("GEN001", "[HSC] ค่าบริการ", 100), item("IKGPH/A1", "[#C1Y][ARI] ยา", 200)]),
    bill("BL2", "2026-08-10", "18:15:00", "ประกันกลุ่ม เอ", 500, 0, 500, [item("LAB1", "[LAB] CBC", 500)])
  ]));
  cdb.importOpd(branch, { kind: "opd", rangeStart: "2026-08-05", rangeEnd: "2026-08-11", visitCount: 3, patientCount: 3, visits: [
    { visitNo: "V1", date: "2026-08-05", time: "17:30:00", hn: "HN-1", gender: "ชาย", birthDate: "1990-01-01", doctor: "นพ.เอ", dxCode: "J00", dxTh: "หวัด", dxEn: "cold" },
    { visitNo: "V2", date: "2026-08-10", time: "18:15:00", hn: "HN-2", gender: "หญิง", birthDate: "1992-01-01", doctor: "นพ.เอ", dxCode: "J00", dxTh: "หวัด", dxEn: "cold" },
    { visitNo: "V3", date: "2026-08-11", time: "19:00:00", hn: "HN-3", gender: "ชาย", birthDate: "1988-01-01", doctor: "นพ.บี", dxCode: "J20", dxTh: "หลอดลมอักเสบ", dxEn: "bronchitis" }
  ] });

  const m = ca.clinicaMonth(branch, 2026, 8, "2026-08-31");
  ok("kpi: ยอดบิลรวม 800 · 2 บิล · 2 คนไข้", near(m.billNet, 800) && m.billCount === 2 && m.patientCount === 2);
  ok("kpi: เข้าจริง 300 · รอเบิก 500", near(m.paid, 300) && near(m.due, 500));
  ok("kpi: MoM vs 1000 = -20%", m.prevBillNet === 1000 && near(m.billNetMomPct!, -20));
  ok("payer: 2 กลุ่ม, ประกันเป็น AR 500", m.payers.length === 2 && m.arByPayer.length === 1 && m.arByPayer[0].group.includes("ประกัน") && near(m.arByPayer[0].due, 500));
  ok("AR aging: บิล 08-10 ถึง 08-31 = 21 วัน → ช่อง 0–30", near(m.arAging.d0_30, 500) && m.arAging.d31_60 === 0 && m.arAging.d90p === 0);
  ok("category: แล็บ 500 · ยา 200 · บริการ 100", (() => {
    const c = new Map(m.categories.map((x) => [x.key, x.net]));
    return near(c.get("lab") ?? 0, 500) && near(c.get("drug") ?? 0, 200) && near(c.get("service") ?? 0, 100);
  })());
  ok("topItems: อันดับ 1 คือแล็บ (net 500)", m.topItems[0]?.net === 500 && m.topItems.length === 3);
  ok("visits: 3 visit · 3 คนไข้", m.visitCount === 3 && m.visitPatientCount === 3);
  ok("diagnoses: หวัด 2 (อันดับ 1), หลอดลม 1", m.topDiagnoses[0]?.name === "หวัด" && m.topDiagnoses[0]?.count === 2 && m.topDiagnoses.some((d) => d.name === "หลอดลมอักเสบ" && d.count === 1));
  ok("doctors: นพ.เอ 2 · นพ.บี 1", (() => { const d = new Map(m.doctors.map((x) => [x.name, x.count])); return d.get("นพ.เอ") === 2 && d.get("นพ.บี") === 1; })());
  ok("hours: 17:00 →1, 18:00 →1 (จากบิล)", (() => { const h = new Map(m.hours.map((x) => [x.hour, x.count])); return h.get(17) === 1 && h.get(18) === 1; })());
  ok("hasData true; empty month false", m.hasData === true && ca.clinicaMonth(branch, 2026, 3).hasData === false);
  // น้องฮูก summary + recommendations (owner 2026-09-26).
  ok("advice: headline บอก MoM ต่ำกว่าเดือนก่อน 20% (ไม่มีเครื่องหมายลบซ้อน)", m.advice.some((l) => l.includes("ต่ำกว่าเดือนก่อน 20%") && !l.includes("-20")));
  ok("advice: มีบรรทัดเงินเข้าจริง/รอเบิก", m.advice.some((l) => l.includes("เงินเข้าจริง") && l.includes("รอเบิก")));
  ok("advice: เตือนพึ่งพากลุ่มผู้จ่ายสูง (ประกัน 63% ของบิล)", m.advice.some((l) => l.includes("พึ่งพากลุ่ม")));
  ok("advice: เดือนที่ไม่มีข้อมูล → advice ว่าง", ca.clinicaMonth(branch, 2026, 3).advice.length === 0);
  // Clinic report v2 (owner 2026-09-26): new/returning, daily trend, demographics, target.
  ok("patients: ใหม่ 2 · กลับมาซ้ำ 0 (ส.ค. เป็นบิลแรกของทั้งคู่)", m.newPatients === 2 && m.returningPatients === 0);
  ok("daily: 2 วัน (08-05=300, 08-10=500)", m.daily.length === 2 && m.daily[0].date === "2026-08-05" && near(m.daily[0].net, 300) && near(m.daily[1].net, 500));
  // Per-day file list: 08-05 & 08-10 have bills+OPD (ครบ), 08-11 has OPD only.
  ok("monthDays: 3 วัน (05,10 ครบ · 11 มี OPD ไม่มีบิล)", (() => {
    const byDate = new Map(m.monthDays.map((d) => [d.date, d]));
    const d5 = byDate.get("2026-08-05"), d11 = byDate.get("2026-08-11");
    return m.monthDays.length === 3
      && !!d5 && d5.hasInvoice && d5.hasOpd && d5.bills === 1 && d5.patients === 1
      && !!d11 && d11.hasInvoice === false && d11.hasOpd === true && d11.bills === 0;
  })());
  ok("demographics: ชาย 2 · หญิง 1 · อายุ 18–34=1, 35–59=2", (() => {
    const d = m.demographics; const band = new Map(d.ageBands.map((a) => [a.label, a.count]));
    return d.male === 2 && d.female === 1 && d.withAge === 3 && band.get("18–34") === 1 && band.get("35–59") === 2;
  })());
  ok("target: null เมื่อไม่ตั้งเป้า", m.target === null);
  ok("target: เป้า 1000 → 80% · คาดสิ้นเดือน 800 · ต่ำกว่าเป้า (เดือนปัจจุบัน)", (() => {
    const mt = ca.clinicaMonth(branch, 2026, 8, "2026-08-31", 1000);
    return mt.target != null && near(mt.target.pct, 80) && near(mt.target.projected, 800) && mt.target.onTrack === false && mt.target.isCurrent === true;
  })());
  ok("target: เดือนที่จบแล้ว → ทำได้จริง (isCurrent=false)", (() => {
    const mt = ca.clinicaMonth(branch, 2026, 8, "2026-09-26", 1000);
    return mt.target != null && mt.target.isCurrent === false && near(mt.target.projected, 800);
  })());
  // A patient billed in a prior month counts as returning when they come back.
  cdb.importInvoice(branch, invParse("2026-09-01", "2026-09-01", [
    { billNo: "BR1", date: "2026-09-01", time: "10:00:00", hn: "HN-BL1", payerGroup: "ผู้ป่วยทั่วไป", staff: "แอดมิน", gross: 100, billDiscount: 0, net: 100, paid: 100, due: 0, items: [item("GEN001", "[HSC] x", 100)] }
  ]));
  ok("patients: HN ที่เคยมาเดือนก่อน → กลับมาซ้ำ", (() => { const s = ca.clinicaMonth(branch, 2026, 9, "2026-09-30"); return s.newPatients === 0 && s.returningPatients === 1; })());

  // AR is all-time as of today: a June insurance claim still unpaid surfaces when
  // viewing August, and ages to the 90+ bucket.
  cdb.importInvoice(branch, invParse("2026-06-10", "2026-06-10", [bill("BLJ", "2026-06-10", "17:00:00", "ประกันกลุ่ม บี", 700, 0, 700, [item("LAB2", "[LAB] X", 700)])]));
  const m2 = ca.clinicaMonth(branch, 2026, 8, "2026-09-26");
  ok("AR all-time: รวมบิลค้างเดือนก่อน (500+700=1200) · 2 ผู้จ่าย", near(m2.arTotal, 1200) && m2.arByPayer.length === 2);
  ok("AR aging (ณ 09-26): 08-10→31–60, 06-10→90+", near(m2.arAging.d31_60, 500) && near(m2.arAging.d90p, 700) && near(m2.arAging.d0_30, 0));
  ok("headline due ยังเป็นของเดือนที่ดู (Aug = 500)", near(m2.due, 500));
  ok("advice (ณ 09-26): เตือนรอเบิกค้างเกิน 90 วัน (บิล มิ.ย.)", m2.advice.some((l) => l.includes("เกิน 90 วัน")));
  // Per-payer aging (owner 2026-09-26): each owing payer carries its own buckets.
  ok("aging รายเจ้า: ประกัน เอ (บิล ส.ค.) → 31–60, ประกัน บี (บิล มิ.ย.) → 90+", (() => {
    const a = m2.arByPayer.find((p) => p.group.includes("เอ"));
    const b = m2.arByPayer.find((p) => p.group.includes("บี"));
    return !!a && near(a.aging.d31_60, 500) && a.aging.d90p === 0
        && !!b && near(b.aging.d90p, 700) && b.aging.d31_60 === 0;
  })());

  // Weekly rollup (owner 2026-09-27: "การ์ดสัปดาห์เต็ม + เทียบสัปดาห์ก่อน"). ISO week
  // Mon–Sun. 2026-10-05 is a Monday; the prior week is 2026-09-28..10-04.
  cdb.importInvoice(branch, invParse("2026-09-28", "2026-09-28", [bill("WP0", "2026-09-28", "10:00:00", "ผู้ป่วยทั่วไป", 200, 200, 0, [item("GEN001", "[HSC] บริการ", 200)])]));
  cdb.importInvoice(branch, invParse("2026-10-05", "2026-10-07", [
    bill("WC1", "2026-10-05", "09:00:00", "ผู้ป่วยทั่วไป", 300, 300, 0, [item("GEN001", "[HSC] บริการ", 300)]),
    bill("WC2", "2026-10-07", "11:00:00", "ผู้ป่วยทั่วไป", 500, 500, 0, [item("LAB1", "[LAB] CBC", 500)]),
  ]));
  const w = ca.clinicaWeek(branch, "2026-10-07");
  ok("week: ช่วง จ–อา ที่ถูกต้อง (05–11 ต.ค.)", w.weekStart === "2026-10-05" && w.weekEnd === "2026-10-11");
  ok("week: ยอดบิลรวม 800 · 2 บิล · 2 คนไข้ · 2 วัน", near(w.totalNet, 800) && w.totalBills === 2 && w.totalPatients === 2 && w.dayCount === 2);
  ok("week: เฉลี่ย/วัน = 400 · วันเด่น = 10-07 (500)", near(w.avgPerDay!, 400) && w.bestDate === "2026-10-07");
  ok("week: รายวัน 2 แถว (300, 500) เรียงวันที่", w.days.length === 2 && w.days[0].date === "2026-10-05" && near(w.days[0].net, 300) && near(w.days[1].net, 500));
  ok("week: label เป็นวันที่มีข้อมูลจริง (5–7 ตุลาคม 2569)", w.label === "5–7 ตุลาคม 2569");
  ok("week: เทียบสัปดาห์ก่อน 200 → ยอด +300% · บิล +100% · คนไข้ +100%", w.prevWeekNet === 200 && near(w.wowNetPct!, 300) && near(w.wowBillsPct!, 100) && near(w.wowPatientsPct!, 100));
  ok("week: topItems เรียงตามยอด (แล็บ 500 มาก่อน)", w.topItems.length === 2 && w.topItems[0].net === 500);
  ok("week: สัปดาห์ที่ไม่มีข้อมูล → ทุกค่าเป็น 0 และ WoW null", (() => {
    const e = ca.clinicaWeek(branch, "2026-11-16");
    return e.dayCount === 0 && e.totalBills === 0 && e.wowNetPct === null && e.days.length === 0;
  })());

  // Company overview + annual roll-up must include a clinic branch's billed net
  // (owner 2026-09-27: "ภาพรวม/รายปีก็ต้องขึ้น"). Dedicated branch so the figures
  // are independent of the data other tests seeded on `branch`.
  const sa = await import("../src/lib/salesa-analytics");
  const cb = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('clinic2','CLINIC 2',1)").run().lastInsertRowid);
  cdb.importInvoice(cb, invParse("2026-08-03", "2026-08-04", [
    bill("CB1", "2026-08-03", "17:00:00", "ผู้ป่วยทั่วไป", 1000, 1000, 0, [item("GEN001", "[HSC] บริการ", 1000)]),
    bill("CB2", "2026-08-04", "18:00:00", "ผู้ป่วยทั่วไป", 500, 500, 0, [item("GEN001", "[HSC] บริการ", 500)]),
  ]));
  const ov = sa.companyOverview([cb], 2026, 8, "2026-08-31");
  ok("company: ภาพรวมรวมยอดคลินิก (mtd 1500 · 2 บิล · 2 คน)", near(ov.total.mtdNett, 1500) && ov.total.bills === 2 && ov.total.pax === 2 && ov.branchCount === 1);
  ok("company: แถวสาขาคลินิกโชว์ยอด 1500 (ไม่ใช่ 0)", ov.branches.length === 1 && near(ov.branches[0].mtdNett, 1500));
  const bars = sa.annualBranchBars(2026, "2026-08-31", [cb]);
  ok("annual: สาขาคลินิกอยู่ในกราฟรายปี · ส.ค. = 1500", (() => {
    const row = bars.branches.find((b) => b.branchId === cb);
    return !!row && near(row.total, 1500) && row.months[7] === 1500;
  })());
  ok("annual: YTD ของคลินิก = 1500 · คาดสิ้นปี > YTD (run-rate)", (() => {
    const p = cdb.clinicaYtdProjection(cb, "2026-08-31");
    return near(p.ytd, 1500) && p.projected > p.ytd;
  })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
