import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { createStageRequest } from "@/lib/recruita-stage-request";
import type { ApplicationStage } from "@/lib/recruita";

// POST /api/recruita/applications/[id]/stage-request
// Body: { to_stage, pin }
//
// First leg of the dual-admin stage transition. Admin A enters their
// PIN and proposes a new stage. The application's actual stage column
// is NOT touched yet — that happens when Admin B approves (see the
// /[reqId] route). Refuses when:
//   - PIN missing / wrong / locked
//   - A pending request already exists (admin must cancel first)
//   - to_stage equals the current stage
//   - Caller isn't an admin role

const ALL_STAGES: ApplicationStage[] = [
  "applied", "screening", "interview", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

const Body = z.object({
  to_stage: z.enum(ALL_STAGES as [ApplicationStage, ...ApplicationStage[]]),
  pin: z.string().regex(/^\d{4,6}$/)
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const applicationId = Number(params.id);
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" },
      { status: 400 }
    );
  }

  // PIN check first — wrong PINs increment the failed-attempts counter
  // even if everything else is wrong, so brute-force can't hide behind
  // other validation failures.
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
        { error: "locked", message: "PIN ถูกล็อก 15 นาที — รอแล้วลองใหม่" },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "wrong_pin", message: "PIN ไม่ถูกต้อง" },
      { status: 400 }
    );
  }

  const db = getDb();
  const app = db.prepare(
    "SELECT stage FROM recruita_applications WHERE id = ?"
  ).get(applicationId) as { stage: ApplicationStage } | undefined;
  if (!app) {
    return NextResponse.json({ error: "application_not_found" }, { status: 404 });
  }

  const result = createStageRequest({
    applicationId,
    fromStage: app.stage,
    toStage: parsed.data.to_stage,
    requestedBy: user.id
  });
  if (!result.ok) {
    const msg =
      result.error === "same_stage" ? "ตั้ง stage เป็นค่าเดิม ไม่ต้องเปลี่ยน" :
      result.error === "pending_request_exists" ? "มีคำขอเปลี่ยน stage รออนุมัติอยู่ — กรุณายกเลิกก่อนสร้างใหม่" :
      result.error;
    return NextResponse.json({ error: result.error, message: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true, request_id: result.requestId });
}
