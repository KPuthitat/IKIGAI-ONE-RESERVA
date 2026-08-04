import { NextResponse } from "next/server";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { suggestActionItems, meetingPrepEnabled, MeetingPrepError } from "@/lib/meeting-prep";

// POST /api/admin/persona/meetings/[id]/suggest-items — ให้ AI เสนอ action item
// จากสรุป/มติการประชุม (owner 2026-08-04). คืนรายการงานเพื่อให้แอดมินตรวจ/เลือก
// ก่อนบันทึกเอง (บันทึกผ่าน .../items เดิม). admin + branch guard, rate-limited.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!meetingPrepEnabled()) {
    return NextResponse.json({ error: "disabled", message: "ฟีเจอร์ AI ปิดอยู่ (ยังไม่ได้ตั้งค่า API key)" }, { status: 400 });
  }

  const meetingId = Number(params.id);
  if (!Number.isInteger(meetingId) || meetingId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const meeting = db.prepare("SELECT id, branch_id, summary FROM meetings WHERE id = ?")
    .get(meetingId) as { id: number; branch_id: number | null; summary: string } | undefined;
  if (!meeting) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (meeting.branch_id != null && !userCanAdminBranch(user, meeting.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const rl = rateLimit(`meeting-suggest:${user.id}`, 5, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limit", message: "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  try {
    const { items, model } = await suggestActionItems(meeting.summary ?? "", user.id, meeting.branch_id);
    return NextResponse.json({ ok: true, items, model });
  } catch (e) {
    if (e instanceof MeetingPrepError) {
      const status = e.code === "empty_summary" ? 400 : e.code === "rate_limit" ? 429 : 502;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: "unknown", message: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" }, { status: 500 });
  }
}
