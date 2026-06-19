// Involuntary termination (เลิกจ้าง) — admin-initiated separation, distinct
// from the staff-initiated voluntary resignation flow. Computes statutory
// severance (พรบ.คุ้มครองแรงงาน ม.118) from tenure, records the case, and a
// 'scheduled' record locks the account to status='terminated' on the
// effective date via the nightly cron sweep (sweepTerminationsToTake).
//
// Severance is "days of last-wage" by tenure band:
//   <120d:0 · 120d–<1y:30 · 1–<3y:90 · 3–<6y:180 · 6–<10y:240 ·
//   10–<20y:300 · ≥20y:400.
// Just-cause (ม.119 — ทุจริต/จงใจทำผิด ฯลฯ) pays nothing regardless of
// tenure. Amount = severance_days × (monthly_salary / 30) for FT staff
// (the same salary/30 daily rate the payroll engine uses); 0 when no
// monthly salary is on file, in which case the admin keys the figure.
// (owner 2026-06-19.)

import { getDb } from "./db";

export type TerminationType = "probation_fail" | "just_cause" | "no_cause" | "contract_end";

export const TERMINATION_TYPES: TerminationType[] = [
  "probation_fail", "just_cause", "no_cause", "contract_end"
];

export const TERMINATION_TYPE_TH: Record<TerminationType, string> = {
  probation_fail: "ไม่ผ่านทดลองงาน",
  just_cause: "เลิกจ้างมีความผิดร้ายแรง",
  no_cause: "เลิกจ้างไม่มีความผิด / ลดคน",
  contract_end: "สิ้นสุดสัญญาจ้าง"
};

export function isTerminationType(v: unknown): v is TerminationType {
  return typeof v === "string" && (TERMINATION_TYPES as string[]).includes(v);
}

function bkkMonthCompact(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7).replace("-", "");
}

/** Tenure in whole days between hire_date and effective_date (both
 *  YYYY-MM-DD). Returns 0 when hire_date is missing/invalid or falls
 *  on/after the effective date. Date-only UTC math — Thailand has no
 *  DST so this is exact. */
export function tenureDays(hireDate: string | null, effectiveDate: string): number {
  if (!hireDate || !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return 0;
  const [hy, hm, hd] = hireDate.split("-").map(Number);
  const [ey, em, ed] = effectiveDate.split("-").map(Number);
  const ms = Date.UTC(ey, em - 1, ed) - Date.UTC(hy, hm - 1, hd);
  return ms > 0 ? Math.floor(ms / 86400_000) : 0;
}

/** Statutory severance entitlement in days-of-wage for a tenure length
 *  (พรบ.คุ้มครองแรงงาน ม.118). */
export function severanceDaysForTenure(days: number): number {
  if (days < 120) return 0;
  if (days < 365) return 30;
  if (days < 365 * 3) return 90;
  if (days < 365 * 6) return 180;
  if (days < 365 * 10) return 240;
  if (days < 365 * 20) return 300;
  return 400;
}

export type SeveranceCalc = {
  tenureDays: number;
  severanceDays: number;
  dailyWage: number;
  severanceAmount: number;
};

/** Auto severance for a (type, tenure, salary). Just-cause pays nothing
 *  regardless of tenure; everything else follows the statutory band. */
export function computeSeverance(args: {
  type: TerminationType;
  hireDate: string | null;
  effectiveDate: string;
  monthlySalary: number | null;
}): SeveranceCalc {
  const td = tenureDays(args.hireDate, args.effectiveDate);
  const sevDays = args.type === "just_cause" ? 0 : severanceDaysForTenure(td);
  const dailyWage = args.monthlySalary && args.monthlySalary > 0 ? args.monthlySalary / 30 : 0;
  const amount = Math.round(sevDays * dailyWage * 100) / 100;
  return { tenureDays: td, severanceDays: sevDays, dailyWage, severanceAmount: amount };
}

export type TerminationInput = {
  userId: number;
  branchId: number | null;
  type: TerminationType;
  reason: string;
  effectiveDate: string;
  evidenceFilename: string | null;
  tenureDays: number;
  severanceDays: number;
  severanceAmount: number;
  severanceAuto: boolean;
};

/** Create a scheduled termination record. Returns the new id + ref no.
 *  Callers must have already validated the target + saved any evidence. */
export function createTermination(adminId: number, input: TerminationInput): { id: number; refNo: string } {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO termination_records
      (user_id, branch_id, termination_type, reason, evidence_filename,
       effective_date, tenure_days, severance_days, severance_amount,
       severance_auto, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `).run(
    input.userId, input.branchId, input.type, input.reason, input.evidenceFilename,
    input.effectiveDate, input.tenureDays, input.severanceDays, input.severanceAmount,
    input.severanceAuto ? 1 : 0, adminId, new Date().toISOString()
  );
  const id = Number(info.lastInsertRowid);
  const refNo = `TM${bkkMonthCompact()}-${id}`;
  db.prepare("UPDATE termination_records SET ref_no = ? WHERE id = ?").run(refNo, id);
  return { id, refNo };
}

/** True when the user already has a non-cancelled termination record —
 *  blocks scheduling a duplicate. */
export function hasOpenTermination(userId: number): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM termination_records WHERE user_id = ? AND status != 'cancelled' LIMIT 1"
  ).get(userId);
  return !!row;
}

export type TerminationRow = {
  id: number;
  user_id: number;
  branch_id: number | null;
  termination_type: TerminationType;
  reason: string;
  evidence_filename: string | null;
  effective_date: string;
  tenure_days: number | null;
  severance_days: number;
  severance_amount: number;
  severance_auto: number;
  status: "scheduled" | "executed" | "cancelled";
  ref_no: string | null;
  created_by: number | null;
  created_at: string;
  executed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: number | null;
};

export type TerminationListRow = TerminationRow & {
  employee_name: string;
  title_prefix: string | null;
  employment_type: string | null;
  branch_name: string | null;
  created_by_name: string | null;
};

/** Termination records for the admin list, newest first. Optional status
 *  filter ('scheduled' | 'executed' | 'cancelled'); omit for all. */
export function listTerminations(status?: TerminationRow["status"], limit = 200): TerminationListRow[] {
  const db = getDb();
  const where = status ? "WHERE t.status = ?" : "";
  const params: Array<string | number> = status ? [status] : [];
  params.push(limit);
  return db.prepare(`
    SELECT t.*, u.display_name AS employee_name, u.title_prefix, u.employment_type,
           b.name AS branch_name, cu.display_name AS created_by_name
    FROM termination_records t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN branches b ON b.id = t.branch_id
    LEFT JOIN users cu ON cu.id = t.created_by
    ${where}
    ORDER BY CASE t.status WHEN 'scheduled' THEN 0 ELSE 1 END,
             t.effective_date DESC, t.created_at DESC
    LIMIT ?
  `).all(...params) as TerminationListRow[];
}

export function getTermination(id: number): TerminationRow | undefined {
  return getDb().prepare("SELECT * FROM termination_records WHERE id = ?").get(id) as TerminationRow | undefined;
}

/** Cancel a still-scheduled termination (the staff stays employed).
 *  Returns false when not found or already executed/cancelled. */
export function cancelTermination(adminId: number, id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT status FROM termination_records WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!row || row.status !== "scheduled") return false;
  db.prepare(`
    UPDATE termination_records
    SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
    WHERE id = ? AND status = 'scheduled'
  `).run(new Date().toISOString(), adminId, id);
  return true;
}

export type SweepTerminationResult = { closed: number; userIds: number[] };

/** Cron-callable. Flip 'scheduled' terminations whose effective_date has
 *  passed (i.e. yesterday or earlier in Bangkok time) to status
 *  'terminated' + stamp terminated_at + kill sessions, and mark the
 *  record 'executed'. Mirrors sweepResignationsToTake: the account stays
 *  usable THROUGH the last working day and locks the morning after.
 *  Idempotent — a second run finds nothing still 'active' + 'scheduled'. */
export function sweepTerminationsToTake(todayBkk: string): SweepTerminationResult {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT t.id AS term_id, t.user_id
    FROM termination_records t
    JOIN users u ON u.id = t.user_id
    WHERE t.status = 'scheduled'
      AND t.effective_date < ?
  `).all(todayBkk) as Array<{ term_id: number; user_id: number }>;

  if (candidates.length === 0) return { closed: 0, userIds: [] };

  const nowIso = new Date().toISOString();
  const closeUser = db.prepare(
    "UPDATE users SET status = 'terminated', terminated_at = ? WHERE id = ? AND status = 'active'"
  );
  const markExec = db.prepare(
    "UPDATE termination_records SET status = 'executed', executed_at = ? WHERE id = ?"
  );
  const killSessions = db.prepare("DELETE FROM sessions WHERE user_id = ?");

  const userIds: number[] = [];
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const r = closeUser.run(nowIso, c.user_id);
      // Always close the record. When the user was still 'active' we also
      // locked them + killed sessions; if they'd already left some other
      // way (resigned/disabled first) we just retire the record.
      markExec.run(nowIso, c.term_id);
      if (r.changes > 0) {
        killSessions.run(c.user_id);
        userIds.push(c.user_id);
      }
    }
  });
  tx();

  return { closed: userIds.length, userIds };
}
