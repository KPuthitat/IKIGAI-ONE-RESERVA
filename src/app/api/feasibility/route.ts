import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { coerceInputs } from "@/lib/feasibility";
import { createProject } from "@/lib/feasibility-db";

// POST /api/feasibility — create a feasibility project. company is a free
// string (chosen from the Global companies list) — inputs coerced to the full
// shape so a blank/partial body can't break the engine.

const Body = z.object({
  company: z.string().trim().min(1).max(100),
  project_name: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).nullable().optional(),
  business_type: z.string().trim().max(200).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  inputs: z.unknown().optional()
});

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  const id = createProject(user.id, {
    company: d.company,
    project_name: d.project_name,
    location: d.location ?? null,
    business_type: d.business_type ?? null,
    status: d.status ?? "draft",
    inputs: coerceInputs(d.inputs)
  });
  return NextResponse.json({ ok: true, id });
}
