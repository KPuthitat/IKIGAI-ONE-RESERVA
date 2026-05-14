import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";

// /api/admin/persona/checklist
//
// Admin CRUD for the shift handover checklist items shown on
// /staff/persona/shift/open (and the future close form). Items are
// per-branch since 2026-05 — admin's session activeBranchId picks
// which branch they're editing. Caller can override via ?branch_id=N
// (must be one of the admin's assigned branches).

const CreateBody = z.object({
  type: z.enum(["shift_open", "shift_close", "readiness_1130", "readiness_1600"]),
  label: z.string().trim().min(1).max(200),
  /** Optional — defaults to admin's current activeBranchId. When set,
   *  must be a branch the admin is assigned to. */
  branch_id: z.number().int().positive().optional()
});

function resolveBranchId(
  user: NonNullable<ReturnType<typeof getSessionUser>>,
  override: number | null
): { ok: true; branchId: number } | { ok: false; status: number; error: string } {
  const id = override ?? user.activeBranchId;
  if (!id) return { ok: false, status: 400, error: "no_active_branch" };
  if (!userHasBranch(user, id)) return { ok: false, status: 403, error: "branch_forbidden" };
  return { ok: true, branchId: id };
}

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "shift_open";
  if (!["shift_open", "shift_close", "readiness_1130", "readiness_1600"].includes(type)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  const overrideRaw = url.searchParams.get("branch_id");
  const override = overrideRaw ? Number(overrideRaw) : null;
  if (override !== null && !Number.isInteger(override)) {
    return NextResponse.json({ error: "invalid_branch_id" }, { status: 400 });
  }
  const r = resolveBranchId(user, override);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  const items = getDb().prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = ? AND branch_id = ?
    ORDER BY display_order ASC, id ASC
  `).all(type, r.branchId) as ShiftChecklistItem[];
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { type, label, branch_id: override } = parsed.data;
  const r = resolveBranchId(user, override ?? null);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  const db = getDb();
  // Append at the end of THIS branch's list — find max display_order
  // within (type, branch_id) and add 10.
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(display_order), 0) AS max FROM shift_checklist_items WHERE type = ? AND branch_id = ?"
  ).get(type, r.branchId) as { max: number };
  const result = db.prepare(`
    INSERT INTO shift_checklist_items (type, label, display_order, branch_id)
    VALUES (?, ?, ?, ?)
  `).run(type, label, maxRow.max + 10, r.branchId);
  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
