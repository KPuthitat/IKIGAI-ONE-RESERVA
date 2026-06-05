import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isBranchChainReady, pickInitialTier } from "@/lib/approval-tiers";
import { notifyLeaveEvent, notifyHrLeaveRequest } from "@/lib/approval-notify";
import {
  ALL_LEAVE_TYPES, getEligibleLeaveTypesForUser, saveLeaveAttachment,
  analyzeLongLeave, detectWeekendExtension, getPublicHolidaySet, generateRefNo,
  type LeaveType
} from "@/lib/leave";

// POST /api/persona/leave — staff submit (multipart/form-data)
// Phase 1C v4 changes:
// - reason mandatory (ทุกประเภท)
// - block past dates (ไม่อนุญาตลงย้อนหลัง)
// - evidence required ตาม leave_types.requires_evidence (personal/annual = optional)
// - is_special_request flag → bypass soft rules + escalate
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  // Same-branch attribution as the clock endpoint — leave_requests
  // gets tagged with the branch the staff is currently set to (via
  // /staff/branch-picker). This is what /admin/persona/leave filters
  // on so admin sees only their branch's pending requests.
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

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
  const reason = String(form.get("reason") || "").trim().slice(0, 500);
  const isSpecial = String(form.get("is_special_request") || "") === "1";
  const replacesIdStr = String(form.get("replaces_id") || "");
  const replacesId = replacesIdStr ? Number(replacesIdStr) : null;
  const file = form.get("file");

  // Reason mandatory (Phase 1C v4 #5)
  if (!reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 400 });
  }
  if (!ALL_LEAVE_TYPES.includes(type as LeaveType)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (date_from > date_to) {
    return NextResponse.json({ error: "date_range_invalid" }, { status: 400 });
  }

  const days = Number(daysStr);
  const hours = hoursStr ? Number(hoursStr) : null;
  if (!isFinite(days) || days <= 0 || days > 365) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400 });
  }
  if (hours != null && (!isFinite(hours) || hours <= 0 || hours > 24)) {
    return NextResponse.json({ error: "invalid_hours" }, { status: 400 });
  }

  // Eligibility check
  const userRow = getDb().prepare(
    "SELECT id, gender, employment_type, hire_date, weekly_off_days FROM users WHERE id = ?"
  ).get(user.id) as {
    id: number; gender: string | null; employment_type: string | null;
    hire_date: string | null; weekly_off_days: string | null;
  };
  const eligible = getEligibleLeaveTypesForUser(userRow);
  const matchedType = eligible.find((t) => t.code === type);
  if (!matchedType) {
    return NextResponse.json({ error: "type_not_eligible" }, { status: 403 });
  }

  // Past-date rule (owner 2026-06-05): types that REQUIRE pre-approval
  // (annual / personal / etc.) must still be future-dated. Types that do
  // NOT (sick / pt_emergency) MAY be backdated — you can't notify a
  // sudden illness in advance — but only within a 14-day window so it
  // can't be abused to log months-old absences.
  const BACKDATE_WINDOW_DAYS = 14;
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date_from < todayBkk) {
    if (matchedType.requires_pre_approval) {
      return NextResponse.json({ error: "past_date_not_allowed" }, { status: 400 });
    }
    const backDays = Math.floor(
      (Date.parse(`${todayBkk}T00:00:00Z`) - Date.parse(`${date_from}T00:00:00Z`)) / 86_400_000
    );
    if (backDays > BACKDATE_WINDOW_DAYS) {
      return NextResponse.json({ error: "backdate_too_old" }, { status: 400 });
    }
  }

  // Evidence required check (per type)
  const hasFile = file instanceof File && file.size > 0;
  if (matchedType.requires_evidence && !hasFile) {
    return NextResponse.json({ error: "evidence_required" }, { status: 400 });
  }

  // Long-leave / consecutive-stretch check (เฉพาะ personal & annual)
  if (type === "personal" || type === "annual") {
    const analysis = analyzeLongLeave({
      userId: user.id,
      type: type as LeaveType,
      dateFrom: date_from,
      dateTo: date_to,
      hireDate: userRow.hire_date
    });
    const inStandardRules =
      analysis.status === "self_service" &&
      (analysis.meetsAnnualEligibility !== false);

    if (!inStandardRules && !isSpecial) {
      return NextResponse.json(
        { error: "exceeds_rules_use_special_track", analysis },
        { status: 400 }
      );
    }
  }

  // Phase 1C v8: ตรวจ weekly_off_days + เสาร์-อาทิตย์ + วันหยุดนักขัตฤกษ์
  const we = detectWeekendExtension(
    userRow.weekly_off_days,
    date_from, date_to,
    getPublicHolidaySet()
  );
  // หัก off-day จากวันลาทั้งหมด — ถ้าเหลือ 0 = เลือกเฉพาะ off-day → block
  const totalDaysInRange = Math.max(1, Math.floor(
    (new Date(`${date_to}T00:00:00Z`).getTime() - new Date(`${date_from}T00:00:00Z`).getTime()) / 86400000
  ) + 1);
  const adjustedDays = Math.max(0, totalDaysInRange - we.onWeeklyOffDay.length);
  if (we.fallsOnUserOffDay && adjustedDays === 0) {
    return NextResponse.json(
      { error: "leave_on_weekly_off_day_not_allowed", weekendInfo: we },
      { status: 400 }
    );
  }
  // Soft (special-track) — เสาร์/อาทิตย์ + วันหยุดนักขัตฤกษ์ — เฉพาะ personal/annual
  if (type === "personal" || type === "annual") {
    if ((we.hasWeekendLeave || we.fallsOnPublicHoliday) && !isSpecial) {
      return NextResponse.json(
        { error: "weekend_extension_use_special_track", weekendInfo: we },
        { status: 400 }
      );
    }
  }

  // Save attachment ถ้ามี (และผ่าน validation)
  let evidenceFilename: string | null = null;
  if (hasFile) {
    const saved = await saveLeaveAttachment(user.id, file as File);
    if (!saved.ok) {
      return NextResponse.json({ error: saved.error }, { status: 400 });
    }
    evidenceFilename = saved.filename;
  }

  const db = getDb();

  // Validate replaces_id (ถ้ามี) — ต้องเป็น request เดิมของ user ที่ status = revision_requested
  if (replacesId != null) {
    const orig = db.prepare(
      "SELECT user_id, status FROM leave_requests WHERE id = ?"
    ).get(replacesId) as { user_id: number; status: string } | undefined;
    if (!orig || orig.user_id !== user.id || orig.status !== "revision_requested") {
      return NextResponse.json({ error: "invalid_replaces_id" }, { status: 400 });
    }
  }

  // Branch-level chain of command (2026-05-26). The branch must have
  // at least 1 supervisor + 1 executive configured at
  // /admin/persona/approval-chain or we reject the submission with a
  // clear error. Owner direction: NO super_admin fallback — better
  // for staff to get an error message than to route to the wrong
  // approver because the branch wasn't set up yet.
  if (!isBranchChainReady(user.activeBranchId)) {
    return NextResponse.json(
      {
        error: "approval_chain_not_configured",
        message: "สาขายังไม่ได้ตั้งสายบังคับบัญชา — กรุณาแจ้งแอดมินตั้งค่าที่หน้า /admin/persona/approval-chain ก่อน"
      },
      { status: 409 }
    );
  }
  // Self-skip: a requester who is themselves a supervisor (tier 1)
  // starts at tier 2. pickInitialTier handles this.
  const initialTier = pickInitialTier(user.activeBranchId, user.id);

  const nowIso = new Date().toISOString();
  const refNo = generateRefNo("leave_requests");
  const result = db.prepare(`
    INSERT INTO leave_requests
      (user_id, type, date_from, date_to, days, hours, reason, evidence_filename,
       status, created_by, is_special_request, replaces_id, ref_no, branch_id, created_at,
       current_approver_user_id, escalated_to_level, last_escalated_at, approval_history,
       current_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL, 0, ?, '[]', ?)
  `).run(
    user.id, type, date_from, date_to, days, hours, reason,
    evidenceFilename, user.id, isSpecial ? 1 : 0, replacesId, refNo,
    user.activeBranchId, nowIso,
    nowIso, initialTier
  );

  // Fire-and-forget owl notification — DM primary approver +
  // backup-in-chain. Failures logged at the helper level; the API
  // response doesn't depend on push success.
  notifyLeaveEvent({
    requestId: Number(result.lastInsertRowid),
    event: "submitted"
  }).catch((e) => console.warn("leave notify (submitted) failed", e));
  // Also notify the HR group (IKIGAI RECRUIT x HR) so HR sees every
  // leave request in one place (owner 2026-06-06).
  notifyHrLeaveRequest(Number(result.lastInsertRowid))
    .catch((e) => console.warn("leave notify HR failed", e));

  return NextResponse.json({ ok: true, id: result.lastInsertRowid, ref_no: refNo });
}
