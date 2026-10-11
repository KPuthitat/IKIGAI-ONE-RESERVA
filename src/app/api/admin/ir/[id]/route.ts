import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import {
  getReport, getReportDetail, updateReport, deleteReport, IR_CATEGORY_KEYS,
  type IrStatus, type IrSeverity
} from "@/lib/ir-db";
import { notifyIrReporterClosedAsync } from "@/lib/ir-line";

const isTerminal = (s: string) => s === "closed" || s === "dismissed";

// GET   /api/admin/ir/[id]   — one report (branch-scoped)
// PATCH /api/admin/ir/[id]   — RM review: status flow + PDCA fields

const StatusEnum = z.enum(["new", "reviewing", "action", "closed", "dismissed"]);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);

const PatchBody = z.object({
  status: StatusEnum.optional(),
  severity: z.number().int().min(1).max(5).optional(),
  category: z.string().trim().refine((c) => IR_CATEGORY_KEYS.includes(c), "unknown_category").optional(),
  root_cause: z.string().trim().max(4000).nullable().optional(),
  corrective_action: z.string().trim().max(4000).nullable().optional(),
  assigned_to: z.number().int().positive().nullable().optional(),
  due_date: dateStr.nullable().optional(),
  discussed_at: dateStr.nullable().optional()
}).strict();

function ctx() {
  const user = requirePermission("ir.manage");
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const report = getReportDetail(id, branchId);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, report });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { user, branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const before = getReport(id, branchId);
  const report = updateReport(id, branchId, {
    status: d.status as IrStatus | undefined,
    severity: d.severity as IrSeverity | undefined,
    category: d.category,
    rootCause: d.root_cause,
    correctiveAction: d.corrective_action,
    assignedTo: d.assigned_to,
    dueDate: d.due_date,
    discussedAt: d.discussed_at
  }, user.id);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // The case just reached closed / dismissed → tell the reporter on LINE
  // (owner 2026-10-02). Fire-and-forget; anonymous reports are skipped.
  if (before && !isTerminal(before.status) && isTerminal(report.status)) notifyIrReporterClosedAsync(branchId, id);
  // Detail shape (RCA + people) so the review page re-renders in one piece.
  return NextResponse.json({ ok: true, report: getReportDetail(id, branchId) });
}

// DELETE /api/admin/ir/[id]  { admin_pin }
// Removing an incident is permanent, so only the top executive (the owner, super_admin) may do it,
// with their PIN. What was removed is written to the activity log.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const { user, branchId } = ctx();
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden", message: "เฉพาะผู้บริหารสูงสุดเท่านั้นที่ลบได้" }, { status: 403 });
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { admin_pin?: string };
  if (!body.admin_pin) return NextResponse.json({ error: "pin_required", message: "กรุณาใส่ PIN" }, { status: 400 });
  const pin = verifyAdminPin(user.id, body.admin_pin);
  if (!pin.ok) {
    return NextResponse.json({ error: pin.reason, message: pin.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" }, { status: pin.reason === "no_pin" ? 400 : 403 });
  }
  const gone = deleteReport(id, branchId);
  if (!gone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  logPersonaAction(user.id, `ir.delete ${gone.code ?? id} (${gone.status}, severity ${gone.severity}, ${gone.occurredAt.slice(0, 10)})`, id);
  return NextResponse.json({ ok: true });
}
