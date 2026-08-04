import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { upsertManagerReport } from "@/lib/manager-reports";

// รายงานปิดกะ/สถานการณ์/เข้าประชุม — ฝั่งพนักงาน (owner 2026-08-04).
// "คนที่ปิดกะเป็นคนส่ง": พนักงานคนไหนก็ได้ที่อยู่สาขานั้น (เหมือน shift_close) ส่ง
// รายงานของสาขาที่ตัวเองใช้งานอยู่ได้. แอดมินยังดู/สรุปที่หน้าเตรียมประชุมเหมือนเดิม.
//   POST — ส่ง/แก้รายงานของวัน (upsert รายคน/สาขา/วัน)

const HDATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYEE_ROLES = ["staff", "admin", "super_admin"];
const BACKDATE_WINDOW_DAYS = 7; // เท่ากับหน้าปิดกะ (shift_close)

const Body = z.object({
  report_date: z.string().regex(HDATE),
  shift_summary: z.string().max(20000).optional(),
  situation: z.string().max(20000).optional(),
  meeting_topics: z.string().max(20000).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!EMPLOYEE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // activeBranchId ถูกตรวจว่าเป็นสาขาที่ผู้ใช้สังกัดแล้วใน getSessionUser — ส่งได้
  // เฉพาะสาขาที่ตัวเองใช้งานอยู่ (ไม่มี company_wide สำหรับพนักงาน).
  if (user.activeBranchId == null) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { report_date, shift_summary, situation, meeting_topics } = parsed.data;

  // กันวันอนาคต + ย้อนหลังเกิน 7 วัน (เหมือน shift_close)
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  if (report_date > todayBkk) {
    return NextResponse.json({ error: "future_date" }, { status: 400 });
  }
  const backDays = Math.floor(
    (Date.parse(`${todayBkk}T00:00:00Z`) - Date.parse(`${report_date}T00:00:00Z`)) / 86_400_000
  );
  if (backDays > BACKDATE_WINDOW_DAYS) {
    return NextResponse.json({ error: "backdate_too_old" }, { status: 400 });
  }

  const shift = (shift_summary ?? "").trim();
  const situ = (situation ?? "").trim();
  const topics = (meeting_topics ?? "").trim();
  if (!shift && !situ && !topics) {
    return NextResponse.json({ error: "empty_report" }, { status: 400 });
  }

  const id = upsertManagerReport(getDb(), {
    branchId: user.activeBranchId, reportDate: report_date, authorUserId: user.id,
    shiftSummary: shift, situation: situ, meetingTopics: topics
  });

  logPersonaAction(user.id, "manager_report.save", id);
  return NextResponse.json({ ok: true, id });
}
