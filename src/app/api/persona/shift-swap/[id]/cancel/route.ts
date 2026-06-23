import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { cancelSwap } from "@/lib/shift-swap";

// POST /api/persona/shift-swap/[id]/cancel — initiator cancels their own
// still-pending swap request.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!cancelSwap(user.id, id)) return NextResponse.json({ error: "cannot_cancel" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
