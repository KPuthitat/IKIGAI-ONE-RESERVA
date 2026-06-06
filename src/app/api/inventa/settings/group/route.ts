import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/settings/group — set the active branch's INVENTA LINE
// group id + label (owner 2026-06-06). super_admin only; the branch is
// always the caller's active branch (no branch_id in the body, so no
// cross-branch escalation). Empty group_id clears it → falls back to the
// shared global group.

const Body = z.object({
  group_id: z.string().max(100).nullable().optional(),
  group_name: z.string().max(100).nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const gid = (parsed.data.group_id ?? "").trim();
  if (gid && !/^[CRU][0-9a-f]{32}$/i.test(gid)) {
    return NextResponse.json({ error: "invalid_group_id" }, { status: 400 });
  }
  const gname = (parsed.data.group_name ?? "").trim();
  getDb().prepare(
    "UPDATE branches SET inventa_group_id = ?, inventa_group_name = ? WHERE id = ?"
  ).run(gid || null, gname || null, user.activeBranchId);
  return NextResponse.json({ ok: true });
}
