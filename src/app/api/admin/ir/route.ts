import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  listReports, createReport, IR_CATEGORY_KEYS,
  type IrStatus, type IrSeverity, type IrIncidentType
} from "@/lib/ir-db";

// GET  /api/admin/ir            — list this branch's incident reports
// POST /api/admin/ir            — file a new report
//
// Gate: requirePermission("ir.manage"). The reporter identity is taken from
// the session; a report may be filed anonymously (is_anonymous), in which case
// we never persist reporter_user_id.

const StatusEnum = z.enum(["new", "reviewing", "action", "closed", "dismissed"]);
const TypeEnum = z.enum(["near_miss", "actual", "complaint"]);

const CreateBody = z.object({
  occurred_at: z.string().trim().min(1).max(40),
  location_detail: z.string().trim().max(300).optional(),
  category: z.string().trim().refine((c) => IR_CATEGORY_KEYS.includes(c), "unknown_category"),
  incident_type: TypeEnum,
  severity: z.number().int().min(1).max(5),
  description: z.string().trim().min(1).max(4000),
  immediate_action: z.string().trim().max(4000).optional(),
  anonymous: z.boolean().optional()
}).strict();

function ctx() {
  const user = requirePermission("ir.manage");
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET(req: Request) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "all";
  const status = (["new", "reviewing", "action", "closed", "dismissed", "open", "all"]
    .includes(statusParam) ? statusParam : "all") as IrStatus | "open" | "all";
  const sevParam = Number(url.searchParams.get("severity"));
  const severity = (sevParam >= 1 && sevParam <= 5 ? sevParam : undefined) as IrSeverity | undefined;
  const category = url.searchParams.get("category") || undefined;
  const reports = listReports({ branchId, status, severity, category });
  return NextResponse.json({ ok: true, reports });
}

export async function POST(req: Request) {
  const { user, branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const report = createReport({
    branchId,
    reporterUserId: user.id,
    isAnonymous: d.anonymous === true,
    occurredAt: d.occurred_at,
    locationDetail: d.location_detail ?? null,
    category: d.category,
    incidentType: d.incident_type as IrIncidentType,
    severity: d.severity as IrSeverity,
    description: d.description,
    immediateAction: d.immediate_action ?? null
  });
  const reports = listReports({ branchId, status: "all" });
  return NextResponse.json({ ok: true, report, reports });
}
