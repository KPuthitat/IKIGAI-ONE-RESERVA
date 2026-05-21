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
  branch_id: z.number().int().positive().optional(),
  /** 'checkbox' (default), 'text', 'choice', or 'amount'. See
   *  ShiftChecklistItem.kind for the rendering semantics. */
  kind: z.enum(["checkbox", "text", "choice", "amount"]).optional(),
  /** When kind === 'choice', the radio options shown to the staff.
   *  Required for choice (≥ 2 items), ignored for everything else. */
  options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  /** Optional — when set, makes the new row a child of an existing
   *  row. Parent must be in the same branch + type AND must not itself
   *  have a parent (we limit nesting to 2 levels). */
  parent_id: z.number().int().positive().optional()
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
  const { type, label, branch_id: override, kind, options, parent_id } = parsed.data;
  const effectiveKind = kind ?? "checkbox";

  // Choice items must arrive with at least 2 options — otherwise the
  // staff form has nothing to render and the row is unusable. We
  // reject early instead of saving a broken row that admin would have
  // to debug later.
  if (effectiveKind === "choice" && (!options || options.length < 2)) {
    return NextResponse.json(
      { error: "choice_requires_options" },
      { status: 400 }
    );
  }

  const r = resolveBranchId(user, override ?? null);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  const db = getDb();

  // Parent validation — when parent_id is set, the parent row must
  // exist, live in the SAME branch + type, and itself be top-level
  // (parent_id IS NULL). 2-level nesting only — keeps the UX simple
  // and the LINE Flex card readable.
  if (parent_id != null) {
    const parent = db.prepare(
      "SELECT id, branch_id, type, parent_id FROM shift_checklist_items WHERE id = ?"
    ).get(parent_id) as
      | { id: number; branch_id: number; type: string; parent_id: number | null }
      | undefined;
    if (!parent) {
      return NextResponse.json({ error: "parent_not_found" }, { status: 404 });
    }
    if (parent.branch_id !== r.branchId || parent.type !== type) {
      return NextResponse.json({ error: "parent_branch_or_type_mismatch" }, { status: 400 });
    }
    if (parent.parent_id != null) {
      return NextResponse.json({ error: "max_nesting_depth_reached" }, { status: 400 });
    }
  }

  // For top-level rows: append at the bottom of THIS (type, branch)
  // list using max(display_order) + 10. For child rows: append at the
  // bottom of the parent's own children using the same trick scoped
  // to parent_id. That way reordering is independent per-level.
  const orderScope = parent_id != null
    ? db.prepare(
        "SELECT COALESCE(MAX(display_order), 0) AS max FROM shift_checklist_items WHERE parent_id = ?"
      ).get(parent_id) as { max: number }
    : db.prepare(
        "SELECT COALESCE(MAX(display_order), 0) AS max FROM shift_checklist_items WHERE type = ? AND branch_id = ? AND parent_id IS NULL"
      ).get(type, r.branchId) as { max: number };
  const optionsJson = effectiveKind === "choice" && options ? JSON.stringify(options) : null;
  const result = db.prepare(`
    INSERT INTO shift_checklist_items (type, label, display_order, branch_id, kind, options_json, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, label, orderScope.max + 10, r.branchId, effectiveKind, optionsJson, parent_id ?? null);
  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
