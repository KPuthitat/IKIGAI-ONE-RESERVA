import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  addOrgPlacement, removeOrgPlacement, addOrgParent, removeOrgParent, setOrgNodeDepartment
} from "@/lib/org-chart";

// POST /api/admin/persona/orgchart — edit a branch's org chart (v2, placements).
// action: add | remove | add-parent | remove-parent | department. The target
// branch must belong to the caller's company (resolved from their active branch).

const Body = z.object({
  action: z.enum(["add", "remove", "add-parent", "remove-parent", "department"]),
  branchId: z.number().int().positive(),
  userId: z.number().int().positive().optional(),
  nodeId: z.number().int().positive().optional(),
  parentNodeId: z.number().int().positive().nullable().optional(),
  department: z.string().max(60).nullable().optional()
});

function sameCompany(branchId: number, activeBranchId: number): boolean {
  const db = getDb();
  const co = (b: number) =>
    (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(b) as { company_id: number | null } | undefined)?.company_id ?? null;
  const target = co(branchId), active = co(activeBranchId);
  return target != null && active != null ? target === active : branchId === activeBranchId;
}

export async function POST(req: Request) {
  const user = requirePermission("persona.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (!sameCompany(d.branchId, user.activeBranchId)) {
    return NextResponse.json({ error: "forbidden_branch" }, { status: 403 });
  }

  switch (d.action) {
    case "add": {
      if (d.userId == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      const nodeId = addOrgPlacement(d.branchId, d.userId, d.parentNodeId ?? null);
      if (nodeId == null) return NextResponse.json({ error: "not_addable" }, { status: 400 });
      return NextResponse.json({ ok: true, nodeId });
    }
    case "remove":
      if (d.nodeId == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      removeOrgPlacement(d.branchId, d.nodeId);
      break;
    case "add-parent": {
      if (d.nodeId == null || d.parentNodeId == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      const err = addOrgParent(d.branchId, d.nodeId, d.parentNodeId);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      break;
    }
    case "remove-parent":
      if (d.nodeId == null || d.parentNodeId == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      removeOrgParent(d.branchId, d.nodeId, d.parentNodeId);
      break;
    case "department":
      if (d.nodeId == null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      setOrgNodeDepartment(d.branchId, d.nodeId, d.department ?? null);
      break;
  }
  return NextResponse.json({ ok: true });
}
