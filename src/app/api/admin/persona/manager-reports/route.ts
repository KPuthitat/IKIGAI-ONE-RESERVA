import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { listManagerReports, upsertManagerReport } from "@/lib/manager-reports";

// รายงานผู้จัดการ (owner 2026-08-04).
//   POST — ส่ง/แก้รายงานของวัน (upsert รายคน/สาขา/วัน)
//   GET  — ลิสต์รายงานของสาขา (รวมระดับบริษัท) ตามช่วงวันที่ ?from&to
// ผู้จัดการ = role admin; branch = activeBranchId เว้นแต่ company_wide.

const HDATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.object({
  report_date: z.string().regex(HDATE),
  shift_summary: z.string().max(20000).optional(),
  situation: z.string().max(20000).optional(),
  meeting_topics: z.string().max(20000).optional(),
  company_wide: z.boolean().optional()
});

function guard() {
  const user = getSessionUser();
  if (!user) return { err: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { err: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function POST(req: Request) {
  const g = guard();
  if (g.err) return g.err;
  const user = g.user;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { report_date, shift_summary, situation, meeting_topics, company_wide } = parsed.data;

  if (!company_wide && user.activeBranchId == null) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const branchId = company_wide ? null : user.activeBranchId;

  // อย่างน้อยต้องมีเนื้อหาช่องใดช่องหนึ่ง — กันรายงานว่างเปล่า
  const shift = (shift_summary ?? "").trim();
  const situ = (situation ?? "").trim();
  const topics = (meeting_topics ?? "").trim();
  if (!shift && !situ && !topics) {
    return NextResponse.json({ error: "empty_report" }, { status: 400 });
  }

  const db = getDb();
  const id = upsertManagerReport(db, {
    branchId, reportDate: report_date, authorUserId: user.id,
    shiftSummary: shift, situation: situ, meetingTopics: topics
  });

  logPersonaAction(user.id, "manager_report.save", id);
  return NextResponse.json({ ok: true, id });
}

export async function GET(req: Request) {
  const g = guard();
  if (g.err) return g.err;
  const user = g.user;

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const rows = listManagerReports(getDb(), { branchId: user.activeBranchId, from, to });
  return NextResponse.json({ ok: true, reports: rows });
}
