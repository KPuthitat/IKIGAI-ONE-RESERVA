import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  getReport, updateReport, IR_CATEGORY_KEYS,
  type IrStatus, type IrSeverity
} from "@/lib/ir-db";

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
  const report = getReport(id, branchId);
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
  return NextResponse.json({ ok: true, report });
}
