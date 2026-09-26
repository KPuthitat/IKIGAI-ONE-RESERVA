import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { openPeriodForUserDate } from "@/lib/ot-backdate";
import { actualWorkedMinutesForUserDate, effectiveShiftStartForUserDate, scheduledShiftEndForUserDate } from "@/lib/roster";

// POST /api/persona/ot-requests/backdate — a staff member files OT for a PAST
// day (owner 2026-09-26). Covers late-end (requested_until, required) and
// early-start (requested_from, optional). Allowed ONLY when the day sits inside
// a payroll period that is still OPEN (draft), so a finalized/paid period can't
// be reopened. Creates a PENDING request in the shared ot_requests table; the
// existing OT approval flow + pay engine take it from there. Re-filing resets
// the submitted segment(s) to pending.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_until: z.string().regex(HHMM),
  requested_from: z.string().regex(HHMM).nullish(),
});

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { work_date, requested_until } = parsed.data;
  const requested_from = parsed.data.requested_from ?? null;
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch", message: "ยังไม่ได้เลือกสาขา" }, { status: 400 });

  // Backdated only — today's OT is filed at clock-out.
  if (work_date >= todayBkk()) {
    return NextResponse.json({ error: "not_backdated", message: "หน้านี้สำหรับขอ OT ย้อนหลัง — ของวันนี้ให้ขอตอนกดออกงาน" }, { status: 400 });
  }

  const db = getDb();
  const employmentType = (db.prepare("SELECT employment_type FROM users WHERE id = ?").get(user.id) as { employment_type: string | null } | undefined)?.employment_type ?? null;
  // Gate on an OPEN payroll period that covers the day for this user.
  const period = openPeriodForUserDate(db, { branchId, employmentType, workDate: work_date });
  if (!period) {
    return NextResponse.json({ error: "period_closed", message: "วันที่นี้อยู่นอกรอบเงินเดือนที่ยังเปิดอยู่ — ขอย้อนหลังไม่ได้" }, { status: 400 });
  }

  // The day must have been ACTUALLY worked (the page enforces this, but the API
  // is the trust boundary) and have a scheduled shift to measure OT against.
  if (actualWorkedMinutesForUserDate(branchId, user.id, work_date) <= 0) {
    return NextResponse.json({ error: "not_worked", message: "วันนี้ไม่มีบันทึกลงเวลาทำงาน — ขอ OT ย้อนหลังไม่ได้" }, { status: 400 });
  }
  const schedStart = effectiveShiftStartForUserDate(user.id, branchId, work_date);
  const schedEnd = scheduledShiftEndForUserDate(user.id, branchId, work_date);
  if (!schedEnd) {
    return NextResponse.json({ error: "no_shift", message: "วันนี้ไม่มีกะในตาราง จึงคิด OT ไม่ได้" }, { status: 400 });
  }
  // At least one segment must extend beyond the scheduled shift, else the request
  // credits nothing (avoids a no-op that just clutters the approval queue).
  const hasLate = requested_until > schedEnd;
  const hasEarly = requested_from != null && schedStart != null && requested_from < schedStart;
  if (!hasLate && !hasEarly) {
    return NextResponse.json({ error: "no_ot", message: "ยังไม่มีเวลาล่วงเวลา — ต้องอยู่เกินเวลาเลิกกะ หรือมาก่อนเวลาเข้ากะ" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const setEarly = requested_from != null;
  // requested_until (late) is always (re)submitted → pending. The early segment
  // is updated only when provided, so re-filing late-only never wipes an
  // existing (possibly approved) early-start.
  db.prepare(`
    INSERT INTO ot_requests (user_id, branch_id, work_date, requested_until, requested_from, status, early_status, created_at)
    VALUES (@user, @branch, @date, @until, @from, 'pending', @earlyStatus, @now)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      requested_until = excluded.requested_until,
      branch_id = excluded.branch_id,
      status = 'pending',
      requested_from = CASE WHEN @setEarly THEN excluded.requested_from ELSE ot_requests.requested_from END,
      early_status  = CASE WHEN @setEarly THEN 'pending' ELSE ot_requests.early_status END,
      -- Re-filing both segments voids prior decisions; a late-only re-file keeps
      -- the (possibly approved) early segment's approver/decision-time.
      decided_by = CASE WHEN @setEarly THEN NULL ELSE ot_requests.decided_by END,
      decided_at = CASE WHEN @setEarly THEN NULL ELSE ot_requests.decided_at END
      -- created_at preserved on re-file (matches the other OT routes)
  `).run({
    user: user.id, branch: branchId, date: work_date, until: requested_until,
    from: requested_from, earlyStatus: setEarly ? "pending" : null,
    now, setEarly: setEarly ? 1 : 0,
  });

  // No immediate LINE push — pending OT is summarised in the daily
  // pending-requests digest to the HR group (owner 2026-06-08).
  return NextResponse.json({ ok: true });
}
