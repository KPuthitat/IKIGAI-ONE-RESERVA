import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { verifyAdminPin, hasAdminPin } from "@/lib/admin-pin";
import { revokeApprovedShiftRequest } from "@/lib/shift-requests";

// POST /api/admin/persona/shift-request/[id]/revoke  body { pin, reason }
// Takes back an APPROVED shift request (e.g. an extra-shift that is no longer true): the request is cancelled with the
// reason kept, draft payroll lines for that date are recomputed, the employee is notified. PIN-confirmed and audited.
const Body = z.object({ pin: z.string().max(12), reason: z.string().trim().min(3).max(500) });
const TEXT: Record<string, string> = {
  not_found: "ไม่พบคำขอนี้ในสาขาที่เลือก", not_approved: "คำขอนี้ไม่ได้อยู่ในสถานะอนุมัติ",
  reason_required: "กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร",
  period_locked: "วันนี้อยู่ในรอบจ่ายที่ปิดไปแล้ว ยกเลิกไม่ได้ — ต้องเปิดรอบนั้นกลับเป็นฉบับร่างก่อน"
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: TEXT.reason_required }, { status: 400 });
  if (hasAdminPin(user.id) && !verifyAdminPin(user.id, p.data.pin).ok) return NextResponse.json({ error: "bad_pin" }, { status: 403 });
  const r = revokeApprovedShiftRequest({ branchId, adminId: user.id, id, reason: p.data.reason });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, message: TEXT[r.error] }, { status: r.error === "not_found" ? 404 : 409 });
  logPersonaAction(user.id, "shift_request.revoke", id);
  return NextResponse.json({ ok: true, recomputedPeriods: r.recomputedPeriods });
}
