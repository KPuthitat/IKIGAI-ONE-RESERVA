import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getManagerReport, deleteManagerReport, updateManagerReport } from "@/lib/manager-reports";

const PatchBody = z.object({
  pin: z.string(),
  shift_summary: z.string().max(20000).optional(),
  situation: z.string().max(20000).optional(),
  meeting_topics: z.string().max(20000).optional()
});

// PATCH /api/admin/persona/manager-reports/[id] — แก้ไขรายงาน. เฉพาะผู้เขียนเอง
// และต้องยืนยันด้วย PIN ของตัวเอง (owner 2026-09-03).
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  const row = getManagerReport(db, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // แก้ได้เฉพาะรายงานที่ตัวเองเพิ่ม (owner 2026-09-03).
  if (row.author_user_id !== user.id) {
    return NextResponse.json({ error: "not_author", message: "แก้ได้เฉพาะรายงานที่ตัวเองเพิ่ม" }, { status: 403 });
  }
  const pin = verifyAdminPin(user.id, (d.pin ?? "").trim());
  if (!pin.ok) {
    return NextResponse.json(
      { error: pin.reason, message: pin.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
      { status: 401 }
    );
  }
  const shift = (d.shift_summary ?? "").trim();
  const situ = (d.situation ?? "").trim();
  const topics = (d.meeting_topics ?? "").trim();
  if (!shift && !situ && !topics) return NextResponse.json({ error: "empty_report", message: "กรอกอย่างน้อย 1 ช่อง" }, { status: 400 });

  updateManagerReport(db, id, { shiftSummary: shift, situation: situ, meetingTopics: topics });
  logPersonaAction(user.id, "manager_report.edit", id);
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/persona/manager-reports/[id] — ลบรายงาน. ผู้เขียนเอง, แอดมิน
// ของสาขานั้น, หรือ super_admin ลบได้ (รายงานระดับบริษัทให้ผู้เขียน/super_admin).
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = getManagerReport(db, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const isAuthor = row.author_user_id === user.id;
  const canBranch = row.branch_id != null && userCanAdminBranch(user, row.branch_id);
  const isSuper = user.role === "super_admin";
  if (!isAuthor && !canBranch && !isSuper) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  deleteManagerReport(db, id);
  logPersonaAction(user.id, "manager_report.delete", id);
  return NextResponse.json({ ok: true });
}
