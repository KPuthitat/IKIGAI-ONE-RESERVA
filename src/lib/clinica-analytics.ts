// CLINICA analytics (owner 2026-09-26) — the clinic section of ANALYTICA, from
// the imported HIS data. Headline is ยอดบิลรวม (billed net), split into เงินเข้า
// จริง (paid: cash + PromptPay) vs รอเบิกประกัน (due: AR). Plus payer/AR aging,
// revenue by category, top drugs/labs, diagnoses, doctors and peak hours. Every
// money figure carries its count (ครั้ง) for the parenthesised display.

import { getDb } from "./db";
import { clinicaPaidPct } from "./clinica-shared";
import { mondayOf, roundLabel, thaiDate } from "./revshare";

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function relPct(cur: number, base: number | null): number | null {
  return base != null && base > 0 ? round2(((cur - base) / base) * 100) : null;
}
function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthBounds(y: number, m: number): [string, string] {
  const mm = String(m).padStart(2, "0");
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(daysInMonth(y, m)).padStart(2, "0")}`];
}

export type PayerRow = { group: string; net: number; count: number; paid: number; due: number };
export type Aging = { d0_30: number; d31_60: number; d61_90: number; d90p: number };
export type ArPayerRow = PayerRow & { aging: Aging };  // owing payer + its aging buckets
export type AmountCount = { net: number; count: number };
export type CatRow = { key: string; label: string; net: number; count: number };
export type NamedNet = { name: string; net: number; qty: number };
export type NamedCount = { name: string; count: number };
export type HourCount = { hour: number; count: number };
export type DailyPoint = { date: string; net: number; count: number };
export type AgeBand = { label: string; count: number };
export type Demographics = { male: number; female: number; other: number; ageBands: AgeBand[]; withAge: number };
export type ClinicaTarget = { target: number; pct: number; projected: number; projectedPct: number; onTrack: boolean; isCurrent: boolean };

export type ClinicaMonth = {
  year: number; month: number;
  hasData: boolean;
  // headline (this month's bills)
  billNet: number; billCount: number; patientCount: number; avgPerBill: number | null;
  paid: number; due: number;                 // เงินเข้าจริง / รอเบิก จากบิลเดือนนี้
  prevBillNet: number | null; billNetMomPct: number | null;
  // patient mix (new vs returning), daily trend, demographics, target
  newPatients: number; returningPatients: number;
  daily: DailyPoint[];
  demographics: Demographics;
  target: ClinicaTarget | null;
  // payer mix (this month)
  payers: PayerRow[];
  // AR — outstanding across ALL periods as of today (not month-scoped)
  arTotal: number;
  arByPayer: ArPayerRow[];                     // unpaid payers (+per-payer aging), biggest owing first
  arAging: Aging;                              // age = today − bill_date
  // revenue structure
  categories: CatRow[];
  topItems: NamedNet[];
  // clinical
  visitCount: number; visitPatientCount: number;
  topDiagnoses: NamedCount[];
  doctors: NamedCount[];
  hours: HourCount[];                         // bills by clock hour
  advice: string[];                           // auto summary + recommendations (น้องฮูก)
};

export type ClinicaWeekDay = { date: string; dateLabel: string; net: number; bills: number };
export type ClinicaWeek = {
  weekStart: string; weekEnd: string; label: string;
  dayCount: number;                 // days in the week that have at least one bill
  totalNet: number; totalBills: number; totalPatients: number;
  avgPerDay: number | null;
  bestDate: string | null;          // highest-billing day of the week
  days: ClinicaWeekDay[];           // billed days, ascending
  // เทียบสัปดาห์ก่อน (previous Mon–Sun) — mirrors the restaurant weekly card
  prevWeekNet: number | null; prevWeekDays: number;
  wowNetPct: number | null; wowBillsPct: number | null; wowPatientsPct: number | null;
  topItems: NamedNet[];             // top revenue items this week
};

const CAT_LABEL: Record<string, string> = { service: "ค่าบริการ/ตรวจ", drug: "ยา", lab: "แล็บ", package: "แพ็กเกจตรวจสุขภาพ", other: "อื่นๆ" };

const bahtTh = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;

/** Auto executive summary + recommendations for the clinic month — the น้องฮูก
 *  card that mirrors the restaurant's "สรุป & คำแนะนำ" (owner 2026-09-26: make
 *  the clinic report read like the restaurant one). Pure: reads only the
 *  already-computed month figures. Headline first, then the most actionable
 *  notes (collection, overdue AR, payer concentration), capped at 5 lines. */
export function clinicaAdvice(c: Omit<ClinicaMonth, "advice">): string[] {
  const out: string[] = [];
  if (!c.hasData) return out;

  // 1) Headline: this month's billed total vs last month.
  if (c.billNetMomPct == null) {
    out.push(`ยอดบิลรวมเดือนนี้ ${bahtTh(c.billNet)} (${c.billCount.toLocaleString("th-TH")} ครั้ง)`);
  } else if (c.billNetMomPct >= 5) {
    out.push(`ยอดบิลรวมสูงกว่าเดือนก่อน +${c.billNetMomPct}% — โมเมนตัมดี รักษาไว้`);
  } else if (c.billNetMomPct <= -5) {
    out.push(`ยอดบิลรวมต่ำกว่าเดือนก่อน ${Math.abs(c.billNetMomPct)}% — ทบทวนจำนวนคนไข้/บริการ`);
  } else {
    out.push(`ยอดบิลรวมใกล้เคียงเดือนก่อน (${c.billNetMomPct >= 0 ? "+" : ""}${c.billNetMomPct}%)`);
  }

  // 2) Cash collection — how much of THIS MONTH's billing is real cash in vs AR.
  //    paid + due = billNet per bill, so derive due% as 100 − paid%; clamp to
  //    [0,100] so an overpayment/credit (paid > billNet) can't print a negative
  //    รอเบิก%.
  if (c.billNet > 0) {
    const paidPct = clinicaPaidPct(c);
    out.push(`เงินเข้าจริง (เงินสด/พร้อมเพย์) ${bahtTh(c.paid)} (${paidPct}%) · รอเบิก ${bahtTh(c.due)} (${100 - paidPct}%)`);
  }

  // 3) Overdue AR — the most actionable warning. This is the CUMULATIVE unpaid
  //    balance across all periods as of today (not this month's รอเบิก above), so
  //    the wording says "สะสม" to keep the two lines from reading as contradictory.
  if (c.arAging.d90p > 0.5) {
    out.push(`⚠️ รอเบิกค้างสะสมเกิน 90 วัน ${bahtTh(c.arAging.d90p)} — ควรเร่งตามเก็บ`);
  } else if (c.arAging.d61_90 > 0.5) {
    out.push(`รอเบิกค้างสะสม 61–90 วัน ${bahtTh(c.arAging.d61_90)} — ใกล้ครบกำหนด ควรติดตาม`);
  }

  // 3b) Patient growth — new vs returning, the clinic's headline growth signal.
  if (c.newPatients + c.returningPatients > 0) {
    const share = Math.round((c.newPatients / (c.newPatients + c.returningPatients)) * 100);
    out.push(`คนไข้ใหม่ ${c.newPatients} คน (${share}%) · กลับมาซ้ำ ${c.returningPatients} คน`);
  }

  // 4) Payer concentration — dependency risk on a single INSURER/corporate payer.
  //    A dominant general-cash base is healthy, not a risk, so the cash/self-pay
  //    and unspecified groups are excluded (matched loosely — the HIS "กลุ่มลูกค้า"
  //    label is free text, e.g. ผู้ป่วยทั่วไป / ลูกค้าทั่วไป / เงินสด / ชำระเงินเอง).
  const isGeneralPayer = (g: string) => g === "(ไม่ระบุ)" || /ทั่วไป|เงินสด|ชำระเงินเอง/.test(g);
  const topInsurer = c.payers.find((p) => !isGeneralPayer(p.group));
  if (topInsurer && c.billNet > 0) {
    const share = Math.round((topInsurer.net / c.billNet) * 100);
    if (share >= 50) out.push(`พึ่งพากลุ่ม "${topInsurer.group}" สูง ${share}% ของยอดบิล — ควรกระจายฐานคนไข้`);
  }

  // 5) Revenue driver + a patient-mix note, whichever room is left.
  if (c.categories.length) out.push(`รายได้หลักจาก${c.categories[0].label} ${bahtTh(c.categories[0].net)}`);
  else if (c.avgPerBill != null) out.push(`คนไข้ ${c.patientCount.toLocaleString("th-TH")} คน · เฉลี่ย/บิล ${bahtTh(c.avgPerBill)}`);

  return out.slice(0, 6);
}

/** Gender + age bands from a month's distinct OPD patients. Gender is free text
 *  (ชาย/หญิง); age is today − birth_date (ISO), bucketed. */
function buildDemographics(rows: Array<{ gender: string | null; birth: string | null }>, asOfDate: string): Demographics {
  let male = 0, female = 0, other = 0, withAge = 0;
  const bands = { "0–17": 0, "18–34": 0, "35–59": 0, "60+": 0 };
  const asOfMs = new Date(`${asOfDate}T00:00:00Z`).getTime();
  for (const r of rows) {
    const g = r.gender ?? "";
    // Thai (ชาย/หญิง) or coded (M/F, male/female) gender values.
    if (/ญ|female|^\s*f\s*$/i.test(g)) female++;
    else if (/ช|male|^\s*m\s*$/i.test(g)) male++;
    else other++;
    if (r.birth && /^\d{4}-\d{2}-\d{2}$/.test(r.birth)) {
      const age = Math.floor((asOfMs - new Date(`${r.birth}T00:00:00Z`).getTime()) / (365.25 * 86_400_000));
      if (age >= 0 && age < 130) {
        withAge++;
        if (age <= 17) bands["0–17"]++; else if (age <= 34) bands["18–34"]++; else if (age <= 59) bands["35–59"]++; else bands["60+"]++;
      }
    }
  }
  return { male, female, other, withAge, ageBands: (Object.keys(bands) as Array<keyof typeof bands>).map((label) => ({ label, count: bands[label] })) };
}

/** Target progress + month-end projection. Projection scales billed-so-far by
 *  calendar days elapsed for the CURRENT month; a past month is already complete.
 *  Returns null when no target is set. */
function buildTarget(billNet: number, year: number, month: number, asOfDate: string, target: number | null): ClinicaTarget | null {
  if (!target || target <= 0) return null;
  const mm = String(month).padStart(2, "0");
  const ymPrefix = `${year}-${mm}`;
  const dim = daysInMonth(year, month);
  const isCurrent = asOfDate.slice(0, 7) === ymPrefix;
  const isPast = asOfDate.slice(0, 7) > ymPrefix;
  if (!isCurrent && !isPast) return null;   // a future month hasn't started — no target card
  const elapsed = isCurrent ? Math.max(1, Math.min(dim, Number(asOfDate.slice(8, 10)))) : dim;
  const projected = isCurrent ? round2((billNet * dim) / elapsed) : round2(billNet);
  return {
    target: round2(target),
    pct: round2((billNet / target) * 100),
    projected,
    projectedPct: round2((projected / target) * 100),
    onTrack: projected >= target,
    isCurrent,
  };
}

/** Full clinic analytics for a month. `asOf` (Bangkok YYYY-MM-DD) anchors AR
 *  aging; defaults to the month end. `monthlyTarget` (the branch's target)
 *  drives the target-progress card when set. */
export function clinicaMonth(branchId: number, year: number, month: number, asOf?: string, monthlyTarget?: number | null): ClinicaMonth {
  const db = getDb();
  const [start, end] = monthBounds(year, month);
  const pm = month === 1 ? 12 : month - 1;
  const pmY = month === 1 ? year - 1 : year;
  const [pStart, pEnd] = monthBounds(pmY, pm);
  // AR is a point-in-time snapshot → age unpaid bills as of TODAY (Bangkok), not
  // the viewed month, so a genuinely 90-day-old claim reads as 90 days old.
  const asOfDate = asOf ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  const kpi = db.prepare(
    `SELECT COALESCE(SUM(net),0) net, COUNT(*) bills, COUNT(DISTINCT NULLIF(hn,'')) pts,
            COALESCE(SUM(paid),0) paid, COALESCE(SUM(due),0) due
       FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?`
  ).get(branchId, start, end) as { net: number; bills: number; pts: number; paid: number; due: number };

  const prevNet = (db.prepare(
    `SELECT COALESCE(SUM(net),0) net FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?`
  ).get(branchId, pStart, pEnd) as { net: number }).net;
  const prevBillNet = prevNet > 0 ? round2(prevNet) : null;

  const payers = (db.prepare(
    `SELECT COALESCE(NULLIF(payer_group,''),'(ไม่ระบุ)') grp, ROUND(SUM(net),2) net, COUNT(*) cnt,
            ROUND(SUM(paid),2) paid, ROUND(SUM(due),2) due
       FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?
       GROUP BY grp ORDER BY net DESC`
  ).all(branchId, start, end) as Array<{ grp: string; net: number; cnt: number; paid: number; due: number }>)
    .map((r) => ({ group: r.grp, net: r.net, count: r.cnt, paid: r.paid, due: r.due }));

  // AR = ALL unpaid bills for the branch (across every period), owing biggest first.
  const arRows = (db.prepare(
    `SELECT COALESCE(NULLIF(payer_group,''),'(ไม่ระบุ)') grp, ROUND(SUM(net),2) net, COUNT(*) cnt,
            ROUND(SUM(paid),2) paid, ROUND(SUM(due),2) due
       FROM clinica_bills WHERE branch_id=? AND due>0.005 GROUP BY grp ORDER BY due DESC`
  ).all(branchId) as Array<{ grp: string; net: number; cnt: number; paid: number; due: number }>);

  // AR aging by how long each unpaid bill has been outstanding (asOf − bill_date),
  // accumulated both overall AND per payer group so each owing payer shows which
  // buckets its outstanding falls in (owner 2026-09-26: "รู้ได้ไงว่าอันไหนกี่วัน").
  const zeroAging = (): Aging => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 });
  const bucketOf = (days: number): keyof Aging => days <= 30 ? "d0_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90p";
  const aging = zeroAging();
  const agingByGroup = new Map<string, Aging>();
  const asOfMs = new Date(`${asOfDate}T00:00:00Z`).getTime();
  for (const r of db.prepare(
    `SELECT COALESCE(NULLIF(payer_group,''),'(ไม่ระบุ)') grp, bill_date, due
       FROM clinica_bills WHERE branch_id=? AND due>0.005 AND bill_date<>''`
  ).all(branchId) as Array<{ grp: string; bill_date: string; due: number }>) {
    const days = Math.floor((asOfMs - new Date(`${r.bill_date}T00:00:00Z`).getTime()) / 86_400_000);
    const b = bucketOf(days);
    aging[b] += r.due;
    const g = agingByGroup.get(r.grp) ?? zeroAging();
    g[b] += r.due;
    agingByGroup.set(r.grp, g);
  }
  const roundAging = (a: Aging): Aging => ({ d0_30: round2(a.d0_30), d31_60: round2(a.d31_60), d61_90: round2(a.d61_90), d90p: round2(a.d90p) });
  const agingRounded = roundAging(aging);

  const arByPayer: ArPayerRow[] = arRows.map((r) => ({
    group: r.grp, net: r.net, count: r.cnt, paid: r.paid, due: r.due,
    aging: roundAging(agingByGroup.get(r.grp) ?? zeroAging())
  }));
  const arTotal = round2(arByPayer.reduce((s, p) => s + p.due, 0));

  const categories = (db.prepare(
    `SELECT CASE
              WHEN i.name LIKE '%[LAB]%' THEN 'lab'
              WHEN i.code LIKE 'GEN%' OR i.name LIKE '%[HSC]%' OR i.name LIKE '%[HSC-GRP]%' OR i.name LIKE '%[PHY]%' OR i.name LIKE '%[EMR]%' THEN 'service'
              WHEN i.code LIKE 'IKGPH%' THEN 'drug'
              WHEN i.code LIKE 'LN%' OR i.name LIKE '%ตรวจสุขภาพ%' THEN 'package'
              ELSE 'other' END cat,
            ROUND(SUM(i.line_net),2) net, COUNT(*) cnt
       FROM clinica_bill_items i JOIN clinica_bills b ON b.id=i.bill_id
       WHERE b.branch_id=? AND b.bill_date BETWEEN ? AND ?
       GROUP BY cat ORDER BY net DESC`
  ).all(branchId, start, end) as Array<{ cat: string; net: number; cnt: number }>)
    .map((r) => ({ key: r.cat, label: CAT_LABEL[r.cat] ?? r.cat, net: r.net, count: r.cnt }));

  const topItems = (db.prepare(
    `SELECT i.name, ROUND(SUM(i.line_net),2) net, ROUND(SUM(i.qty),2) qty
       FROM clinica_bill_items i JOIN clinica_bills b ON b.id=i.bill_id
       WHERE b.branch_id=? AND b.bill_date BETWEEN ? AND ? AND COALESCE(i.name,'')<>''
       GROUP BY i.name ORDER BY net DESC LIMIT 10`
  ).all(branchId, start, end) as Array<{ name: string; net: number; qty: number }>);

  const visits = db.prepare(
    `SELECT COUNT(DISTINCT visit_no) v, COUNT(DISTINCT NULLIF(hn,'')) pts
       FROM clinica_visits WHERE branch_id=? AND visit_date BETWEEN ? AND ?`
  ).get(branchId, start, end) as { v: number; pts: number };

  const topDiagnoses = (db.prepare(
    `SELECT dx_th name, COUNT(*) cnt FROM clinica_visits
       WHERE branch_id=? AND visit_date BETWEEN ? AND ? AND COALESCE(dx_th,'')<>''
       GROUP BY dx_th ORDER BY cnt DESC LIMIT 10`
  ).all(branchId, start, end) as Array<{ name: string; cnt: number }>).map((r) => ({ name: r.name, count: r.cnt }));

  const doctors = (db.prepare(
    `SELECT COALESCE(NULLIF(doctor,''),'(ไม่ระบุ)') name, COUNT(DISTINCT visit_no) cnt FROM clinica_visits
       WHERE branch_id=? AND visit_date BETWEEN ? AND ? GROUP BY name ORDER BY cnt DESC LIMIT 8`
  ).all(branchId, start, end) as Array<{ name: string; cnt: number }>).map((r) => ({ name: r.name, count: r.cnt }));

  const hours = (db.prepare(
    `SELECT CAST(substr(bill_time,1,2) AS INTEGER) hr, COUNT(*) cnt FROM clinica_bills
       WHERE branch_id=? AND bill_date BETWEEN ? AND ? AND COALESCE(bill_time,'')<>''
       GROUP BY hr ORDER BY hr ASC`
  ).all(branchId, start, end) as Array<{ hr: number; cnt: number }>).map((r) => ({ hour: r.hr, count: r.cnt }));

  // New vs returning patients: among patients billed this month, "new" = their
  // first-ever bill (across all imported history) fell in this month.
  const pmix = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN firstDate >= ? THEN 1 ELSE 0 END),0) newp, COUNT(*) total FROM (
       SELECT hn, MIN(bill_date) firstDate,
              MAX(CASE WHEN bill_date BETWEEN ? AND ? THEN 1 ELSE 0 END) seen
         FROM clinica_bills WHERE branch_id=? AND NULLIF(hn,'') IS NOT NULL AND bill_date<>''
         GROUP BY hn
     ) WHERE seen=1`
  ).get(start, start, end, branchId) as { newp: number; total: number };
  const newPatients = pmix.newp;
  const returningPatients = Math.max(0, pmix.total - pmix.newp);

  // Daily billed net + count (in-month trend).
  const daily = (db.prepare(
    `SELECT bill_date date, ROUND(SUM(net),2) net, COUNT(*) cnt FROM clinica_bills
       WHERE branch_id=? AND bill_date BETWEEN ? AND ? AND bill_date<>''
       GROUP BY bill_date ORDER BY bill_date ASC`
  ).all(branchId, start, end) as Array<{ date: string; net: number; cnt: number }>)
    .map((r) => ({ date: r.date, net: r.net, count: r.cnt }));

  // Demographics from OPD visits — one row per patient (hn) so a patient counts once.
  const demoRows = db.prepare(
    `SELECT MAX(gender) gender, MAX(birth_date) birth FROM clinica_visits
       WHERE branch_id=? AND visit_date BETWEEN ? AND ? AND NULLIF(hn,'') IS NOT NULL
       GROUP BY hn`
  ).all(branchId, start, end) as Array<{ gender: string | null; birth: string | null }>;
  const demographics = buildDemographics(demoRows, asOfDate);

  const target = buildTarget(round2(kpi.net), year, month, asOfDate, monthlyTarget ?? null);

  const base: Omit<ClinicaMonth, "advice"> = {
    year, month,
    hasData: kpi.bills > 0 || visits.v > 0,
    billNet: round2(kpi.net), billCount: kpi.bills, patientCount: kpi.pts,
    avgPerBill: kpi.bills > 0 ? round2(kpi.net / kpi.bills) : null,
    paid: round2(kpi.paid), due: round2(kpi.due),
    prevBillNet, billNetMomPct: relPct(kpi.net, prevBillNet),
    newPatients, returningPatients, daily, demographics, target,
    payers, arTotal, arByPayer, arAging: agingRounded,
    categories, topItems,
    visitCount: visits.v, visitPatientCount: visits.pts,
    topDiagnoses, doctors, hours
  };
  return { ...base, advice: clinicaAdvice(base) };
}

/** Weekly clinic rollup for the ISO week (Mon–Sun) containing `weekStartIso` —
 *  the clinic mirror of the restaurant's สรุปรายสัปดาห์ card (owner 2026-09-27:
 *  "การ์ดสัปดาห์เต็ม + เทียบสัปดาห์ก่อน"). Billed net, bills, patients, avg/day,
 *  a Mon–Sun daily list and top revenue items, plus WoW vs the previous week. */
export function clinicaWeek(branchId: number, weekStartIso: string, topN = 5): ClinicaWeek {
  const db = getDb();
  const start = mondayOf(weekStartIso);
  const end = addDaysIso(start, 6);

  const kpi = db.prepare(
    `SELECT COALESCE(SUM(net),0) net, COUNT(*) bills, COUNT(DISTINCT NULLIF(hn,'')) pts
       FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?`
  ).get(branchId, start, end) as { net: number; bills: number; pts: number };

  const dayRows = (db.prepare(
    `SELECT bill_date date, ROUND(SUM(net),2) net, COUNT(*) bills FROM clinica_bills
       WHERE branch_id=? AND bill_date BETWEEN ? AND ? AND bill_date<>''
       GROUP BY bill_date ORDER BY bill_date ASC`
  ).all(branchId, start, end) as Array<{ date: string; net: number; bills: number }>);
  const days: ClinicaWeekDay[] = dayRows.map((d) => ({ date: d.date, dateLabel: thaiDate(d.date), net: d.net, bills: d.bills }));
  const best = dayRows.reduce<{ date: string; net: number } | null>((b, d) => (b == null || d.net > b.net ? d : b), null);

  // Previous ISO week (owner: เทียบสัปดาห์ก่อน).
  const prevStart = addDaysIso(start, -7);
  const prevEnd = addDaysIso(start, -1);
  const prev = db.prepare(
    `SELECT COALESCE(SUM(net),0) net, COUNT(*) bills, COUNT(DISTINCT NULLIF(hn,'')) pts,
            COUNT(DISTINCT CASE WHEN bill_date<>'' THEN bill_date END) days
       FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?`
  ).get(branchId, prevStart, prevEnd) as { net: number; bills: number; pts: number; days: number };
  const prevNet = prev.bills > 0 ? round2(prev.net) : null;

  const topItems = (db.prepare(
    `SELECT i.name, ROUND(SUM(i.line_net),2) net, ROUND(SUM(i.qty),2) qty
       FROM clinica_bill_items i JOIN clinica_bills b ON b.id=i.bill_id
       WHERE b.branch_id=? AND b.bill_date BETWEEN ? AND ? AND COALESCE(i.name,'')<>''
       GROUP BY i.name ORDER BY net DESC LIMIT ?`
  ).all(branchId, start, end, topN) as NamedNet[]);

  return {
    weekStart: start, weekEnd: end,
    label: roundLabel(dayRows[0]?.date ?? start, dayRows[dayRows.length - 1]?.date ?? end),
    dayCount: dayRows.length,
    totalNet: round2(kpi.net), totalBills: kpi.bills, totalPatients: kpi.pts,
    avgPerDay: dayRows.length ? round2(kpi.net / dayRows.length) : null,
    bestDate: best?.date ?? null,
    days,
    prevWeekNet: prevNet, prevWeekDays: prev.days,
    // relPct already returns null when the base is null or 0, so no extra guard.
    wowNetPct: relPct(kpi.net, prevNet),
    wowBillsPct: relPct(kpi.bills, prev.bills),
    wowPatientsPct: relPct(kpi.pts, prev.pts),
    topItems,
  };
}
