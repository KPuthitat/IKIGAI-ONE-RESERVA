import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { saveLeaveAttachment } from "@/lib/leave";
import {
  createTermination, computeSeverance, hasOpenTermination, isTerminationType
} from "@/lib/termination";

// POST /api/admin/persona/termination — admin schedules an involuntary
// termination (เลิกจ้าง). multipart/form-data:
//   employee_id, type, effective_date, reason, [severance_days],
//   [severance_amount], [file]
//
// Severance is auto-computed from tenure + monthly salary (พรบ.คุ้มครอง
// แรงงาน ม.118); the admin may override the figure. A 'scheduled' record
// locks the account to status='terminated' on the effective date via the
// nightly cron sweep — no LINE notification, no staff submission.

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const employeeId = Number(form.get("employee_id"));
  const type = String(form.get("type") || "");
  const effectiveDate = String(form.get("effective_date") || "");
  const reason = String(form.get("reason") || "").trim().slice(0, 1000);
  const file = form.get("file");

  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json({ error: "invalid_employee" }, { status: 400 });
  }
  if (!isTerminationType(type)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 400 });
  }
  if (employeeId === user.id) {
    return NextResponse.json({ error: "cannot_terminate_self" }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare(`
    SELECT id, role, status, display_name, hire_date, monthly_salary,
           (SELECT ub.branch_id FROM user_branches ub
             WHERE ub.user_id = users.id
             ORDER BY ub.is_primary DESC, ub.branch_id ASC LIMIT 1) AS branch_id
    FROM users WHERE id = ?
  `).get(employeeId) as {
    id: number; role: string; status: string; display_name: string;
    hire_date: string | null; monthly_salary: number | null; branch_id: number | null;
  } | undefined;

  if (!target) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  if (target.status !== "active") {
    return NextResponse.json({ error: "employee_not_active", status: target.status }, { status: 409 });
  }
  // Only super_admin may terminate an admin / super_admin (mirror the
  // soft-delete guard). Plain admins terminate staff only.
  if (target.role !== "staff" && user.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin_required_for_role" }, { status: 403 });
  }
  if (hasOpenTermination(employeeId)) {
    return NextResponse.json({ error: "termination_already_exists" }, { status: 409 });
  }

  // Auto severance from tenure + salary; just-cause pays nothing.
  const auto = computeSeverance({
    type,
    hireDate: target.hire_date,
    effectiveDate,
    monthlySalary: target.monthly_salary
  });

  // Optional admin override of the severance figure.
  const rawDays = form.get("severance_days");
  const rawAmount = form.get("severance_amount");
  let severanceDays = auto.severanceDays;
  let severanceAmount = auto.severanceAmount;
  let severanceAuto = true;
  if (rawDays != null && String(rawDays) !== "") {
    const d = Number(rawDays);
    if (Number.isFinite(d) && d >= 0) severanceDays = Math.round(d);
  }
  if (rawAmount != null && String(rawAmount) !== "") {
    const a = Number(rawAmount);
    if (Number.isFinite(a) && a >= 0) severanceAmount = Math.round(a * 100) / 100;
  }
  if (severanceDays !== auto.severanceDays || severanceAmount !== auto.severanceAmount) {
    severanceAuto = false;
  }

  // Save evidence if provided (reuses the leave/resignation attachment store).
  let evidenceFilename: string | null = null;
  if (file instanceof File && file.size > 0) {
    const saved = await saveLeaveAttachment(user.id, file);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    evidenceFilename = saved.filename;
  }

  const { id, refNo } = createTermination(user.id, {
    userId: employeeId,
    branchId: target.branch_id,
    type,
    reason,
    effectiveDate,
    evidenceFilename,
    tenureDays: auto.tenureDays,
    severanceDays,
    severanceAmount,
    severanceAuto
  });
  logPersonaAction(user.id, "termination.create", id);

  return NextResponse.json({
    ok: true, id, ref_no: refNo,
    severance: { days: severanceDays, amount: severanceAmount, auto: severanceAuto, tenureDays: auto.tenureDays }
  });
}
