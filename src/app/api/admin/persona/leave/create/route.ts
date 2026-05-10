import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ALL_LEAVE_TYPES, saveLeaveAttachment, generateRefNo, type LeaveType } from "@/lib/leave";

// POST /api/admin/persona/leave/create — admin บันทึกการลาให้พนักงาน
// (ใช้สำหรับลาก่อนเริ่มใช้ระบบ หรือกรณีพิเศษ — auto-approved)
//
// Branch attribution (Phase 2): the row is tagged with the admin's
// currently-active branch. Admin can only file on behalf of staff
// assigned to that same branch — the staff dropdown on the leave
// admin page already filters that way.
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const target_user_id = Number(form.get("user_id"));
  const type = String(form.get("type") || "");
  const date_from = String(form.get("date_from") || "");
  const date_to = String(form.get("date_to") || "");
  const days = Number(form.get("days"));
  const hoursStr = String(form.get("hours") || "");
  const hours = hoursStr ? Number(hoursStr) : null;
  const reason = String(form.get("reason") || "").slice(0, 500);
  const note = String(form.get("note") || "").slice(0, 500);
  const file = form.get("file");

  if (!Number.isInteger(target_user_id) || target_user_id <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  // Verify the target staff is assigned to admin's active branch.
  // The dropdown filters this server-side, but a curious admin
  // could POST any user_id — defense-in-depth.
  const db = getDb();
  const targetBranches = db.prepare(
    "SELECT branch_id FROM user_branches WHERE user_id = ?"
  ).all(target_user_id) as Array<{ branch_id: number }>;
  if (!targetBranches.some((b) => b.branch_id === user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  if (!ALL_LEAVE_TYPES.includes(type as LeaveType)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to) || date_from > date_to) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!isFinite(days) || days <= 0 || days > 365) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400 });
  }
  if (hours != null && (!isFinite(hours) || hours <= 0 || hours > 24)) {
    return NextResponse.json({ error: "invalid_hours" }, { status: 400 });
  }

  // attachment optional for admin (กรณีลาเก่ายังไม่มีหลักฐาน)
  let evidenceFilename: string | null = null;
  if (file instanceof File && file.size > 0) {
    const saved = await saveLeaveAttachment(target_user_id, file);
    if (!saved.ok) {
      return NextResponse.json({ error: saved.error }, { status: 400 });
    }
    evidenceFilename = saved.filename;
  }

  const nowIso = new Date().toISOString();
  const refNo = generateRefNo("leave_requests");
  const result = db.prepare(`
    INSERT INTO leave_requests
      (user_id, type, date_from, date_to, days, hours, reason,
       evidence_filename, status, decided_by, decided_at, decision_note,
       created_by, ref_no, branch_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    target_user_id, type, date_from, date_to, days, hours, reason || null,
    evidenceFilename, user.id, nowIso, note || "ลงโดยผู้ดูแล (backdated)",
    user.id, refNo, user.activeBranchId, nowIso
  );

  return NextResponse.json({ ok: true, id: result.lastInsertRowid, ref_no: refNo });
}
