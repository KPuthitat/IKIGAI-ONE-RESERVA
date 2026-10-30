import { NextResponse } from "next/server";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { queueStats } from "@/lib/delivera/guest";

// Public: how busy the kitchen is right now ("กำลังทำ N ออเดอร์ · รอประมาณ M นาที").
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const b = Number(new URL(req.url).searchParams.get("branch"));
  if (!Number.isInteger(b) || !isDeliveraBranch(b)) return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });
  return NextResponse.json({ ok: true, ...queueStats(b) });
}
