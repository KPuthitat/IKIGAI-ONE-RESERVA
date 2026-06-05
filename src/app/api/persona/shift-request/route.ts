import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createShiftRequest } from "@/lib/shift-requests";

// POST /api/persona/shift-request — staff submit a shift-change request:
//   kind 'extra_shift' → work_date only (ขอเพิ่มกะ)
//   kind 'swap'        → work_date + off_date (ขอสลับวันหยุด)
// v1: record + notify the manager; an admin reflects it in the roster.
const Body = z.object({
  kind: z.enum(["extra_shift", "swap"]),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  off_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  if (d.kind === "swap" && !d.off_date) {
    return NextResponse.json({ error: "off_date_required" }, { status: 400 });
  }

  const res = createShiftRequest(
    { id: user.id, activeBranchId: user.activeBranchId },
    { kind: d.kind, work_date: d.work_date, off_date: d.off_date ?? null, note: d.note?.trim() || null }
  );
  return NextResponse.json({ ok: true, ...res });
}
