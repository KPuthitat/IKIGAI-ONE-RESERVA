import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { addOrgMember, removeOrgMember, setOrgManager, setOrgDepartment } from "@/lib/org-chart";

// POST /api/admin/persona/orgchart — edit a branch's org chart.
// action: add | remove | manager | department. The target branch must belong
// to the caller's company (resolved from their active branch).

const Body = z.object({
  action: z.enum(["add", "remove", "manager", "department"]),
  branchId: z.number().int().positive(),
  userId: z.number().int().positive(),
  managerId: z.number().int().positive().nullable().optional(),
  department: z.string().max(60).nullable().optional()
});

function sameCompany(branchId: number, activeBranchId: number): boolean {
  const db = getDb();
  const co = (b: number) =>
    (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(b) as { company_id: number | null } | undefined)?.company_id ?? null;
  const target = co(branchId);
  const active = co(activeBranchId);
  // NULL-company branch is its own company of one → must be the same branch.
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
      const ok = addOrgMember(d.branchId, d.userId);
      if (!ok) return NextResponse.json({ error: "not_branch_member" }, { status: 400 });
      break;
    }
    case "remove":
      removeOrgMember(d.branchId, d.userId);
      break;
    case "manager": {
      const err = setOrgManager(d.branchId, d.userId, d.managerId ?? null);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      break;
    }
    case "department":
      setOrgDepartment(d.branchId, d.userId, d.department ?? null);
      break;
  }
  return NextResponse.json({ ok: true });
}
