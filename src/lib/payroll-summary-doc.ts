// สร้างเอกสารสรุปค่าตอบแทนรายเดือน (payroll monthly summary document).
// One source of truth behind the "สร้างเอกสาร" export in three formats
// (CSV / XLSX / PDF) that the accounting office reconciles against.
//
// Owner 2026-09-06, Phase 1 — company-level numbers, split by branch heading:
//   • The authoritative figures are computed at the WHOLE-COMPANY level (SVC via
//     computeCompanySvcSummary — the company รวมกอง/roll-up engine, NOT the
//     per-branch one), because per-branch vs combined totals otherwise disagree
//     and confuse the books.
//   • The document then SPLITS the display by branch heading (สาขา) so posting
//     into accounta stays correctly separated.
//   • It is strictly READ-ONLY: it reflects the payroll lines exactly as stored
//     (net from net_pay), so a round that is already finalized/posted is never
//     recomputed or altered — only computed value here is the display-side SVC.
//   • Owner 2026-10-01: the per-person figures come from monthlyPayrollRollup —
//     the SAME data set the summary page and the monthly payslip read — so the
//     exported sheet ties out to every screen to the satang.
//
// Layout: per company → per branch heading → (a) รอบจ่าย broken down per person
// (ยอดก่อนหัก → หัก → สุทธิ) and (b) a final per-person rollup for the month
// (ค่าตอบแทนทุกรอบ + เซอร์วิสชาร์จระดับบริษัท), with the deduction columns marked.

import type Database from "better-sqlite3";
import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { monthlyPayrollRollup, type MonthBranch, type MonthPerson, type MonthRollup } from "./payroll-month";

const round2 = (n: number) => Math.round(n * 100) / 100;

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

export function monthLabelTh(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return `${TH_MONTHS[m - 1]} พ.ศ. ${y + 543}`;
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
  value: string;
  label: string;
  kind: "all" | "company" | "branch";
  companyKey?: number | null;
};

/** Branches in scope for the month (payroll ∪ SVC ∪ meeting-fee), from the shared rollup. */
function monthBranches(db: Database.Database, month: string, rollup?: MonthRollup): MonthBranch[] {
  return (rollup ?? monthlyPayrollRollup(db, month)).branches;
}

/** Selectable export scopes for the month: ทุกบริษัท + each company + each branch. */
export function listExportScopes(db: Database.Database, month: string, rollup?: MonthRollup): ScopeOption[] {
  const branches = monthBranches(db, month, rollup);
  const opts: ScopeOption[] = [{ value: "all", label: "ทุกบริษัท (แยกหัวข้อสาขาในไฟล์เดียว)", kind: "all" }];
  const seenCompany = new Set<string>();
  for (const b of branches) {
    const key = String(b.companyId);
    if (!seenCompany.has(key)) {
      seenCompany.add(key);
      opts.push({
        value: `company:${b.companyId ?? "null"}`,
        label: b.companyName ?? "ไม่ระบุบริษัท",
        kind: "company", companyKey: b.companyId
      });
    }
    opts.push({ value: `branch:${b.branchId}`, label: b.branchName, kind: "branch", companyKey: b.companyId });
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
  comp: number;        // ค่าตอบแทน (payroll gross, all rounds this month)
  svcGross: number;    // เซอร์วิสชาร์จ (company-level gross to the person)
  mtgGross: number;    // เบี้ยประชุม paid with the SVC round (owner 2026-10-01)
  income: number;      // ยอดก่อนหัก = comp + svcGross + mtgGross
  sso: number;         // ประกันสังคม (หัก)
  tax: number;         // ภาษี ณ ที่จ่าย incl. SVC + meeting-fee WHT (หัก)
  gi: number;          // ประกันกลุ่ม (หัก)
  other: number;       // หักอื่นๆ (เครื่องดื่ม/มื้ออาหาร ฯลฯ ในรอบจ่าย)
  deduction: number;   // รวมหัก
  take: number;        // รวมรับจริง = income − deduction
  periodCount: number;
};

export type DocTotals = {
  comp: number; svcGross: number; mtgGross: number; income: number;
  sso: number; tax: number; gi: number; other: number; deduction: number; take: number;
};

export type PayRoundInfo = {
  cycle: "monthly" | "weekly";
  cycleLabel: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  statusLabel: string;
  branchName: string | null;
  gross: number;
  net: number;
};

/** One person's line within a single pay round: ก่อนหัก → หัก → สุทธิ, with the
 *  deduction split so the accounting office sees who had ประกันสังคม vs หัก ณ
 *  ที่จ่าย (owner 2026-09-14). */
export type RoundMember = {
  userId: number;
  name: string;
  homeBranch: string;
  before: number;      // ยอดก่อนหัก = gross_pay ของรอบนั้น (ตามที่บันทึกไว้)
  sso: number;         // ประกันสังคม (จาก sso_amount)
  tax: number;         // ภาษีหัก ณ ที่จ่าย (จาก tax_amount)
  other: number;       // หักอื่นๆ ในรอบ (เครื่องดื่ม/มื้ออาหาร ฯลฯ)
  deduction: number;   // ยอดหักรวม = gross_pay − net_pay (สะท้อนยอดที่ลงบัญชีจริง)
  net: number;         // ยอดสุทธิ = net_pay
};

export type PayRoundGroup = {
  info: PayRoundInfo;
  members: RoundMember[];
  before: number; sso: number; tax: number; other: number; deduction: number; net: number;
};

/** A branch heading inside a company: its pay rounds + its people's rollup. */
export type BranchBlock = {
  branchId: number | null;
  branchName: string;
  roundGroups: PayRoundGroup[];
  rollup: EmpDocRow[];      // people whose home branch = this branch (company-wide figures)
  totals: DocTotals;
};

export type CompanyDoc = {
  key: string;
  name: string;
  taxId: string | null;
  address: string | null;
  branches: BranchBlock[];
  totals: DocTotals;
};

export type PayrollSummaryDoc = {
  month: string;
  monthLabel: string;
  svcMonth: string;
  svcMonthLabel: string;
  scopeLabel: string;
  companies: CompanyDoc[];
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

const zeroTotals = (): DocTotals =>
  ({ comp: 0, svcGross: 0, mtgGross: 0, income: 0, sso: 0, tax: 0, gi: 0, other: 0, deduction: 0, take: 0 });
function addRowToTotals(t: DocTotals, r: EmpDocRow) {
  t.comp = round2(t.comp + r.comp); t.svcGross = round2(t.svcGross + r.svcGross);
  t.mtgGross = round2(t.mtgGross + r.mtgGross);
  t.income = round2(t.income + r.income); t.sso = round2(t.sso + r.sso);
  t.tax = round2(t.tax + r.tax); t.gi = round2(t.gi + r.gi);
  t.other = round2(t.other + r.other); t.deduction = round2(t.deduction + r.deduction);
  t.take = round2(t.take + r.take);
}

function companyInfo(db: Database.Database, companyId: number | null) {
  if (companyId == null) return { name: "ไม่ระบุบริษัท", taxId: null as string | null, address: null as string | null };
  const c = db.prepare("SELECT name_th, tax_id, address FROM companies WHERE id = ?")
    .get(companyId) as { name_th: string; tax_id: string | null; address: string | null } | undefined;
  return { name: c?.name_th ?? "ไม่ระบุบริษัท", taxId: c?.tax_id ?? null, address: c?.address ?? null };
}

/** One export row from the shared monthly rollup — no arithmetic of its own, so the
 *  sheet shows exactly what the summary page / payslip show. หักอื่นๆ = everything
 *  withheld inside the pay rounds (drink / mealpass / other), derived from the
 *  stored net; รวมรับจริง = ยอดก่อนหัก − รวมหัก. */
function docRowFrom(p: MonthPerson): EmpDocRow {
  return {
    userId: p.userId, name: p.name,
    empTypeLabel: typeLabel(p.employmentType), taxModeLabel: taxLabel(p.taxMode),
    homeBranch: p.homeBranch ?? "—",
    comp: p.comp, svcGross: p.svcGross, mtgGross: p.mtgGross, income: p.income,
    sso: p.sso, tax: p.tax, gi: p.gi, other: p.inRound, deduction: p.ded, take: p.take,
    periodCount: p.periodCount
  };
}

const rowRank = (r: EmpDocRow) => (r.empTypeLabel.startsWith("ประจำ") ? 0 : r.empTypeLabel.startsWith("พาร์ท") ? 1 : 2);

/** Pay-round groups (with member breakdown) for one branch. */
function buildRoundGroups(
  db: Database.Database, range: { from: string; to: string },
  branchId: number, homeByUser: Map<number, string | null>
): PayRoundGroup[] {
  const periods = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status, b.name AS branch_name
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.pay_date >= ? AND p.pay_date <= ? AND p.branch_id = ?
    ORDER BY (p.cycle = 'monthly') DESC, p.pay_date, p.id
  `).all(range.from, range.to, branchId) as Array<{
    id: number; cycle: "monthly" | "weekly"; target: string; period_start: string;
    period_end: string; pay_date: string; status: string; branch_name: string | null;
  }>;
  const groups: PayRoundGroup[] = [];
  for (const p of periods) {
    const lines = db.prepare(`
      SELECT pl.user_id, pl.display_name, u.title_prefix, pl.employment_type,
             pl.gross_pay, pl.net_pay, pl.sso_amount, pl.tax_amount
      FROM payroll_lines pl LEFT JOIN users u ON u.id = pl.user_id
      WHERE pl.period_id = ?
      ORDER BY (pl.employment_type = 'ft') DESC, pl.display_name
    `).all(p.id) as Array<{
      user_id: number; display_name: string; title_prefix: string | null;
      employment_type: string | null; gross_pay: number | null; net_pay: number | null;
      sso_amount: number | null; tax_amount: number | null;
    }>;
    const members: RoundMember[] = [];
    let before = 0, sso = 0, tax = 0, other = 0, deduction = 0, net = 0;
    for (const l of lines) {
      const b = round2(l.gross_pay ?? 0), n = round2(l.net_pay ?? 0);
      if (b === 0 && n === 0) continue; // skip zero-noise rows (e.g. FT at a non-home branch)
      const d = round2(b - n);
      const mSso = round2(l.sso_amount ?? 0);
      const mTax = round2(l.tax_amount ?? 0);
      // อื่นๆ = whatever the round withheld beyond ประกันสังคม + ภาษี (drink/meal/…),
      // derived from the stored net so the three columns always reconcile to หักรวม.
      const mOther = round2(Math.max(0, d - mSso - mTax));
      members.push({
        userId: l.user_id, name: nameWithPrefix(l.title_prefix, l.display_name),
        homeBranch: homeByUser.get(l.user_id) ?? "—",
        before: b, sso: mSso, tax: mTax, other: mOther, deduction: d, net: n
      });
      before = round2(before + b); sso = round2(sso + mSso); tax = round2(tax + mTax);
      other = round2(other + mOther); deduction = round2(deduction + d); net = round2(net + n);
    }
    groups.push({
      info: {
        cycle: p.cycle, cycleLabel: cycleLabel(p.cycle, p.target),
        periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date,
        statusLabel: statusLabel(p.status), branchName: p.branch_name, gross: before, net
      },
      members, before, sso, tax, other, deduction, net
    });
  }
  return groups;
}

/**
 * Build the export document for a month + scope. Pure of Date (labels derive
 * from the month string); the generated-at stamp is added by the route.
 */
export function buildPayrollSummaryDoc(month: string, scope: ExportScope): PayrollSummaryDoc {
  const db = getDb();
  const rollup = monthlyPayrollRollup(db, month);
  const range = { from: rollup.from, to: rollup.to };
  const svcMonth = rollup.svcMonth;
  const branches = rollup.branches;
  const homeByUser = rollup.homeByUser;

  // Which companies + (optional) single-branch filter the scope asks for.
  let companyKeys: Array<number | null>;
  let branchFilter: number | null = null;
  let scopeLabel = "ทุกบริษัท";
  if (scope.kind === "all") {
    companyKeys = rollup.companies.map((c) => c.key);
  } else if (scope.kind === "company") {
    companyKeys = [scope.id];
    scopeLabel = companyInfo(db, scope.id).name;
  } else {
    const b = branches.find((x) => x.branchId === scope.id)
      ?? (db.prepare(`SELECT b.id AS branchId, b.name AS branchName, b.company_id AS companyId, c.name_th AS companyName
            FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?`).get(scope.id) as MonthBranch | undefined);
    companyKeys = [b?.companyId ?? null];
    branchFilter = scope.id;
    scopeLabel = b ? `${b.branchName}${b.companyName ? ` · ${b.companyName}` : ""}` : "สาขา";
  }

  const companies: CompanyDoc[] = [];
  for (const ck of companyKeys) {
    const compBranches = branches.filter((b) => b.companyId === ck);
    // Company-wide per-person rows — the shared rollup (payroll + company SVC + เบี้ยประชุม).
    const companyRows = (rollup.byCompany.get(ck) ?? []).map(docRowFrom);
    if (compBranches.length === 0 && companyRows.length === 0) continue;
    const rowsByHome = new Map<string, EmpDocRow[]>();
    for (const r of companyRows) {
      const arr = rowsByHome.get(r.homeBranch) ?? [];
      arr.push(r); rowsByHome.set(r.homeBranch, arr);
    }

    const blocks: BranchBlock[] = [];
    const shown = branchFilter != null ? compBranches.filter((b) => b.branchId === branchFilter) : compBranches;
    const claimed = new Set<number>();
    for (const b of shown) {
      const roundGroups = buildRoundGroups(db, range, b.branchId, homeByUser);
      const rollupRows = (rowsByHome.get(b.branchName) ?? []).slice()
        .sort((x, y) => rowRank(x) - rowRank(y) || x.name.localeCompare(y.name, "th"));
      for (const r of rollupRows) claimed.add(r.userId);
      if (roundGroups.length === 0 && rollupRows.length === 0) continue;
      const totals = zeroTotals();
      for (const r of rollupRows) addRowToTotals(totals, r);
      blocks.push({ branchId: b.branchId, branchName: b.branchName, roundGroups, rollup: rollupRows, totals });
    }
    // People whose home branch isn't among the shown branches (rotators homed
    // elsewhere) — only when not filtering to one branch, so the company total ties.
    if (branchFilter == null) {
      const leftover = companyRows.filter((r) => !claimed.has(r.userId));
      const byHome = new Map<string, EmpDocRow[]>();
      for (const r of leftover) { const a = byHome.get(r.homeBranch) ?? []; a.push(r); byHome.set(r.homeBranch, a); }
      for (const [home, rows] of byHome) {
        rows.sort((x, y) => rowRank(x) - rowRank(y) || x.name.localeCompare(y.name, "th"));
        const totals = zeroTotals();
        for (const r of rows) addRowToTotals(totals, r);
        blocks.push({ branchId: null, branchName: home, roundGroups: [], rollup: rows, totals });
      }
    }
    if (blocks.length === 0) continue;

    const info = companyInfo(db, ck);
    const cTotals = zeroTotals();
    for (const bl of blocks) for (const r of bl.rollup) addRowToTotals(cTotals, r);
    companies.push({ key: `company:${ck ?? "null"}`, name: info.name, taxId: info.taxId, address: info.address, branches: blocks, totals: cTotals });
  }

  const grand = zeroTotals();
  for (const c of companies) for (const bl of c.branches) for (const r of bl.rollup) addRowToTotals(grand, r);

  return {
    month, monthLabel: monthLabelTh(month),
    svcMonth, svcMonthLabel: monthLabelTh(svcMonth),
    scopeLabel, companies, grand
  };
}

// ── Rollup column defs shared by the renderers ───────────────────────
export type DocColumn = { key: keyof EmpDocRow; header: string; kind: "text" | "money" | "deduction" | "count" };

export const ROLLUP_COLUMNS: DocColumn[] = [
  { key: "name", header: "ชื่อ-นามสกุล", kind: "text" },
  { key: "empTypeLabel", header: "ประเภทจ้าง", kind: "text" },
  { key: "comp", header: "ค่าตอบแทน", kind: "money" },
  { key: "svcGross", header: "เซอร์วิสชาร์จ", kind: "money" },
  { key: "mtgGross", header: "เบี้ยประชุม", kind: "money" },
  { key: "income", header: "ยอดก่อนหัก", kind: "money" },
  { key: "sso", header: "ประกันสังคม (หัก)", kind: "deduction" },
  { key: "tax", header: "ภาษี ณ ที่จ่าย (หัก)", kind: "deduction" },
  { key: "gi", header: "ประกันกลุ่ม (หัก)", kind: "deduction" },
  { key: "other", header: "หักอื่นๆ (หัก)", kind: "deduction" },
  { key: "deduction", header: "รวมหัก", kind: "deduction" },
  { key: "take", header: "ยอดสุทธิ", kind: "money" },
  { key: "periodCount", header: "รอบ", kind: "count" }
];

// ── CSV renderer ─────────────────────────────────────────────────────

function csvEsc(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** A deduction cell: shown as a negative when > 0, else "0.00". */
function negCell(n: number): string {
  return n > 0 ? (-n).toFixed(2) : "0.00";
}
function rollupCell(r: EmpDocRow, col: DocColumn): string {
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

  push("เอกสารสรุปค่าตอบแทนรายเดือน (คำนวณระดับบริษัท · แยกหัวข้อสาขา)");
  push("ขอบเขต", doc.scopeLabel);
  push("เดือนที่จ่าย", doc.monthLabel);
  push("เซอร์วิสชาร์จของเดือน", doc.svcMonthLabel);
  push("ออกเอกสารเมื่อ", generatedLabel);
  if (note && note.trim()) push("หมายเหตุ", note.trim());
  push("การอ่าน", "เซอร์วิสชาร์จคำนวณระดับบริษัท · คอลัมน์ที่มี (หัก) แสดงเป็นค่าติดลบ");
  lines.push("");

  for (const c of doc.companies) {
    push(`บริษัท: ${c.name}`);
    if (c.taxId) push("เลขประจำตัวผู้เสียภาษี", c.taxId);
    if (c.address) push("ที่อยู่", c.address);
    lines.push("");

    for (const bl of c.branches) {
      push(`◆ สาขา: ${bl.branchName}`);

      // Per-round breakdown.
      for (const g of bl.roundGroups) {
        push(`  รอบจ่าย: ${g.info.cycleLabel} · งวด ${g.info.periodStart} ถึง ${g.info.periodEnd} · จ่าย ${g.info.payDate} · ${g.info.statusLabel}`);
        push("  ชื่อ-นามสกุล", "สังกัด", "ยอดก่อนหัก", "ประกันสังคม", "ภาษีหัก ณ ที่จ่าย", "หักอื่นๆ", "ยอดสุทธิ");
        for (const m of g.members) {
          push("  " + m.name, m.homeBranch, m.before.toFixed(2), negCell(m.sso), negCell(m.tax), negCell(m.other), m.net.toFixed(2));
        }
        push("  รวมรอบ", "", g.before.toFixed(2), negCell(g.sso), negCell(g.tax), negCell(g.other), g.net.toFixed(2));
        lines.push("");
      }
      if (bl.roundGroups.length === 0) { push("  (ไม่มีรอบจ่ายในเดือนนี้ — มีเฉพาะเซอร์วิสชาร์จ)"); lines.push(""); }

      // Final per-person rollup for this branch.
      push("  สรุปรวมต่อคน (ทั้งเดือน · รวมเซอร์วิสชาร์จระดับบริษัท + เบี้ยประชุม)");
      push(...ROLLUP_COLUMNS.map((col) => col.header));
      for (const r of bl.rollup) push(...ROLLUP_COLUMNS.map((col) => rollupCell(r, col)));
      const t = bl.totals;
      push("รวมสาขา", "", t.comp.toFixed(2), t.svcGross.toFixed(2), t.mtgGross.toFixed(2), t.income.toFixed(2),
        t.sso > 0 ? (-t.sso).toFixed(2) : "0.00", t.tax > 0 ? (-t.tax).toFixed(2) : "0.00",
        t.gi > 0 ? (-t.gi).toFixed(2) : "0.00", t.other > 0 ? (-t.other).toFixed(2) : "0.00",
        t.deduction > 0 ? (-t.deduction).toFixed(2) : "0.00", t.take.toFixed(2), "");
      lines.push("");
    }

    const ct = c.totals;
    push(`รวมทั้งบริษัท ${c.name}`, "", ct.comp.toFixed(2), ct.svcGross.toFixed(2), ct.mtgGross.toFixed(2), ct.income.toFixed(2),
      ct.sso > 0 ? (-ct.sso).toFixed(2) : "0.00", ct.tax > 0 ? (-ct.tax).toFixed(2) : "0.00",
      ct.gi > 0 ? (-ct.gi).toFixed(2) : "0.00", ct.other > 0 ? (-ct.other).toFixed(2) : "0.00",
      ct.deduction > 0 ? (-ct.deduction).toFixed(2) : "0.00", ct.take.toFixed(2), "");
    lines.push(""); lines.push("");
  }

  if (doc.companies.length > 1) {
    const g = doc.grand;
    push("รวมทั้งหมด (ทุกบริษัท)", "", g.comp.toFixed(2), g.svcGross.toFixed(2), g.mtgGross.toFixed(2), g.income.toFixed(2),
      g.sso > 0 ? (-g.sso).toFixed(2) : "0.00", g.tax > 0 ? (-g.tax).toFixed(2) : "0.00",
      g.gi > 0 ? (-g.gi).toFixed(2) : "0.00", g.other > 0 ? (-g.other).toFixed(2) : "0.00",
      g.deduction > 0 ? (-g.deduction).toFixed(2) : "0.00", g.take.toFixed(2), "");
  }

  return "﻿" + lines.join("\r\n"); // BOM so Excel reads Thai UTF-8
}
