import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { updateDraftVersion, submitVersion, approveVersion, rejectVersion } from "@/lib/quality-docs";

// PATCH /api/admin/persona/quality/versions/[vid] — edit a draft or run a
// workflow action (submit / approve / reject) on a version.

const Body = z.object({
  action: z.enum(["edit", "submit", "approve", "reject"]),
  content: z.string().max(100_000).nullable().optional(),
  change_summary: z.string().max(500).nullable().optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reject_reason: z.string().trim().max(500).optional()
});

export async function PATCH(req: Request, { params }: { params: { vid: string } }) {
  const user = requirePermission("quality.manage");
  const vid = Number(params.vid);
  if (!Number.isInteger(vid) || vid <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  const db = getDb();

  if (d.action === "edit") {
    const patch: Record<string, unknown> = {};
    if ("content" in d) patch.content = d.content ?? null;
    if ("change_summary" in d) patch.changeSummary = d.change_summary ?? null;
    if ("effective_date" in d) patch.effectiveDate = d.effective_date ?? null;
    if (!updateDraftVersion(db, vid, patch)) return NextResponse.json({ error: "not_editable" }, { status: 400 });
  } else if (d.action === "submit") {
    if (!submitVersion(db, vid)) return NextResponse.json({ error: "not_submittable" }, { status: 400 });
  } else if (d.action === "approve") {
    if (!approveVersion(db, vid, user.id, d.effective_date ?? null)) return NextResponse.json({ error: "not_pending" }, { status: 400 });
  } else if (d.action === "reject") {
    if (!d.reject_reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });
    if (!rejectVersion(db, vid, d.reject_reason)) return NextResponse.json({ error: "not_pending" }, { status: 400 });
  }
  logPersonaAction(user.id, `quality.version.${d.action}`, vid);
  return NextResponse.json({ ok: true });
}
