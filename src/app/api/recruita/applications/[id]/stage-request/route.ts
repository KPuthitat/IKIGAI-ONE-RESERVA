import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { createStageRequest } from "@/lib/recruita-stage-request";
import { notifyStageChange, notifyExecGroupStageChange } from "@/lib/recruita-notify";
import type { ApplicationStage } from "@/lib/recruita";

/** Owner 2026-06-11: only ใบสมัครใหม่ → คัดกรอง (applied → screening) needs a
 *  second admin to approve. Every other transition is a single-admin direct
 *  change (the requester's PIN is proof enough). */
function needsDualApproval(from: ApplicationStage, to: ApplicationStage): boolean {
  return from === "applied" && to === "screening";
}

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
  "applied", "screening", "interview", "health_check", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

const Body = z.object({
  to_stage: z.enum(ALL_STAGES as [ApplicationStage, ...ApplicationStage[]]),
  pin: z.string().regex(/^\d{4}$/, "PIN ต้องเป็นตัวเลข 4 หลัก"),
  // First work day — required when moving to 'offered' (owner 2026-06-15);
  // shown on the offer card sent to the candidate.
  offer_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Offered compensation — also required at 'offered'. Amount + type so the
  // candidate sees a concrete offer.
  offer_salary: z.number().min(0).max(10_000_000).optional(),
  offer_salary_type: z.enum(["monthly", "hourly"]).optional(),
  // Optional per-candidate special conditions shown on the offer card.
  offer_conditions: z.string().trim().max(1000).optional()
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
        { error: "no_pin", message: "คุณยังไม่ได้ตั้ง PIN — ตั้ง PIN ได้ที่หน้า ลงเวลา (Time Clock) ก่อน" },
        { status: 400 }
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

  const fromStage = app.stage;
  const toStage = parsed.data.to_stage;
  if (fromStage === toStage) {
    return NextResponse.json(
      { error: "same_stage", message: "ตั้ง stage เป็นค่าเดิม ไม่ต้องเปลี่ยน" },
      { status: 400 }
    );
  }
  // Moving to 'offered' requires the first work day + compensation
  // (owner 2026-06-15).
  const offerStartDate = parsed.data.offer_start_date ?? null;
  const offerSalary = parsed.data.offer_salary ?? null;
  const offerSalaryType = parsed.data.offer_salary_type ?? null;
  const offerConditions = (parsed.data.offer_conditions ?? "").trim() || null;
  if (toStage === "offered" && !offerStartDate) {
    return NextResponse.json(
      { error: "offer_start_date_required", message: "กรุณาเลือกวันเริ่มงานวันแรกก่อนเสนองาน" },
      { status: 400 }
    );
  }
  if (toStage === "offered" && (offerSalary == null || offerSalary <= 0 || !offerSalaryType)) {
    return NextResponse.json(
      { error: "offer_salary_required", message: "กรุณากรอกค่าตอบแทนที่เสนอ (จำนวน + รายเดือน/รายชั่วโมง)" },
      { status: 400 }
    );
  }

  // Single-admin transitions: apply immediately (PIN already verified above),
  // then notify — same effect as the legacy /stage route, just PIN-gated.
  if (!needsDualApproval(fromStage, toStage)) {
    if (toStage === "offered") {
      db.prepare(
        "UPDATE recruita_applications SET stage = ?, offer_start_date = ?, offer_salary = ?, offer_salary_type = ?, offer_conditions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(toStage, offerStartDate, offerSalary, offerSalaryType, offerConditions, applicationId);
    } else {
      db.prepare(
        "UPDATE recruita_applications SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(toStage, applicationId);
    }
    void notifyStageChange(applicationId).catch((e) =>
      console.warn("[recruita-stage] notify failed", e));
    void notifyExecGroupStageChange(applicationId).catch((e) =>
      console.warn("[recruita-stage] exec notify failed", e));
    return NextResponse.json({ ok: true, applied: true, stage: toStage });
  }

  // Dual-admin transition (applied → screening): create the pending request;
  // the application stage isn't touched until a second admin approves.
  const result = createStageRequest({
    applicationId,
    fromStage,
    toStage,
    requestedBy: user.id
  });
  if (!result.ok) {
    const msg =
      result.error === "same_stage" ? "ตั้ง stage เป็นค่าเดิม ไม่ต้องเปลี่ยน" :
      result.error === "pending_request_exists" ? "มีคำขอเปลี่ยน stage รออนุมัติอยู่ — กรุณายกเลิกก่อนสร้างใหม่" :
      result.error;
    return NextResponse.json({ error: result.error, message: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true, request_id: result.requestId, dual: true });
}
