import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { AccessError, getPublishedSchedule } from "@/lib/special-duty-access";
import { cancelSwap, proposeSwap, respondToSwap, swapNotices, SwapError, swappableDays, listMySwaps } from "@/lib/special-duty-swap";
import { noticeFlex, pushIndividually } from "@/lib/special-duty-notify";
import { SWAP_TEXT, viewerOf } from "@/lib/special-duty-viewer";

// GET ?month=YYYY-MM → my swap requests + the days I could offer / ask for (after the schedule is published)
// POST {action: propose|accept|decline|cancel, ...}

const YM = z.string().regex(/^\d{4}-\d{2}$/);

function send(swapId: number, event: Parameters<typeof swapNotices>[1], ym: string) {
  const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  for (const n of swapNotices(swapId, event)) {
    const url = n.audience === "manager" ? `${base}/admin/persona/special-duty?month=${ym}` : `${base}/staff/persona/special-duty?month=${ym}`;
    pushIndividually(n.to, noticeFlex({ title: n.title, lines: n.lines, url, button: "เปิดดู" })).catch((e) => console.error("swap push", e));
  }
}

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const month = YM.safeParse(new URL(req.url).searchParams.get("month"));
  if (!month.success) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  try {
    getPublishedSchedule(viewerOf(user), user.activeBranchId, month.data);   // same gate as seeing the names
  } catch (e) {
    if (e instanceof AccessError) return NextResponse.json({ error: e.code }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ...listMySwaps(user.id, month.data), ...swappableDays(user.id, user.activeBranchId, month.data) });
}

const Body = z.object({
  month: YM,
  action: z.enum(["propose", "accept", "decline", "cancel"]),
  my_day_id: z.number().int().optional(), their_day_id: z.number().int().optional(),
  swap_id: z.number().int().optional(), note: z.string().max(200).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data;
  try {
    if (d.action === "propose") {
      if (!d.my_day_id || !d.their_day_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      const id = proposeSwap({ userId: user.id, myDayId: d.my_day_id, theirDayId: d.their_day_id, note: d.note });
      send(id, "proposed", d.month);
      return NextResponse.json({ ok: true, id });
    }
    if (!d.swap_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    if (d.action === "cancel") { cancelSwap({ swapId: d.swap_id, userId: user.id }); send(d.swap_id, "cancelled", d.month); }
    else { respondToSwap({ swapId: d.swap_id, userId: user.id, accept: d.action === "accept" }); send(d.swap_id, d.action === "accept" ? "accepted" : "declined", d.month); }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SwapError) return NextResponse.json({ ok: false, error: e.code, message: SWAP_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
