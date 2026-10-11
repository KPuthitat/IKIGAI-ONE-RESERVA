import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { AccessError, getAnonymousSlots, getMyDuties } from "@/lib/special-duty-access";
import { setUserBookings } from "@/lib/special-duty-rules";
import { RULE_TEXT, viewerOf } from "@/lib/special-duty-viewer";

// GET  ?month=YYYY-MM          → anonymous slot states for the caller + their own duties
// PUT  {month, position_id, dates[]} → replace the caller's days for one position (all or nothing)

const YM = z.string().regex(/^\d{4}-\d{2}$/);

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const month = YM.safeParse(new URL(req.url).searchParams.get("month"));
  if (!month.success) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  const v = viewerOf(user);
  try {
    return NextResponse.json({ slots: getAnonymousSlots(v, user.activeBranchId, month.data), mine: getMyDuties(v, user.activeBranchId, month.data) });
  } catch (e) {
    if (e instanceof AccessError) return NextResponse.json({ error: e.code }, { status: e.code === "forbidden" ? 403 : 409 });
    throw e;
  }
}

const Put = z.object({ month: YM, position_id: z.number().int().positive(), dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(31) });

export async function PUT(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const p = Put.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const r = setUserBookings({ userId: user.id, branchId: user.activeBranchId, yearMonth: p.data.month, positionId: p.data.position_id, dates: p.data.dates });
  if (r.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, errors: r.errors.map((e) => ({ ...e, message: RULE_TEXT[e.code] ?? e.code })) }, { status: 422 });
}
