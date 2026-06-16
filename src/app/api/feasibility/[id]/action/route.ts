import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { duplicateProject, setStatus } from "@/lib/feasibility-db";

// POST /api/feasibility/[id]/action — lightweight list actions that don't need
// the full editor body: duplicate (→ new draft) or archive/unarchive.

const Body = z.object({
  action: z.enum(["duplicate", "archive", "unarchive"])
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  if (parsed.data.action === "duplicate") {
    const newId = duplicateProject(id, user.id);
    if (newId == null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, id: newId });
  }
  const ok = setStatus(id, user.id, parsed.data.action === "archive" ? "archived" : "active");
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
