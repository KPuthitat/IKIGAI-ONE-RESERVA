import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createWaste } from "@/lib/inventa-waste-server";
import { saveWastePhoto, removeWastePhoto } from "@/lib/inventa-waste-photo";

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
  // Either a stock item (item_id) OR an ad-hoc item (item_name + unit/cost).
  item_id: z.number().int().positive().optional(),
  item_name: z.string().max(200).optional(),
  unit: z.string().max(40).optional(),
  unit_cost: z.number().min(0).max(100_000_000).optional(),
  qty: z.number().positive(),
  reason: z.enum(["expired", "damaged", "spoiled", "spill", "prep_loss", "contaminated", "recall", "lost", "other"]),
  note: z.string().max(500).optional(),
  wasted_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isPastDate, { message: "invalid_or_future_date" }),
  // optional data:image/... evidence photo. Cap the STRING here so an oversized
  // body is rejected before req.json() buffers it / Buffer.from allocates it —
  // ~2MB of image is ~2.8MB of base64, so 3MB leaves headroom (server re-checks
  // the decoded bytes against its own 2MB cap). Matches the clock-selfie route.
  photo: z.string().max(3_000_000).optional()
}).refine(
  (d) => d.item_id != null || (d.item_name != null && d.item_name.trim().length > 0),
  { message: "item_required", path: ["item_name"] }
);

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  let photoPath: string | null = null;
  if (d.photo) {
    const saved = saveWastePhoto(d.photo);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    photoPath = saved.filename;
  }

  const id = createWaste(
    user.activeBranchId ?? null,
    {
      itemId: d.item_id ?? null,
      itemName: d.item_name, unit: d.unit ?? null, unitCost: d.unit_cost ?? 0,
      qty: d.qty, reason: d.reason, note: d.note ?? null, wastedOn: d.wasted_on, photoPath
    },
    user.id
  );
  if (id == null) {
    // Row rejected (stock item not in this branch, or blank ad-hoc name) — don't
    // orphan the photo we just wrote.
    if (photoPath) removeWastePhoto(photoPath);
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
