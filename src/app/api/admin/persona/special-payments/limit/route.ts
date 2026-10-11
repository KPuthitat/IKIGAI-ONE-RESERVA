import { NextResponse } from "next/server";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { advanceLimit } from "@/lib/special-payments";
import { canPayUser } from "@/lib/special-payments-access";

// GET ?user_id=&date=YYYY-MM-DD → how much this person may still draw in advance on that day
export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const uid = Number(q.get("user_id")); const date = q.get("date") ?? "";
  if (!Number.isInteger(uid) || uid <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (!canPayUser(user, uid)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, limit: advanceLimit(uid, date) });
}
