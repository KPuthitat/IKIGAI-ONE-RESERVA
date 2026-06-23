import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createSwapRequest, listSwapCandidates, myShiftOnDate } from "@/lib/shift-swap";

// Same-day peer shift swap.
//   GET  ?date=YYYY-MM-DD → my shift that day + coworkers I can swap with
//   POST { date, target_user_id, note } → create a pending swap, DM the target

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!ISO.test(date)) return NextResponse.json({ error: "bad_date" }, { status: 400 });
  const mine = myShiftOnDate(user.id, user.activeBranchId, date);
  return NextResponse.json({
    ok: true,
    myShift: mine.ok ? mine.assignment.shiftLabel : null,
    myShiftReason: mine.ok ? null : mine.reason,
    candidates: mine.ok ? listSwapCandidates(user.activeBranchId, date, user.id) : []
  });
}

const PostZ = z.object({
  date: z.string().regex(ISO),
  target_user_id: z.number().int().positive(),
  note: z.string().max(500).optional()
});

const ERR_MSG: Record<string, string> = {
  self: "สลับกับตัวเองไม่ได้",
  initiator_no_shift: "คุณไม่มีกะทำงานในวันนั้น",
  initiator_multiple: "คุณมีหลายกะในวันนั้น — ให้แอดมินจัดสลับให้",
  target_no_shift: "เพื่อนคนนี้ไม่มีกะทำงานในวันนั้น",
  target_multiple: "เพื่อนคนนี้มีหลายกะในวันนั้น — ให้แอดมินจัดสลับให้",
  duplicate: "คุณส่งคำขอสลับกะกับคนนี้ในวันนี้ไปแล้ว (รอตอบรับอยู่)"
};

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  const res = createSwapRequest(
    { id: user.id, activeBranchId: user.activeBranchId },
    { date: d.date, targetUserId: d.target_user_id, note: d.note?.trim() || null }
  );
  if (!res.ok) return NextResponse.json({ error: res.error, message: ERR_MSG[res.error] }, { status: 400 });
  return NextResponse.json({ ok: true, id: res.id, ref_no: res.ref_no });
}
