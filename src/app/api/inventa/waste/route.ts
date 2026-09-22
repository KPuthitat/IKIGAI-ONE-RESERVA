import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createWaste } from "@/lib/inventa-waste-server";

// INVENTA waste log (owner 2026-09-22). Any logged-in staff may record their
// branch's waste — log-only, no stock change, no approval. Branch-scoped by the
// caller's active branch. The list is server-rendered on the page, so there's no
// GET here.

export const dynamic = "force-dynamic";

// A real calendar day, today or earlier (Bangkok) — rejects e.g. 2026-99-99 or a
// future date that a report month filter would then hide.
const isPastDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  return s <= new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
};

const Body = z.object({
  item_id: z.number().int().positive(),
  qty: z.number().positive(),
  reason: z.enum(["expired", "damaged", "spoiled", "spill", "prep_loss", "contaminated", "recall", "lost", "other"]),
  note: z.string().max(500).optional(),
  wasted_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isPastDate, { message: "invalid_or_future_date" })
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const id = createWaste(
    user.activeBranchId ?? null,
    { itemId: d.item_id, qty: d.qty, reason: d.reason, note: d.note ?? null, wastedOn: d.wasted_on },
    user.id
  );
  if (id == null) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
