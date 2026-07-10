import { NextResponse } from "next/server";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { listMenu } from "@/lib/delivera/orders";

// Public: available menu for a DELIVERA branch.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const b = Number(new URL(req.url).searchParams.get("branch"));
  if (!Number.isInteger(b) || !isDeliveraBranch(b)) {
    return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, menu: listMenu(b, { availableOnly: true }) });
}
