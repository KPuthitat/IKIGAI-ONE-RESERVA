import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { approveStageRequest, cancelStageRequest } from "@/lib/recruita-stage-request";

// POST   /api/recruita/applications/[id]/stage-request/[reqId]
//   Body: { pin }
//   Approve the pending request. Admin B (different from requester)
//   must enter their PIN. On success the application's stage column
//   flips and notifyStageChange fires.
//
// DELETE /api/recruita/applications/[id]/stage-request/[reqId]
//   Optional body: { reason }
//   Cancel a pending request. Allowed for the requester or any
//   super_admin. PIN not required to cancel — owners shouldn't be
//   locked out of cancelling their own typo.

const ApproveBody = z.object({
  pin: z.string().regex(/^\d{4,6}$/)
});

const CancelBody = z.object({
  reason: z.string().max(500).optional()
});

export async function POST(
  req: Request,
  { params }: { params: { id: string; reqId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const reqId = Number(params.reqId);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = ApproveBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "ต้องใส่ PIN" },
      { status: 400 }
    );
  }

  const pinCheck = verifyAdminPin(user.id, parsed.data.pin);
  if (!pinCheck.ok) {
    if (pinCheck.reason === "no_pin") {
      return NextResponse.json(
        { error: "no_pin", message: "คุณยังไม่ได้ตั้ง PIN — ตั้งที่ /admin/me/pin ก่อน" },
        { status: 400 }
      );
    }
    if (pinCheck.reason === "locked") {
      return NextResponse.json(
        { error: "locked", message: "PIN ถูกล็อก 15 นาที" },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "wrong_pin", message: "PIN ไม่ถูกต้อง" },
      { status: 400 }
    );
  }

  const result = await approveStageRequest({
    requestId: reqId,
    approverUserId: user.id
  });
  if (!result.ok) {
    const msg =
      result.error === "not_found" ? "ไม่พบคำขอ" :
      result.error === "status_approved" ? "คำขอนี้อนุมัติแล้ว" :
      result.error === "status_cancelled" ? "คำขอนี้ถูกยกเลิก" :
      result.error === "status_expired" ? "คำขอนี้หมดอายุแล้ว" :
      result.error === "expired" ? "คำขอนี้หมดอายุแล้ว — สร้างคำขอใหม่" :
      result.error === "same_user_cannot_approve" ? "ผู้ขอกับผู้อนุมัติต้องเป็นคนละคน" :
      result.error === "stage_changed_under_us" ? "สถานะของใบสมัครเปลี่ยนแปลงไปแล้ว — คำขอนี้ใช้ไม่ได้" :
      result.error;
    return NextResponse.json({ error: result.error, message: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true, to_stage: result.toStage });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string; reqId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const reqId = Number(params.reqId);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = CancelBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const result = cancelStageRequest({
    requestId: reqId,
    cancelledBy: user.id,
    reason: parsed.data.reason,
    isSuperAdmin: user.role === "super_admin"
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
