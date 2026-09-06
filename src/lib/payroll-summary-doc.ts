// สร้างเอกสารสรุปค่าตอบแทนรายเดือน (payroll monthly summary document) — owner
// 2026-09-06. One source of truth behind the "สร้างเอกสาร" export in three
// formats (CSV / XLSX / PDF). The accountant reconciles against this, so it
// must carry: which company/branch, the pay rounds (รอบจ่าย) that landed in the
// month, and clearly-marked deduction columns (ปกส. / ภาษี / ประกันกลุ่ม).
//
// Figures mirror the on-screen summary exactly (page.tsx): per-employee totals
// accumulated across every pay round paying in the month, PLUS the service
// charge that hit the pocket that month (= the PREVIOUS month's accrual, paid
// ~the 20th). SVC is sourced from the SAME engine as the real payout
// (computeCompanySvcSummary for a company / computeMonthlySvcSummary for a
// single branch) so the document ties out to the ใบหัก ณ ที่จ่าย.

import type Database from "better-sqlite3";
import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { computeMonthlySvcSummary, computeCompanySvcSummary } from "./service-charge";

const round2 = (n: number) => Math.round(n * 100) / 100;

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

export function monthLabelTh(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return `${TH_MONTHS[m - 1]} ${y + 543}`;
}

function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

// ── Scope ────────────────────────────────────────────────────────────

export type ExportScope =
  | { kind: "all" }
  | { kind: "company"; id: number | null }
  | { kind: "branch"; id: number };

/** Parse the querystring scope token: "all" | "company:<id|null>" | "branch:<id>". */
export function parseScope(raw: string | null | undefined): ExportScope | null {
  if (!raw || raw === "all") return { kind: "all" };
  const [kind, idStr] = raw.split(":");
  if (kind === "company") {
    if (idStr === "null") return { kind: "company", id: null };
    const id = Number(idStr);
    return Number.isFinite(id) ? { kind: "company", id } : null;
  }
  if (kind === "branch") {
    const id = Number(idStr);
    return Number.isFinite(id) ? { kind: "branch", id } : null;
  }
  return null;
}

export function scopeToken(scope: ExportScope): string {
  if (scope.kind === "all") return "all";
  if (scope.kind === "company") return `company:${scope.id ?? "null"}`;
  return `branch:${scope.id}`;
}

export type ScopeOption = {
  value: string;              // token for parseScope
  label: string;              // display
  kind: "all" | "company" | "branch";
  companyKey?: number | null; // for nesting branches under their company
};

// Union of branches that either paid payroll this month or had SVC activity in
// the SVC month — same rule as the summary page, so nobody is dropped.
type BranchRow = {
  branch_id: number; branch_name: string;
  company_id: number | null; company_name: string | null;
};

function unionBranches(db: Database.Database, month: string): BranchRow[] {
  const { from, to } = monthRange(month);
  const svcMonth = shiftMonth(month, -1);
  const payroll = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
    FROM payroll_periods pp
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY b.id
  `).all(from, to) as BranchRow[];
  const svc = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
    FROM branches b
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE b.id IN (SELECT DISTINCT branch_id FROM daily_service_charge WHERE substr(date, 1, 7) = ?)
  `).all(svcMonth) as BranchRow[];
  const out: BranchRow[] = [];
  const seen = new Set<number>();
  for (const b of [...payroll, ...svc]) {
    if (seen.has(b.branch_id)) continue;
    seen.add(b.branch_id);
    out.push(b);
  }
  out.sort((a, b) =>
    (a.company_id == null ? 1 : 0) - (b.company_id == null ? 1 : 0)
    || (a.company_id ?? 0) - (b.company_id ?? 0)
    || a.branch_id - b.branch_id);
  return out;
}

/** Selectable export scopes for the month: ทุกบริษัท + each company + each branch. */
export function listExportScopes(db: Database.Database, month: string): ScopeOption[] {
  const branches = unionBranches(db, month);
  const opts: ScopeOption[] = [{ value: "all", label: "ทุกบริษัท (แยกส่วนในไฟล์เดียว)", kind: "all" }];
  const seenCompany = new Set<string>();
  // Group: company header option, then its branches.
  for (const b of branches) {
    const key = String(b.company_id);
    if (!seenCompany.has(key)) {
      seenCompany.add(key);
      opts.push({
        value: `company:${b.company_id ?? "null"}`,
        label: b.company_name ?? "ไม่ระบุบริษัท",
        kind: "company",
        companyKey: b.company_id
      });
    }
    opts.push({
      value: `branch:${b.branch_id}`,
      label: b.branch_name,
      kind: "branch",
      companyKey: b.company_id
    });
  }
  return opts;
}

// ── Document model ───────────────────────────────────────────────────

export type EmpDocRow = {
  userId: number;
  name: string;
  empTypeLabel: string;
  taxModeLabel: string;
  homeBranch: string;
  comp: number;         // ค่าตอบแทน (wage across all rounds)
  svcGross: number;     // เซอร์วิสชาร์จ (gross to the person)
  income: number;       // comp + svcGross
  sso: number;          // ประกันสังคม (deduction)
  tax: number;          // ภาษีหัก ณ ที่จ่าย incl. SVC WHT (deduction)
  gi: number;           // ประกันกลุ่ม (deduction)
  take: number;         // income − sso − tax − gi
  periodCount: number;
};

export type DocTotals = {
  comp: number; svcGross: number; income: number;
  sso: number; tax: number; gi: number; take: number;
};

export type PayRoundInfo = {
  cycleLabel: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  statusLabel: string;
  branchName: string | null;
  gross: number;
  net: number;
};

export type DocSection = {
  key: string;
  title: string;              // company or branch name
  taxId: string | null;       // company-level only
  address: string | null;
  rows: EmpDocRow[];
  totals: DocTotals;
  payRounds: PayRoundInfo[];
};

export type PayrollSummaryDoc = {
  month: string;              // YYYY-MM
  monthLabel: string;         // "กันยายน 2569"
  svcMonth: string;
  svcMonthLabel: string;
  scopeLabel: string;
  sections: DocSection[];
  grand: DocTotals;
};

const typeLabel = (t: string | null) =>
  t === "ft" ? "ประจำ (รายเดือน)" : t === "pt" ? "พาร์ทไทม์ (รายวัน)" : "อื่นๆ";
const taxLabel = (t: string | null) =>
  t === "sso" ? "ประกันสังคม" : t === "wht" ? "หัก ณ ที่จ่าย 3%" : "";
const statusLabel = (s: string) =>
  s === "paid" ? "จ่ายแล้ว" : s === "finalized" ? "ปิดรอบแล้ว" :
  s === "draft" ? "ฉบับร่าง" : s === "cancelled" ? "ยกเลิก" : s;
const cycleLabel = (cycle: string, target: string) =>
  cycle === "monthly" ? "รายเดือน (ประจำ)" : target === "pt" ? "รายวัน (พาร์ทไทม์)" : "รายสัปดาห์ (ประจำ)";

// Shape of the SVC row that both engine variants return (fields we consume).
type SvcRow = {
  userId: number; displayName: string; employmentType: string | null;
  taxMode: "sso" | "wht"; netAllocation: number; whtAmount: number;
  groupInsurance: number; netPayout: number;
};

type EmpAgg = {
  user_id: number; display_name: string; title_prefix: string | null;
  employment_type: "pt" | "ft" | null; salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number; total_sso: number; total_tax: number; period_count: number;
};

/** Merge a branch-set's payroll aggregate with its SVC rows into ordered doc rows + totals. */
function buildRowsAndTotals(
  db: Database.Database,
  range: { from: string; to: string },
  branchIds: number[],
  svcRows: SvcRow[],
  homeByUser: Map<number, string | null>
): { rows: EmpDocRow[]; totals: DocTotals } {
  const { from, to } = range;
  const empRows: EmpAgg[] = branchIds.length === 0 ? [] : (db.prepare(`
    SELECT pl.user_id, pl.display_name, u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           COUNT(*)           AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pp.id = pl.period_id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
      AND pp.branch_id IN (${branchIds.map(() => "?").join(",")})
    GROUP BY pl.user_id
  `).all(from, to, ...branchIds) as EmpAgg[]);

  const svcByUser = new Map<number, SvcRow & { gross: number; wht: number; gi: number; net: number }>();
  for (const r of svcRows) {
    if (!r.netAllocation && !r.netPayout) continue;
    const cur = svcByUser.get(r.userId)
      ?? { ...r, gross: 0, wht: 0, gi: 0, net: 0 };
    cur.gross += r.netAllocation; cur.wht += r.whtAmount;
    cur.gi += r.groupInsurance; cur.net += r.netPayout;
    svcByUser.set(r.userId, cur);
  }

  const rows: EmpDocRow[] = [];
  const payrollIds = new Set<number>();
  const mkFigures = (
    userId: number, name: string, emp: string | null, tax: string | null,
    comp: number, ssoRaw: number, taxRaw: number, periodCount: number
  ): EmpDocRow => {
    const svc = svcByUser.get(userId);
    const svcGross = svc?.gross ?? 0;
    const income = round2(comp + svcGross);
    const sso = round2(ssoRaw);
    const taxTotal = round2(taxRaw + (svc?.wht ?? 0));
    const gi = round2(svc?.gi ?? 0);
    return {
      userId, name,
      empTypeLabel: typeLabel(emp), taxModeLabel: taxLabel(tax),
      homeBranch: homeByUser.get(userId) ?? "—",
      comp: round2(comp), svcGross: round2(svcGross), income,
      sso, tax: taxTotal, gi, take: round2(income - sso - taxTotal - gi),
      periodCount
    };
  };

  for (const r of empRows) {
    payrollIds.add(r.user_id);
    rows.push(mkFigures(
      r.user_id, nameWithPrefix(r.title_prefix, r.display_name),
      r.employment_type, r.salary_tax_mode_snapshot,
      r.total_gross ?? 0, r.total_sso ?? 0, r.total_tax ?? 0, r.period_count ?? 0
    ));
  }
  // SVC-only people (no payroll round this month) — zero-wage row so their SVC +
  // its WHT still land on the sheet.
  for (const [uid, s] of svcByUser) {
    if (payrollIds.has(uid)) continue;
    rows.push(mkFigures(uid, s.displayName, s.employmentType, s.taxMode, 0, 0, 0, 0));
  }

  const rank = (t: string) => (t.startsWith("ประจำ") ? 0 : t.startsWith("พาร์ท") ? 1 : 2);
  rows.sort((a, b) => rank(a.empTypeLabel) - rank(b.empTypeLabel) || a.name.localeCompare(b.name, "th"));

  const totals = rows.reduce<DocTotals>((acc, r) => ({
    comp: round2(acc.comp + r.comp), svcGross: round2(acc.svcGross + r.svcGross),
    income: round2(acc.income + r.income), sso: round2(acc.sso + r.sso),
    tax: round2(acc.tax + r.tax), gi: round2(acc.gi + r.gi), take: round2(acc.take + r.take)
  }), { comp: 0, svcGross: 0, income: 0, sso: 0, tax: 0, gi: 0, take: 0 });

  return { rows, totals };
}

// Pay rounds contributing to a branch-set in the month — the reconciliation key.
function buildPayRounds(
  db: Database.Database, range: { from: string; to: string }, branchIds: number[]
): PayRoundInfo[] {
  if (branchIds.length === 0) return [];
  const { from, to } = range;
  const rows = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status,
           b.name AS branch_name,
           (SELECT SUM(gross_pay) FROM payroll_lines WHERE period_id = p.id) AS gross,
           (SELECT SUM(net_pay)   FROM payroll_lines WHERE period_id = p.id) AS net
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.pay_date >= ? AND p.pay_date <= ?
      AND p.branch_id IN (${branchIds.map(() => "?").join(",")})
    ORDER BY p.pay_date, p.id
  `).all(from, to, ...branchIds) as Array<{
    id: number; cycle: string; target: string; period_start: string; period_end: string;
    pay_date: string; status: string; branch_name: string | null; gross: number | null; net: number | null;
  }>;
  return rows.map((p) => ({
    cycleLabel: cycleLabel(p.cycle, p.target),
    periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date,
    statusLabel: statusLabel(p.status), branchName: p.branch_name,
    gross: round2(p.gross ?? 0), net: round2(p.net ?? 0)
  }));
}

function companyInfo(db: Database.Database, companyId: number | null) {
  if (companyId == null) return { name: "ไม่ระบุบริษัท", taxId: null as string | null, address: null as string | null };
  const c = db.prepare("SELECT name_th, tax_id, address FROM companies WHERE id = ?")
    .get(companyId) as { name_th: string; tax_id: string | null; address: string | null } | undefined;
  return { name: c?.name_th ?? "ไม่ระบุบริษัท", taxId: c?.tax_id ?? null, address: c?.address ?? null };
}

function svcRowsForCompany(companyId: number, svcMonth: string): SvcRow[] {
  try { return computeCompanySvcSummary(companyId, svcMonth).rows as unknown as SvcRow[]; }
  catch { return []; }
}
function svcRowsForBranch(branchId: number, svcMonth: string): SvcRow[] {
  try { return computeMonthlySvcSummary(branchId, svcMonth).rows as unknown as SvcRow[]; }
  catch { return []; }
}

/**
 * Build the full export document for a month + scope. Pure of Date (labels are
 * derived from the month string); the generated-at stamp is added by the route.
 */
export function buildPayrollSummaryDoc(month: string, scope: ExportScope): PayrollSummaryDoc {
  const db = getDb();
  const range = monthRange(month);
  const svcMonth = shiftMonth(month, -1);
  const branches = unionBranches(db, month);

  // สังกัด (home branch) per user — is_primary=1 else lowest branch_id.
  const homeRows = db.prepare(`
    SELECT ub.user_id,
           (SELECT name FROM branches WHERE id = COALESCE(
              (SELECT branch_id FROM user_branches WHERE user_id = ub.user_id AND is_primary = 1 LIMIT 1),
              (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ub.user_id))) AS home_branch_name
    FROM (SELECT DISTINCT user_id FROM user_branches) ub
  `).all() as Array<{ user_id: number; home_branch_name: string | null }>;
  const homeByUser = new Map<number, string | null>();
  for (const r of homeRows) homeByUser.set(r.user_id, r.home_branch_name);

  const sections: DocSection[] = [];

  const addCompanySection = (companyId: number | null) => {
    const compBranches = branches.filter((b) => b.company_id === companyId);
    if (compBranches.length === 0) return;
    const branchIds = compBranches.map((b) => b.branch_id);
    const svcRows = companyId != null
      ? svcRowsForCompany(companyId, svcMonth)
      : compBranches.flatMap((b) => svcRowsForBranch(b.branch_id, svcMonth));
    const { rows, totals } = buildRowsAndTotals(db, range, branchIds, svcRows, homeByUser);
    const info = companyInfo(db, companyId);
    sections.push({
      key: `company:${companyId ?? "null"}`,
      title: info.name, taxId: info.taxId, address: info.address,
      rows, totals, payRounds: buildPayRounds(db, range, branchIds)
    });
  };

  const addBranchSection = (branchId: number) => {
    const b = branches.find((x) => x.branch_id === branchId)
      ?? (db.prepare(`SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
            FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?`).get(branchId) as BranchRow | undefined);
    if (!b) return;
    const svcRows = svcRowsForBranch(branchId, svcMonth);
    const { rows, totals } = buildRowsAndTotals(db, range, [branchId], svcRows, homeByUser);
    const info = companyInfo(db, b.company_id);
    sections.push({
      key: `branch:${branchId}`,
      title: `${b.branch_name}${b.company_name ? ` · ${b.company_name}` : ""}`,
      taxId: info.taxId, address: info.address,
      rows, totals, payRounds: buildPayRounds(db, range, [branchId])
    });
  };

  let scopeLabel = "ทุกบริษัท";
  if (scope.kind === "all") {
    const companyKeys: Array<number | null> = [];
    for (const b of branches) if (!companyKeys.includes(b.company_id)) companyKeys.push(b.company_id);
    for (const ck of companyKeys) addCompanySection(ck);
  } else if (scope.kind === "company") {
    addCompanySection(scope.id);
    scopeLabel = companyInfo(db, scope.id).name;
  } else {
    addBranchSection(scope.id);
    scopeLabel = sections[0]?.title ?? "สาขา";
  }

  const grand = sections.reduce<DocTotals>((acc, s) => ({
    comp: round2(acc.comp + s.totals.comp), svcGross: round2(acc.svcGross + s.totals.svcGross),
    income: round2(acc.income + s.totals.income), sso: round2(acc.sso + s.totals.sso),
    tax: round2(acc.tax + s.totals.tax), gi: round2(acc.gi + s.totals.gi), take: round2(acc.take + s.totals.take)
  }), { comp: 0, svcGross: 0, income: 0, sso: 0, tax: 0, gi: 0, take: 0 });

  return {
    month, monthLabel: monthLabelTh(month),
    svcMonth, svcMonthLabel: monthLabelTh(svcMonth),
    scopeLabel, sections, grand
  };
}

// ── Column definitions shared by the renderers ───────────────────────
// Deduction columns are flagged so every format marks them consistently
// (header carries "(หัก)" and the value is shown negative).

export type DocColumn = {
  key: keyof EmpDocRow;
  header: string;
  kind: "text" | "money" | "deduction" | "count";
};

export const DOC_COLUMNS: DocColumn[] = [
  { key: "name", header: "ชื่อ-นามสกุล", kind: "text" },
  { key: "empTypeLabel", header: "ประเภทจ้าง", kind: "text" },
  { key: "taxModeLabel", header: "รูปแบบภาษี", kind: "text" },
  { key: "homeBranch", header: "สังกัด", kind: "text" },
  { key: "comp", header: "ค่าตอบแทน", kind: "money" },
  { key: "svcGross", header: "เซอร์วิสชาร์จ", kind: "money" },
  { key: "income", header: "รวมรายรับ", kind: "money" },
  { key: "sso", header: "ประกันสังคม (หัก)", kind: "deduction" },
  { key: "tax", header: "ภาษี ณ ที่จ่าย (หัก)", kind: "deduction" },
  { key: "gi", header: "ประกันกลุ่ม (หัก)", kind: "deduction" },
  { key: "take", header: "รวมรับจริง", kind: "money" },
  { key: "periodCount", header: "จำนวนรอบจ่าย", kind: "count" }
];

// ── CSV renderer ─────────────────────────────────────────────────────
// Multi-section CSV: a document header, then per section a pay-round block
// (for reconciliation) and the employee table. Deduction cells are written as
// negative numbers so a spreadsheet SUM nets out correctly.

function csvEsc(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvCell(r: EmpDocRow, col: DocColumn): string {
  const v = r[col.key];
  if (col.kind === "text") return String(v ?? "");
  if (col.kind === "count") return String(v ?? 0);
  const n = Number(v) || 0;
  if (col.kind === "deduction") return n > 0 ? (-n).toFixed(2) : "0.00";
  return n.toFixed(2);
}

export function renderPayrollSummaryCsv(
  doc: PayrollSummaryDoc, generatedLabel: string, note?: string | null
): string {
  const lines: string[] = [];
  const push = (...cells: (string | number)[]) => lines.push(cells.map(csvEsc).join(","));

  push("เอกสารสรุปค่าตอบแทนรายเดือน");
  push("ขอบเขต", doc.scopeLabel);
  push("เดือนที่จ่าย", doc.monthLabel);
  push("เซอร์วิสชาร์จของเดือน", doc.svcMonthLabel);
  push("ออกเอกสารเมื่อ", generatedLabel);
  if (note && note.trim()) push("หมายเหตุ", note.trim());
  push("หมายเหตุการอ่าน", "คอลัมน์ที่มี (หัก) เป็นรายการหัก แสดงเป็นค่าติดลบ");
  lines.push("");

  for (const s of doc.sections) {
    push(`=== ${s.title} ===`);
    if (s.taxId) push("เลขประจำตัวผู้เสียภาษี", s.taxId);
    if (s.address) push("ที่อยู่", s.address);

    // Pay-round block (รอบจ่าย) for the accountant's reconciliation.
    push("รอบจ่ายที่กระทบยอดในเดือนนี้");
    push("ประเภทรอบ", "ช่วงงวด", "วันจ่าย", "สถานะ", "สาขา", "ยอดจ่ายรวม", "ยอดสุทธิ");
    if (s.payRounds.length === 0) push("— ไม่มีรอบจ่ายในเดือนนี้ (มีเฉพาะเซอร์วิสชาร์จ) —");
    for (const p of s.payRounds) {
      push(p.cycleLabel, `${p.periodStart} ถึง ${p.periodEnd}`, p.payDate, p.statusLabel,
        p.branchName ?? "", p.gross.toFixed(2), p.net.toFixed(2));
    }
    lines.push("");

    // Employee table.
    push(...DOC_COLUMNS.map((c) => c.header));
    for (const r of s.rows) push(...DOC_COLUMNS.map((c) => csvCell(r, c)));
    // Section totals.
    const t = s.totals;
    push("รวม", "", "", "",
      t.comp.toFixed(2), t.svcGross.toFixed(2), t.income.toFixed(2),
      t.sso > 0 ? (-t.sso).toFixed(2) : "0.00",
      t.tax > 0 ? (-t.tax).toFixed(2) : "0.00",
      t.gi > 0 ? (-t.gi).toFixed(2) : "0.00",
      t.take.toFixed(2), "");
    lines.push("");
  }

  if (doc.sections.length > 1) {
    const g = doc.grand;
    push("รวมทั้งหมด (ทุกส่วน)", "", "", "",
      g.comp.toFixed(2), g.svcGross.toFixed(2), g.income.toFixed(2),
      g.sso > 0 ? (-g.sso).toFixed(2) : "0.00",
      g.tax > 0 ? (-g.tax).toFixed(2) : "0.00",
      g.gi > 0 ? (-g.gi).toFixed(2) : "0.00",
      g.take.toFixed(2), "");
  }

  return "﻿" + lines.join("\r\n"); // BOM so Excel reads Thai UTF-8
}
