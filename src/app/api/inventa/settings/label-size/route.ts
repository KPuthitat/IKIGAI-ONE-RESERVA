import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/settings/label-size — set the per-branch INVENTA
// label print size in mm (owner 2026-06-08). super_admin only, scoped to
// the caller's active branch. Default elsewhere is 80×50 mm.

const Body = z.object({
  width_mm: z.number().int().min(20).max(200),
  height_mm: z.number().int().min(20).max(200)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  getDb().prepare(
    "UPDATE branches SET inventa_label_width_mm = ?, inventa_label_height_mm = ? WHERE id = ?"
  ).run(parsed.data.width_mm, parsed.data.height_mm, user.activeBranchId);
  return NextResponse.json({ ok: true });
}
