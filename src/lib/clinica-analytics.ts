// CLINICA analytics (owner 2026-09-26) — the clinic section of ANALYTICA, from
// the imported HIS data. Headline is ยอดบิลรวม (billed net), split into เงินเข้า
// จริง (paid: cash + PromptPay) vs รอเบิกประกัน (due: AR). Plus payer/AR aging,
// revenue by category, top drugs/labs, diagnoses, doctors and peak hours. Every
// money figure carries its count (ครั้ง) for the parenthesised display.

import { getDb } from "./db";

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
function relPct(cur: number, base: number | null): number | null {
  return base != null && base > 0 ? round2(((cur - base) / base) * 100) : null;
}
function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthBounds(y: number, m: number): [string, string] {
  const mm = String(m).padStart(2, "0");
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(daysInMonth(y, m)).padStart(2, "0")}`];
}

export type PayerRow = { group: string; net: number; count: number; paid: number; due: number };
export type AmountCount = { net: number; count: number };
export type CatRow = { key: string; label: string; net: number; count: number };
export type NamedNet = { name: string; net: number; qty: number };
export type NamedCount = { name: string; count: number };
export type HourCount = { hour: number; count: number };

export type ClinicaMonth = {
  year: number; month: number;
  hasData: boolean;
  // headline (this month's bills)
  billNet: number; billCount: number; patientCount: number; avgPerBill: number | null;
  paid: number; due: number;                 // เงินเข้าจริง / รอเบิก จากบิลเดือนนี้
  prevBillNet: number | null; billNetMomPct: number | null;
  // payer mix (this month)
  payers: PayerRow[];
  // AR — outstanding across ALL periods as of today (not month-scoped)
  arTotal: number;
  arByPayer: PayerRow[];                      // unpaid payers, biggest owing first
  arAging: { d0_30: number; d31_60: number; d61_90: number; d90p: number }; // age = today − bill_date
  // revenue structure
  categories: CatRow[];
  topItems: NamedNet[];
  // clinical
  visitCount: number; visitPatientCount: number;
  topDiagnoses: NamedCount[];
  doctors: NamedCount[];
  hours: HourCount[];                         // bills by clock hour
};

const CAT_LABEL: Record<string, string> = { service: "ค่าบริการ/ตรวจ", drug: "ยา", lab: "แล็บ", package: "แพ็กเกจตรวจสุขภาพ", other: "อื่นๆ" };

/** Full clinic analytics for a month. `asOf` (Bangkok YYYY-MM-DD) anchors AR
 *  aging; defaults to the month end. */
export function clinicaMonth(branchId: number, year: number, month: number, asOf?: string): ClinicaMonth {
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
  const arByPayer = (db.prepare(
    `SELECT COALESCE(NULLIF(payer_group,''),'(ไม่ระบุ)') grp, ROUND(SUM(net),2) net, COUNT(*) cnt,
            ROUND(SUM(paid),2) paid, ROUND(SUM(due),2) due
       FROM clinica_bills WHERE branch_id=? AND due>0.005 GROUP BY grp ORDER BY due DESC`
  ).all(branchId) as Array<{ grp: string; net: number; cnt: number; paid: number; due: number }>)
    .map((r) => ({ group: r.grp, net: r.net, count: r.cnt, paid: r.paid, due: r.due }));
  const arTotal = round2(arByPayer.reduce((s, p) => s + p.due, 0));

  // AR aging by how long each unpaid bill has been outstanding (asOf − bill_date).
  const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  const asOfMs = new Date(`${asOfDate}T00:00:00Z`).getTime();
  for (const r of db.prepare(
    `SELECT bill_date, due FROM clinica_bills WHERE branch_id=? AND due>0.005 AND bill_date<>''`
  ).all(branchId) as Array<{ bill_date: string; due: number }>) {
    const days = Math.floor((asOfMs - new Date(`${r.bill_date}T00:00:00Z`).getTime()) / 86_400_000);
    if (days <= 30) aging.d0_30 += r.due;
    else if (days <= 60) aging.d31_60 += r.due;
    else if (days <= 90) aging.d61_90 += r.due;
    else aging.d90p += r.due;
  }
  (Object.keys(aging) as Array<keyof typeof aging>).forEach((k) => { aging[k] = round2(aging[k]); });

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

  return {
    year, month,
    hasData: kpi.bills > 0 || visits.v > 0,
    billNet: round2(kpi.net), billCount: kpi.bills, patientCount: kpi.pts,
    avgPerBill: kpi.bills > 0 ? round2(kpi.net / kpi.bills) : null,
    paid: round2(kpi.paid), due: round2(kpi.due),
    prevBillNet, billNetMomPct: relPct(kpi.net, prevBillNet),
    payers, arTotal, arByPayer, arAging: aging,
    categories, topItems,
    visitCount: visits.v, visitPatientCount: visits.pts,
    topDiagnoses, doctors, hours
  };
}
