import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { summarizeWeeklyReports, meetingPrepEnabled, MeetingPrepError } from "@/lib/meeting-prep";

// POST /api/admin/persona/meeting-prep/summarize — รวมรายงานผู้จัดการช่วง [from,to]
// ของสาขา (รวมระดับบริษัท) แล้วให้ AI สรุปเป็นวาระประชุม เก็บผลไว้อ่านวันพุธ.
// ปุ่มกด, admin-only, rate-limited (คิดค่า AI).

const HDATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  from: z.string().regex(HDATE),
  to: z.string().regex(HDATE),
  company_wide: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!meetingPrepEnabled()) {
    return NextResponse.json({ error: "disabled", message: "ฟีเจอร์ AI ปิดอยู่ (ยังไม่ได้ตั้งค่า API key)" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { from, to, company_wide } = parsed.data;
  if (from > to) return NextResponse.json({ error: "range_invalid", message: "ช่วงวันที่ไม่ถูกต้อง" }, { status: 400 });
  // ป้องกันข้อมูลข้ามสาขา: สรุประดับบริษัท (branch_id NULL = ไม่กรองสาขา = เห็นทุก
  // สาขา) จำกัดเฉพาะ super_admin. แอดมินสาขาสรุปได้เฉพาะสาขาที่ตัวเองใช้งานอยู่.
  if (company_wide && user.role !== "super_admin") {
    return NextResponse.json({ error: "company_forbidden", message: "สรุประดับบริษัทได้เฉพาะผู้ดูแลระบบสูงสุด" }, { status: 403 });
  }
  // ช่วงกว้างเกินไป (สรุป "รายสัปดาห์") — กันคำขอที่ดึงรายงานจำนวนมหาศาลไปให้ AI
  const spanDays = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  if (spanDays > 62) {
    return NextResponse.json({ error: "range_too_wide", message: "ช่วงกว้างเกินไป — เลือกไม่เกิน ~2 เดือน" }, { status: 400 });
  }

  if (!company_wide && user.activeBranchId == null) {
    return NextResponse.json({ error: "no_active_branch", message: "กรุณาเลือกสาขาก่อน" }, { status: 400 });
  }
  const branchId = company_wide ? null : user.activeBranchId;

  // Cost-bearing LLM call — cap per user (5/min), same as fin-analysis.
  const rl = rateLimit(`meeting-prep:${user.id}`, 5, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limit", message: "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  const db = getDb();
  const branchName = branchId == null
    ? "ทั้งบริษัท"
    : ((db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? "สาขา");

  try {
    const result = await summarizeWeeklyReports(db, {
      branchId, branchName, from, to, userId: user.id
    });
    logPersonaAction(user.id, "meeting_prep.summarize", result.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof MeetingPrepError) {
      const status = e.code === "no_reports" ? 400 : e.code === "rate_limit" ? 429 : 502;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: "unknown", message: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" }, { status: 500 });
  }
}
