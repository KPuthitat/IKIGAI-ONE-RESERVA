// ดึงรายชื่อ + ข้อมูลพนักงาน (เลือกฟิลด์ได้) — owner 2026-09-07. Same shape as the
// payroll "สร้างเอกสาร" export: pick a company/branch, pick which columns, then
// render CSV / XLSX / PDF. Read-only. Employees are grouped by company → home
// branch (สังกัด). Financial / ID fields are flagged `sensitive` and the route
// only emits them for a user with payroll access.

import type Database from "better-sqlite3";
import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { parseScope, scopeToken, type ExportScope } from "./payroll-summary-doc";

export { parseScope, scopeToken };
export type { ExportScope };

// ── Field catalog ────────────────────────────────────────────────────

export type FieldKind = "text" | "money" | "date" | "bool" | "branches";

export type EmployeeField = {
  key: string;
  header: string;
  kind: FieldKind;
  sensitive?: boolean;   // financial / national-ID — needs payroll access to export
};

// Raw row shape pulled from the DB (superset; only selected fields are emitted).
type EmpRaw = {
  id: number;
  display_name: string; title_prefix: string | null; nickname_th: string | null;
  employee_code: string | null; national_id: string | null; tax_id: string | null; sso_id: string | null;
  gender: string | null; dob: string | null;
  employment_type: string | null; salary_tax_mode: string | null; pay_cycle: string | null;
  role: string | null; status: string | null;
  hire_date: string | null; ft_started_at: string | null; pt_started_at: string | null;
  hourly_rate: number | null; monthly_salary: number | null;
  bank_name: string | null; bank_account: string | null;
  shift_start_time: string | null; weekly_off_days: string | null;
  sso_start_month: string | null; line_user_id: string | null;
  receives_service_charge: number | null; meeting_fee_exempt: number | null;
  can_view_payroll: number | null; track_attendance: number | null;
  home_branch_id: number | null; home_branch_name: string | null; company_name: string | null; company_id: number | null;
  reports_to_name: string | null;
  branches_label: string | null;
};

const empType = (t: string | null) => t === "ft" ? "ประจำ" : t === "pt" ? "พาร์ทไทม์" : t === "df" ? "แพทย์ (DF)" : (t ?? "");
const taxMode = (t: string | null) => t === "sso" ? "ประกันสังคม" : t === "wht" ? "หัก ณ ที่จ่าย" : (t ?? "");
const payCycle = (t: string | null) => t === "monthly" ? "รายเดือน" : t === "weekly" ? "รายสัปดาห์" : (t ?? "");
const roleLabel = (t: string | null) => t === "admin" ? "แอดมิน" : t === "super_admin" ? "ผู้ดูแลสูงสุด" : t === "staff" ? "พนักงาน" : (t ?? "");
const statusLabel = (t: string | null) => t === "active" ? "ทำงานอยู่" : t === "pending_invite" ? "รอเชิญ" : (t ?? "");
const genderLabel = (g: string | null) => g === "male" ? "ชาย" : g === "female" ? "หญิง" : (g ?? "");
const yesNo = (n: number | null) => (n ? "ใช่" : "ไม่");
const weeklyOff = (raw: string | null): string => {
  if (!raw) return "";
  const days = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  try { const arr = JSON.parse(raw) as number[]; return Array.isArray(arr) ? arr.map((d) => days[d] ?? d).join(",") : String(raw); }
  catch { return String(raw); }
};

/** Field catalog + how each renders from a raw row. Order = display order. */
export const EMPLOYEE_FIELDS: Array<EmployeeField & { get: (r: EmpRaw) => string | number }> = [
  { key: "name", header: "ชื่อ-นามสกุล", kind: "text", get: (r) => nameWithPrefix(r.title_prefix, r.display_name) },
  { key: "nickname", header: "ชื่อเล่น", kind: "text", get: (r) => r.nickname_th ?? "" },
  { key: "employee_code", header: "รหัสพนักงาน", kind: "text", get: (r) => r.employee_code ?? "" },
  { key: "home_branch", header: "สังกัด (สาขา)", kind: "text", get: (r) => r.home_branch_name ?? "" },
  { key: "branches", header: "สาขาที่สังกัดทั้งหมด", kind: "branches", get: (r) => r.branches_label ?? "" },
  { key: "employment_type", header: "ประเภทจ้าง", kind: "text", get: (r) => empType(r.employment_type) },
  { key: "role", header: "สิทธิ์ผู้ใช้", kind: "text", get: (r) => roleLabel(r.role) },
  { key: "status", header: "สถานะ", kind: "text", get: (r) => statusLabel(r.status) },
  { key: "gender", header: "เพศ", kind: "text", get: (r) => genderLabel(r.gender) },
  { key: "dob", header: "วันเกิด", kind: "date", get: (r) => r.dob ?? "" },
  { key: "hire_date", header: "วันเริ่มงาน", kind: "date", get: (r) => r.hire_date ?? "" },
  { key: "ft_started_at", header: "วันเริ่มเป็นประจำ", kind: "date", get: (r) => r.ft_started_at ?? "" },
  { key: "pt_started_at", header: "วันเริ่มพาร์ทไทม์", kind: "date", get: (r) => r.pt_started_at ?? "" },
  { key: "shift_start_time", header: "เวลาเข้างาน", kind: "text", get: (r) => r.shift_start_time ?? "" },
  { key: "weekly_off_days", header: "วันหยุดประจำ", kind: "text", get: (r) => weeklyOff(r.weekly_off_days) },
  { key: "reports_to", header: "หัวหน้า", kind: "text", get: (r) => r.reports_to_name ?? "" },
  { key: "line_user_id", header: "ผูก LINE แล้ว", kind: "bool", get: (r) => yesNo(r.line_user_id ? 1 : 0) },
  { key: "receives_service_charge", header: "รับเซอร์วิสชาร์จ", kind: "bool", get: (r) => yesNo(r.receives_service_charge) },
  { key: "meeting_fee_exempt", header: "ยกเว้นเบี้ยประชุม", kind: "bool", get: (r) => yesNo(r.meeting_fee_exempt) },
  { key: "track_attendance", header: "นับเวลาเข้างาน", kind: "bool", get: (r) => yesNo(r.track_attendance) },
  { key: "can_view_payroll", header: "ดูค่าตอบแทนได้", kind: "bool", get: (r) => yesNo(r.can_view_payroll) },
  // ── sensitive (financial / national ID) — payroll access required ──
  { key: "salary_tax_mode", header: "รูปแบบภาษี", kind: "text", sensitive: true, get: (r) => taxMode(r.salary_tax_mode) },
  { key: "pay_cycle", header: "รอบจ่าย", kind: "text", sensitive: true, get: (r) => payCycle(r.pay_cycle) },
  { key: "monthly_salary", header: "เงินเดือน", kind: "money", sensitive: true, get: (r) => r.monthly_salary ?? "" },
  { key: "hourly_rate", header: "ค่าจ้าง/ชม.", kind: "money", sensitive: true, get: (r) => r.hourly_rate ?? "" },
  { key: "national_id", header: "เลขบัตรประชาชน", kind: "text", sensitive: true, get: (r) => r.national_id ?? "" },
  { key: "tax_id", header: "เลขผู้เสียภาษี", kind: "text", sensitive: true, get: (r) => r.tax_id ?? "" },
  { key: "sso_id", header: "เลขประกันสังคม", kind: "text", sensitive: true, get: (r) => r.sso_id ?? "" },
  { key: "sso_start_month", header: "เดือนเริ่ม ปกส.", kind: "text", sensitive: true, get: (r) => r.sso_start_month ?? "" },
  { key: "bank_name", header: "ธนาคาร", kind: "text", sensitive: true, get: (r) => r.bank_name ?? "" },
  { key: "bank_account", header: "เลขบัญชี", kind: "text", sensitive: true, get: (r) => r.bank_account ?? "" }
];

const FIELD_BY_KEY = new Map(EMPLOYEE_FIELDS.map((f) => [f.key, f]));

/** Field descriptors for the picker UI (no resolver). */
export function employeeFieldOptions(): EmployeeField[] {
  return EMPLOYEE_FIELDS.map(({ key, header, kind, sensitive }) => ({ key, header, kind, sensitive }));
}

// ── Scope options ────────────────────────────────────────────────────

export type ScopeOption = { value: string; label: string; kind: "all" | "company" | "branch"; companyKey?: number | null };

/** Every company + branch that has ≥1 active employee — for the scope picker. */
export function listEmployeeScopes(db: Database.Database): ScopeOption[] {
  const branches = db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.company_id AS company_id, c.name_th AS company_name
    FROM branches b
    LEFT JOIN companies c ON c.id = b.company_id
    WHERE EXISTS (
      SELECT 1 FROM user_branches ub JOIN users u ON u.id = ub.user_id
      WHERE ub.branch_id = b.id AND u.is_test_account = 0
        AND u.status NOT IN ('disabled','resigned','terminated'))
    ORDER BY (b.company_id IS NULL), b.company_id, b.display_order, b.name
  `).all() as Array<{ branch_id: number; branch_name: string; company_id: number | null; company_name: string | null }>;
  const opts: ScopeOption[] = [{ value: "all", label: "ทุกบริษัท (แยกหัวข้อสาขา)", kind: "all" }];
  const seen = new Set<string>();
  for (const b of branches) {
    const ck = String(b.company_id);
    if (!seen.has(ck)) {
      seen.add(ck);
      opts.push({ value: `company:${b.company_id ?? "null"}`, label: b.company_name ?? "ไม่ระบุบริษัท", kind: "company", companyKey: b.company_id });
    }
    opts.push({ value: `branch:${b.branch_id}`, label: b.branch_name, kind: "branch", companyKey: b.company_id });
  }
  return opts;
}

// ── Document model ───────────────────────────────────────────────────

export type EmployeeCell = string | number;
export type EmployeeRow = { userId: number; cells: EmployeeCell[] };
export type EmployeeBranchBlock = { branchId: number | null; branchName: string; rows: EmployeeRow[] };
export type EmployeeCompany = { key: string; name: string; branches: EmployeeBranchBlock[]; count: number };
export type EmployeeDoc = {
  scopeLabel: string;
  columns: Array<{ key: string; header: string; kind: FieldKind }>;
  companies: EmployeeCompany[];
  total: number;
};

function companyInfo(db: Database.Database, companyId: number | null): string {
  if (companyId == null) return "ไม่ระบุบริษัท";
  return (db.prepare("SELECT name_th FROM companies WHERE id = ?").get(companyId) as { name_th: string } | undefined)?.name_th ?? "ไม่ระบุบริษัท";
}

/**
 * Build the employee document for a scope + chosen fields. `includeSensitive`
 * decides whether sensitive columns are honoured (the route sets it from the
 * caller's payroll access); sensitive keys are silently dropped otherwise.
 */
export function buildEmployeeDoc(
  scope: ExportScope, fieldKeys: string[], includeSensitive: boolean
): EmployeeDoc {
  const db = getDb();
  // Resolve the selected fields (keep catalog order; "name" always first).
  const chosen = EMPLOYEE_FIELDS.filter((f) =>
    (f.key === "name" || fieldKeys.includes(f.key)) && (includeSensitive || !f.sensitive));
  if (!chosen.some((f) => f.key === "name")) chosen.unshift(FIELD_BY_KEY.get("name")! as typeof EMPLOYEE_FIELDS[number]);

  // Which company keys + optional single-branch filter.
  let companyKeys: Array<number | null> = [];
  let branchFilter: number | null = null;
  let scopeLabel = "ทุกบริษัท";
  const allBranches = db.prepare(`
    SELECT id AS branch_id, name AS branch_name, company_id FROM branches
  `).all() as Array<{ branch_id: number; branch_name: string; company_id: number | null }>;
  const branchCompany = new Map<number, number | null>();
  const branchName = new Map<number, string>();
  for (const b of allBranches) { branchCompany.set(b.branch_id, b.company_id); branchName.set(b.branch_id, b.branch_name); }

  if (scope.kind === "all") {
    // companies discovered from employee home branches below
    companyKeys = [];
  } else if (scope.kind === "company") {
    companyKeys = [scope.id];
    scopeLabel = companyInfo(db, scope.id);
  } else {
    branchFilter = scope.id;
    companyKeys = [branchCompany.get(scope.id) ?? null];
    scopeLabel = `${branchName.get(scope.id) ?? "สาขา"}`;
  }

  // Pull every active, non-test employee with a home branch, + all catalog cols.
  const rows = db.prepare(`
    SELECT u.id,
           u.display_name, u.title_prefix, u.nickname_th,
           u.employee_code, u.national_id, u.tax_id, u.sso_id,
           u.gender, u.dob, u.employment_type, u.salary_tax_mode, u.pay_cycle,
           u.role, u.status, u.hire_date, u.ft_started_at, u.pt_started_at,
           u.hourly_rate, u.monthly_salary, u.bank_name, u.bank_account,
           u.shift_start_time, u.weekly_off_days, u.sso_start_month, u.line_user_id,
           u.receives_service_charge, u.meeting_fee_exempt, u.can_view_payroll, u.track_attendance,
           hb.id AS home_branch_id, hb.name AS home_branch_name, hb.company_id AS company_id,
           (SELECT display_name FROM users mgr WHERE mgr.id = u.reports_to_user_id) AS reports_to_name,
           (SELECT group_concat(b2.name, ', ') FROM user_branches ub2 JOIN branches b2 ON b2.id = ub2.branch_id WHERE ub2.user_id = u.id) AS branches_label
    FROM users u
    JOIN branches hb ON hb.id = COALESCE(
      (SELECT branch_id FROM user_branches WHERE user_id = u.id AND is_primary = 1 LIMIT 1),
      (SELECT MIN(branch_id) FROM user_branches WHERE user_id = u.id))
    WHERE u.is_test_account = 0
      AND u.status NOT IN ('disabled','resigned','terminated')
      AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id)
    ORDER BY (u.employment_type='ft') DESC, (u.employment_type='pt') DESC, u.display_name
  `).all() as EmpRaw[];

  // Bucket by company → home branch, honouring the scope filter.
  const wantCompany = (cid: number | null) => scope.kind === "all" || companyKeys.includes(cid);
  const byCompany = new Map<number | null, Map<number | null, EmployeeBranchBlock>>();
  let total = 0;
  for (const r of rows) {
    if (!wantCompany(r.company_id)) continue;
    const hbId = r.home_branch_id ?? null;
    if (branchFilter != null && hbId !== branchFilter) continue;
    const cells = chosen.map((f) => f.get(r));
    let branches = byCompany.get(r.company_id);
    if (!branches) { branches = new Map(); byCompany.set(r.company_id, branches); }
    let block = branches.get(hbId);
    if (!block) { block = { branchId: hbId, branchName: r.home_branch_name ?? "—", rows: [] }; branches.set(hbId, block); }
    block.rows.push({ userId: r.id, cells });
    total += 1;
  }

  const companies: EmployeeCompany[] = [];
  for (const [cid, branches] of byCompany) {
    const blocks = [...branches.values()].filter((b) => b.rows.length > 0);
    if (blocks.length === 0) continue;
    companies.push({
      key: `company:${cid ?? "null"}`, name: companyInfo(db, cid),
      branches: blocks, count: blocks.reduce((s, b) => s + b.rows.length, 0)
    });
  }
  companies.sort((a, b) => a.name.localeCompare(b.name, "th"));

  return {
    scopeLabel,
    columns: chosen.map((f) => ({ key: f.key, header: f.header, kind: f.kind })),
    companies, total
  };
}

// ── CSV renderer ─────────────────────────────────────────────────────

function csvEsc(v: EmployeeCell): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderEmployeeCsv(doc: EmployeeDoc, generatedLabel: string, note?: string | null): string {
  const lines: string[] = [];
  const push = (...cells: EmployeeCell[]) => lines.push(cells.map(csvEsc).join(","));
  push("รายชื่อและข้อมูลพนักงาน");
  push("ขอบเขต", doc.scopeLabel);
  push("จำนวน", `${doc.total} คน`);
  push("ออกเอกสารเมื่อ", generatedLabel);
  if (note && note.trim()) push("หมายเหตุ", note.trim());
  lines.push("");
  const headers = doc.columns.map((c) => c.header);
  for (const c of doc.companies) {
    push(`บริษัท: ${c.name} (${c.count} คน)`);
    for (const bl of c.branches) {
      push(`◆ สาขา: ${bl.branchName} (${bl.rows.length} คน)`);
      push(...headers);
      for (const r of bl.rows) push(...r.cells);
      lines.push("");
    }
  }
  return "﻿" + lines.join("\r\n");
}
