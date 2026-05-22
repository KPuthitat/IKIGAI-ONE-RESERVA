import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";

const PatchBody = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  display_order: z.number().int().min(0).max(100_000).optional(),
  active: z.union([z.literal(0), z.literal(1)]).optional(),
  kind: z.enum(["checkbox", "text", "choice", "amount", "section"]).optional(),
  /** Set together with kind='choice', or alone to update the option
   *  list on an existing choice row. Server replaces (not merges) the
   *  whole list when this field is present. */
  options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  /** Headline-amount toggle. Multiple amount rows can be flagged —
   *  they stack on the LINE card in display_order, first one biggest.
   *  Only meaningful for amount kind. */
  is_headline_amount: z.union([z.literal(0), z.literal(1)]).optional(),
  /** Optional small-text description shown under the label. Empty
   *  string normalises to NULL. */
  description: z.string().max(500).optional()
});

/** Look up the item and verify the calling admin is assigned to the
 *  item's branch. Prevents an admin of branch A from editing branch B's
 *  checklist by guessing item ids. */
function loadGuarded(id: number, user: NonNullable<ReturnType<typeof getSessionUser>>) {
  const item = getDb().prepare(
    "SELECT * FROM shift_checklist_items WHERE id = ?"
  ).get(id) as ShiftChecklistItem | undefined;
  if (!item) return { ok: false as const, status: 404, error: "not_found" };
  if (!userHasBranch(user, item.branch_id)) {
    return { ok: false as const, status: 403, error: "branch_forbidden" };
  }
  return { ok: true as const, item };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const guard = loadGuarded(id, user);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // `options` is an array — we serialize it to options_json before
  // splicing into the UPDATE so the column update path stays simple
  // (Record<string, string | number>). When the caller switches a row
  // FROM choice to something else, we also null out options_json so
  // stale data doesn't linger.
  const incoming = parsed.data;
  const effectiveKind = incoming.kind ?? guard.item.kind;
  if (effectiveKind === "choice" && incoming.options && incoming.options.length < 2) {
    return NextResponse.json(
      { error: "choice_requires_options" },
      { status: 400 }
    );
  }

  const updates: Record<string, string | number | null> = {};
  if (incoming.label !== undefined) updates.label = incoming.label;
  if (incoming.display_order !== undefined) updates.display_order = incoming.display_order;
  if (incoming.active !== undefined) updates.active = incoming.active;
  if (incoming.kind !== undefined) updates.kind = incoming.kind;
  if (incoming.options !== undefined) {
    updates.options_json = effectiveKind === "choice" ? JSON.stringify(incoming.options) : null;
  } else if (incoming.kind !== undefined && incoming.kind !== "choice") {
    // Kind moved AWAY from choice without supplying new options — wipe
    // the stale options_json so subsequent reads see kind/options agree.
    updates.options_json = null;
  }

  // Headline-amount toggle. Multiple amount rows can be flagged
   // (admin wanted ยอดขายวันนี้ AND ยอดเงินปิดกะ both featured); they
   // stack on the LINE card ordered by display_order, biggest first.
   // No atomic-clear here — admin manages the set freely.
  if (incoming.is_headline_amount !== undefined) {
    updates.is_headline_amount = incoming.is_headline_amount;
  }
  // Description — empty string normalises to NULL so the column
  // doesn't end up with whitespace-only rows.
  if (incoming.description !== undefined) {
    const trimmed = incoming.description.trim();
    updates.description = trimmed === "" ? null : trimmed;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  getDb().prepare(`UPDATE shift_checklist_items SET ${sets} WHERE id = ?`)
    .run(...Object.values(updates), id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const guard = loadGuarded(id, user);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  // Hard delete — historical reports stored the label string already so
  // they keep their data even after the item row is gone. If admin wants
  // to "hide but keep data", they can soft-delete via PATCH active=0.
  getDb().prepare("DELETE FROM shift_checklist_items WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
