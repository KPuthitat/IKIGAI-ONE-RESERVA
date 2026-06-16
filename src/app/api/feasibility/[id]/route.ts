import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { coerceInputs } from "@/lib/feasibility";
import { updateProject, deleteProject, getProject, FEASIBILITY_COMPANIES } from "@/lib/feasibility-db";

// PATCH  /api/feasibility/[id] — full update (editor save). Owner-scoped.
// DELETE /api/feasibility/[id] — delete. Owner-scoped.

const Body = z.object({
  company: z.enum(FEASIBILITY_COMPANIES),
  project_name: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).nullable().optional(),
  business_type: z.string().trim().max(200).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  inputs: z.unknown().optional()
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  // Ownership check (also enforced in the UPDATE's WHERE created_by).
  if (!getProject(id, user.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const d = parsed.data;
  const ok = updateProject(id, user.id, {
    company: d.company,
    project_name: d.project_name,
    location: d.location ?? null,
    business_type: d.business_type ?? null,
    status: d.status ?? "draft",
    inputs: coerceInputs(d.inputs)
  });
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const ok = deleteProject(id, user.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
