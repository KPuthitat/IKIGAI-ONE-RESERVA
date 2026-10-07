import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setSvcAttendanceExemption, svcAttendanceApplies } from "@/lib/svc-attendance";

// POST /api/admin/persona/service-charge/attendance-exemption
//
// "ยกเว้น" one ขาด / ลา / สาย event (owner 2026-10-07): the event stays on record but
// is not counted toward the SVC attendance criteria (events ÷ scheduled days).
// Keyed per (person, day, kind). Same guards as the whole-month waiver: payroll
// access, the person must belong to the acting admin's company, and the month is
// locked once its payout is finalized / paid / posted.

const Body = z.object({
  user_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date"),
  kind: z.enum(["absent", "late", "leave"]),
  exempted: z.boolean(),
  reason: z.string().trim().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const yearMonth = d.date.slice(0, 7);
  if (!svcAttendanceApplies(yearMonth)) {
    return NextResponse.json({ error: "not_applicable", message: "เกณฑ์ขาด/ลา/สาย ใช้กับเดือนกันยายน 2569 เป็นต้นไป" }, { status: 400 });
  }

  const db = getDb();
  const inCompany = db.prepare(`
    SELECT 1 FROM user_branches ub
    JOIN branches b  ON b.id = ub.branch_id
    JOIN branches ab ON ab.company_id = b.company_id
    WHERE ub.user_id = ? AND ab.id = ? LIMIT 1
  `).get(d.user_id, user.activeBranchId);
  if (!inCompany) return NextResponse.json({ error: "user_out_of_scope" }, { status: 403 });

  const locked = db.prepare(`
    SELECT 1 FROM svc_payout_batches
    WHERE year_month = ? AND status IN ('finalized', 'paid', 'posted')
      AND branch_id IN (SELECT branch_id FROM user_branches WHERE user_id = ?)
    LIMIT 1
  `).get(yearMonth, d.user_id);
  if (locked) return NextResponse.json({ error: "payout_locked", message: "ปิดยอดแล้ว แก้ไขไม่ได้ — ปลดล็อคการปิดยอดก่อน" }, { status: 409 });

  setSvcAttendanceExemption({
    userId: d.user_id, date: d.date, kind: d.kind, exempted: d.exempted, byUserId: user.id, reason: d.reason ?? null
  });
  logPersonaAction(user.id, d.exempted ? "svc.attendanceExemption.grant" : "svc.attendanceExemption.revoke", d.user_id);
  return NextResponse.json({ ok: true, exempted: d.exempted });
}
