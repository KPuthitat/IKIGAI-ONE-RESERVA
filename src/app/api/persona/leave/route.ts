import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ALL_LEAVE_TYPES, getEligibleLeaveTypesForUser, saveLeaveAttachment, type LeaveType } from "@/lib/leave";

// POST /api/persona/leave — staff submit (multipart/form-data with mandatory file)
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const type = String(form.get("type") || "");
  const date_from = String(form.get("date_from") || "");
  const date_to = String(form.get("date_to") || "");
  const daysStr = String(form.get("days") || "");
  const hoursStr = String(form.get("hours") || "");
  const reason = String(form.get("reason") || "").slice(0, 500);
  const file = form.get("file");

  // Validate type
  if (!ALL_LEAVE_TYPES.includes(type as LeaveType)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  // Validate dates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (date_from > date_to) {
    return NextResponse.json({ error: "date_range_invalid" }, { status: 400 });
  }
  // Validate days/hours
  const days = Number(daysStr);
  const hours = hoursStr ? Number(hoursStr) : null;
  if (!isFinite(days) || days <= 0 || days > 365) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400 });
  }
  if (hours != null && (!isFinite(hours) || hours <= 0 || hours > 24)) {
    return NextResponse.json({ error: "invalid_hours" }, { status: 400 });
  }
  // Mandatory file
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "evidence_required" }, { status: 400 });
  }

  // Eligibility check (gender/employment/pre-approval)
  const userRow = getDb().prepare(
    "SELECT id, gender, employment_type FROM users WHERE id = ?"
  ).get(user.id) as { id: number; gender: string | null; employment_type: string | null };
  const eligible = getEligibleLeaveTypesForUser(userRow);
  if (!eligible.some((t) => t.code === type)) {
    return NextResponse.json({ error: "type_not_eligible" }, { status: 403 });
  }

  // Save attachment
  const saved = await saveLeaveAttachment(user.id, file);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 400 });
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO leave_requests
      (user_id, type, date_from, date_to, days, hours, reason, evidence_filename, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    user.id, type, date_from, date_to, days, hours, reason || null,
    saved.filename, user.id, nowIso
  );

  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
