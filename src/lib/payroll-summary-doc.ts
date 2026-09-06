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
//
// Layout: per company → per branch heading → (a) รอบจ่าย broken down per person
// (ยอดก่อนหัก → หัก → สุทธิ) and (b) a final per-person rollup for the month
// (ค่าตอบแทนทุกรอบ + เซอร์วิสชาร์จระดับบริษัท), with the deduction columns marked.

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
  value: string;
  label: string;
  kind: "all" | "company" | "branch";
  companyKey?: number | null;
};

type BranchRow = {
  branch_id: number; branch_name: string;
  company_id: number | null; company_name: string | null;
};

// Union of branches that either paid payroll this month or had SVC activity in
// the SVC month — same rule as the summary page, so nobody is dropped.
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
  const opts: ScopeOption[] = [{ value: "all", label: "ทุกบริษัท (แยกหัวข้อสาขาในไฟล์เดียว)", kind: "all" }];
  const seenCompany = new Set<string>();
  for (const b of branches) {
    const key = String(b.company_id);
    if (!seenCompany.has(key)) {
      seenCompany.add(key);
      opts.push({
        value: `company:${b.company_id ?? "null"}`,
        label: b.company_name ?? "ไม่ระบุบริษัท",
        kind: "company", companyKey: b.company_id
      });
    }
    opts.push({ value: `branch:${b.branch_id}`, label: b.branch_name, kind: "branch", companyKey: b.company_id });
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
  income: number;      // ยอดก่อนหัก = comp + svcGross
  sso: number;         // ประกันสังคม (หัก)
  tax: number;         // ภาษี ณ ที่จ่าย incl. SVC WHT (หัก)
  gi: number;          // ประกันกลุ่ม (หัก)
  other: number;       // หักอื่นๆ (เครื่องดื่ม/มื้ออาหาร ฯลฯ ในรอบจ่าย)
  deduction: number;   // รวมหัก
  take: number;        // รวมรับจริง = income − deduction
  periodCount: number;
};

export type DocTotals = {
  comp: number; svcGross: number; income: number;
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

/** One person's line within a single pay round: ก่อนหัก → หัก → สุทธิ. */
export type RoundMember = {
  userId: number;
  name: string;
  homeBranch: string;
  before: number;      // ยอดก่อนหัก = gross_pay ของรอบนั้น (ตามที่บันทึกไว้)
  deduction: number;   // ยอดหัก = gross_pay − net_pay (สะท้อนยอดที่ลงบัญชีจริง)
  net: number;         // ยอดสุทธิ = net_pay
};

export type PayRoundGroup = {
  info: PayRoundInfo;
  members: RoundMember[];
  before: number; deduction: number; net: number;
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
  ({ comp: 0, svcGross: 0, income: 0, sso: 0, tax: 0, gi: 0, other: 0, deduction: 0, take: 0 });
function addRowToTotals(t: DocTotals, r: EmpDocRow) {
  t.comp = round2(t.comp + r.comp); t.svcGross = round2(t.svcGross + r.svcGross);
  t.income = round2(t.income + r.income); t.sso = round2(t.sso + r.sso);
  t.tax = round2(t.tax + r.tax); t.gi = round2(t.gi + r.gi);
  t.other = round2(t.other + r.other); t.deduction = round2(t.deduction + r.deduction);
  t.take = round2(t.take + r.take);
}

// SVC row shape both engine variants share (fields we consume).
type SvcRow = {
  userId: number; displayName: string; employmentType: string | null;
  taxMode: "sso" | "wht"; netAllocation: number; whtAmount: number;
  groupInsurance: number; netPayout: number;
};
type SvcAgg = { gross: number; wht: number; gi: number; net: number;
  displayName: string; employmentType: string | null; taxMode: "sso" | "wht" };

function companyInfo(db: Database.Database, companyId: number | null) {
  if (companyId == null) return { name: "ไม่ระบุบริษัท", taxId: null as string | null, address: null as string | null };
  const c = db.prepare("SELECT name_th, tax_id, address FROM companies WHERE id = ?")
    .get(companyId) as { name_th: string; tax_id: string | null; address: string | null } | undefined;
  return { name: c?.name_th ?? "ไม่ระบุบริษัท", taxId: c?.tax_id ?? null, address: c?.address ?? null };
}

/**
 * Company-level SVC per user (the authority): computeCompanySvcSummary handles
 * รวมกอง shared-pool + cross-branch caps so it agrees with the actual payout.
 * Falls back to summing the per-branch engine for a NULL-company branch set.
 */
function companySvcByUser(
  companyId: number | null, branchIds: number[], svcMonth: string
): Map<number, SvcAgg> {
  let rows: SvcRow[] = [];
  if (companyId != null) {
    try { rows = computeCompanySvcSummary(companyId, svcMonth).rows as unknown as SvcRow[]; }
    catch { rows = []; }
  } else {
    for (const b of branchIds) {
      try { rows.push(...(computeMonthlySvcSummary(b, svcMonth).rows as unknown as SvcRow[])); }
      catch { /* no svc */ }
    }
  }
  const map = new Map<number, SvcAgg>();
  for (const r of rows) {
    if (!r.netAllocation && !r.netPayout) continue;
    const cur = map.get(r.userId)
      ?? { gross: 0, wht: 0, gi: 0, net: 0, displayName: r.displayName, employmentType: r.employmentType, taxMode: r.taxMode };
    cur.gross += r.netAllocation; cur.wht += r.whtAmount; cur.gi += r.groupInsurance; cur.net += r.netPayout;
    map.set(r.userId, cur);
  }
  return map;
}

type EmpAgg = {
  user_id: number; display_name: string; title_prefix: string | null;
  employment_type: "pt" | "ft" | null; salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number; total_net: number; total_sso: number; total_tax: number; period_count: number;
};

/** Company-wide per-person rollup rows (payroll across all company branches + company SVC). */
function buildCompanyRows(
  db: Database.Database, range: { from: string; to: string },
  branchIds: number[], svcByUser: Map<number, SvcAgg>, homeByUser: Map<number, string | null>
): EmpDocRow[] {
  const empRows: EmpAgg[] = branchIds.length === 0 ? [] : (db.prepare(`
    SELECT pl.user_id, pl.display_name, u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.net_pay)    AS total_net,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           COUNT(*)           AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pp.id = pl.period_id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
      AND pp.branch_id IN (${branchIds.map(() => "?").join(",")})
    GROUP BY pl.user_id
  `).all(range.from, range.to, ...branchIds) as EmpAgg[]);

  const rows: EmpDocRow[] = [];
  const seen = new Set<number>();
  const mk = (
    userId: number, name: string, emp: string | null, taxMode: string | null,
    comp: number, payrollNet: number, ssoRaw: number, taxRaw: number, periodCount: number
  ): EmpDocRow => {
    const svc = svcByUser.get(userId);
    const svcGross = round2(svc?.gross ?? 0);
    const income = round2(comp + svcGross);
    const sso = round2(ssoRaw);
    const tax = round2(taxRaw + (svc?.wht ?? 0));
    const gi = round2(svc?.gi ?? 0);
    // payrollDed captures EVERYTHING withheld in the round (sso + tax + drink /
    // mealpass / other), from the stored net so it always reconciles. อื่นๆ =
    // whatever isn't sso/tax.
    const payrollDed = round2(comp - payrollNet);
    const other = round2(Math.max(0, payrollDed - sso - taxRaw));
    const deduction = round2(sso + tax + gi + other);
    const take = round2(income - deduction);
    return {
      userId, name, empTypeLabel: typeLabel(emp), taxModeLabel: taxLabel(taxMode),
      homeBranch: homeByUser.get(userId) ?? "—",
      comp: round2(comp), svcGross, income, sso, tax, gi, other, deduction, take, periodCount
    };
  };
  for (const r of empRows) {
    seen.add(r.user_id);
    rows.push(mk(r.user_id, nameWithPrefix(r.title_prefix, r.display_name),
      r.employment_type, r.salary_tax_mode_snapshot,
      r.total_gross ?? 0, r.total_net ?? 0, r.total_sso ?? 0, r.total_tax ?? 0, r.period_count ?? 0));
  }
  // SVC-only people (no payroll round this month) — zero-wage row so their SVC
  // + its WHT still land on the sheet.
  for (const [uid, s] of svcByUser) {
    if (seen.has(uid)) continue;
    rows.push(mk(uid, s.displayName, s.employmentType, s.taxMode, 0, 0, 0, 0, 0));
  }
  return rows;
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
             pl.gross_pay, pl.net_pay
      FROM payroll_lines pl LEFT JOIN users u ON u.id = pl.user_id
      WHERE pl.period_id = ?
      ORDER BY (pl.employment_type = 'ft') DESC, pl.display_name
    `).all(p.id) as Array<{
      user_id: number; display_name: string; title_prefix: string | null;
      employment_type: string | null; gross_pay: number | null; net_pay: number | null;
    }>;
    const members: RoundMember[] = [];
    let before = 0, deduction = 0, net = 0;
    for (const l of lines) {
      const b = round2(l.gross_pay ?? 0), n = round2(l.net_pay ?? 0);
      if (b === 0 && n === 0) continue; // skip zero-noise rows (e.g. FT at a non-home branch)
      const d = round2(b - n);
      members.push({
        userId: l.user_id, name: nameWithPrefix(l.title_prefix, l.display_name),
        homeBranch: homeByUser.get(l.user_id) ?? "—", before: b, deduction: d, net: n
      });
      before = round2(before + b); deduction = round2(deduction + d); net = round2(net + n);
    }
    groups.push({
      info: {
        cycle: p.cycle, cycleLabel: cycleLabel(p.cycle, p.target),
        periodStart: p.period_start, periodEnd: p.period_end, payDate: p.pay_date,
        statusLabel: statusLabel(p.status), branchName: p.branch_name, gross: before, net
      },
      members, before, deduction, net
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
  const range = monthRange(month);
  const svcMonth = shiftMonth(month, -1);
  const branches = unionBranches(db, month);

  const homeRows = db.prepare(`
    SELECT ub.user_id,
           (SELECT name FROM branches WHERE id = COALESCE(
              (SELECT branch_id FROM user_branches WHERE user_id = ub.user_id AND is_primary = 1 LIMIT 1),
              (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ub.user_id))) AS home_branch_name
    FROM (SELECT DISTINCT user_id FROM user_branches) ub
  `).all() as Array<{ user_id: number; home_branch_name: string | null }>;
  const homeByUser = new Map<number, string | null>();
  for (const r of homeRows) homeByUser.set(r.user_id, r.home_branch_name);

  // Which companies + (optional) single-branch filter the scope asks for.
  let companyKeys: Array<number | null>;
  let branchFilter: number | null = null;
  let scopeLabel = "ทุกบริษัท";
  if (scope.kind === "all") {
    companyKeys = [];
    for (const b of branches) if (!companyKeys.includes(b.company_id)) companyKeys.push(b.company_id);
  } else if (scope.kind === "company") {
    companyKeys = [scope.id];
    scopeLabel = companyInfo(db, scope.id).name;
  } else {
    const b = branches.find((x) => x.branch_id === scope.id)
      ?? (db.prepare(`SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
            FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?`).get(scope.id) as BranchRow | undefined);
    companyKeys = [b?.company_id ?? null];
    branchFilter = scope.id;
    scopeLabel = b ? `${b.branch_name}${b.company_name ? ` · ${b.company_name}` : ""}` : "สาขา";
  }

  const companies: CompanyDoc[] = [];
  for (const ck of companyKeys) {
    const compBranches = branches.filter((b) => b.company_id === ck);
    if (compBranches.length === 0) continue;
    const allBranchIds = compBranches.map((b) => b.branch_id);
    // Company-authoritative SVC + company-wide per-person rollup.
    const svcByUser = companySvcByUser(ck, allBranchIds, svcMonth);
    const companyRows = buildCompanyRows(db, range, allBranchIds, svcByUser, homeByUser);
    const rowsByHome = new Map<string, EmpDocRow[]>();
    for (const r of companyRows) {
      const arr = rowsByHome.get(r.homeBranch) ?? [];
      arr.push(r); rowsByHome.set(r.homeBranch, arr);
    }

    const blocks: BranchBlock[] = [];
    const shown = branchFilter != null ? compBranches.filter((b) => b.branch_id === branchFilter) : compBranches;
    const claimed = new Set<number>();
    for (const b of shown) {
      const roundGroups = buildRoundGroups(db, range, b.branch_id, homeByUser);
      const rollup = (rowsByHome.get(b.branch_name) ?? []).slice()
        .sort((x, y) => rowRank(x) - rowRank(y) || x.name.localeCompare(y.name, "th"));
      for (const r of rollup) claimed.add(r.userId);
      if (roundGroups.length === 0 && rollup.length === 0) continue;
      const totals = zeroTotals();
      for (const r of rollup) addRowToTotals(totals, r);
      blocks.push({ branchId: b.branch_id, branchName: b.branch_name, roundGroups, rollup, totals });
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
        push("  ชื่อ-นามสกุล", "สังกัด", "ยอดก่อนหัก", "ยอดหัก", "ยอดสุทธิ");
        for (const m of g.members) {
          push("  " + m.name, m.homeBranch, m.before.toFixed(2), m.deduction > 0 ? (-m.deduction).toFixed(2) : "0.00", m.net.toFixed(2));
        }
        push("  รวมรอบ", "", g.before.toFixed(2), g.deduction > 0 ? (-g.deduction).toFixed(2) : "0.00", g.net.toFixed(2));
        lines.push("");
      }
      if (bl.roundGroups.length === 0) { push("  (ไม่มีรอบจ่ายในเดือนนี้ — มีเฉพาะเซอร์วิสชาร์จ)"); lines.push(""); }

      // Final per-person rollup for this branch.
      push("  สรุปรวมต่อคน (ทั้งเดือน · รวมเซอร์วิสชาร์จระดับบริษัท)");
      push(...ROLLUP_COLUMNS.map((col) => col.header));
      for (const r of bl.rollup) push(...ROLLUP_COLUMNS.map((col) => rollupCell(r, col)));
      const t = bl.totals;
      push("รวมสาขา", "", t.comp.toFixed(2), t.svcGross.toFixed(2), t.income.toFixed(2),
        t.sso > 0 ? (-t.sso).toFixed(2) : "0.00", t.tax > 0 ? (-t.tax).toFixed(2) : "0.00",
        t.gi > 0 ? (-t.gi).toFixed(2) : "0.00", t.other > 0 ? (-t.other).toFixed(2) : "0.00",
        t.deduction > 0 ? (-t.deduction).toFixed(2) : "0.00", t.take.toFixed(2), "");
      lines.push("");
    }

    const ct = c.totals;
    push(`รวมทั้งบริษัท ${c.name}`, "", ct.comp.toFixed(2), ct.svcGross.toFixed(2), ct.income.toFixed(2),
      ct.sso > 0 ? (-ct.sso).toFixed(2) : "0.00", ct.tax > 0 ? (-ct.tax).toFixed(2) : "0.00",
      ct.gi > 0 ? (-ct.gi).toFixed(2) : "0.00", ct.other > 0 ? (-ct.other).toFixed(2) : "0.00",
      ct.deduction > 0 ? (-ct.deduction).toFixed(2) : "0.00", ct.take.toFixed(2), "");
    lines.push(""); lines.push("");
  }

  if (doc.companies.length > 1) {
    const g = doc.grand;
    push("รวมทั้งหมด (ทุกบริษัท)", "", g.comp.toFixed(2), g.svcGross.toFixed(2), g.income.toFixed(2),
      g.sso > 0 ? (-g.sso).toFixed(2) : "0.00", g.tax > 0 ? (-g.tax).toFixed(2) : "0.00",
      g.gi > 0 ? (-g.gi).toFixed(2) : "0.00", g.other > 0 ? (-g.other).toFixed(2) : "0.00",
      g.deduction > 0 ? (-g.deduction).toFixed(2) : "0.00", g.take.toFixed(2), "");
  }

  return "﻿" + lines.join("\r\n"); // BOM so Excel reads Thai UTF-8
}
