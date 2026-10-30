import { NextResponse } from "next/server";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { listMenu } from "@/lib/delivera/orders";
import { listOptionGroups } from "@/lib/delivera/options";

// Public: available menu for a DELIVERA branch.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const b = Number(new URL(req.url).searchParams.get("branch"));
  if (!Number.isInteger(b) || !isDeliveraBranch(b)) {
    return NextResponse.json({ error: "branch_unavailable" }, { status: 404 });
  }
  const menu = listMenu(b, { availableOnly: true });
  const options = listOptionGroups(menu.map((m) => m.id));
  return NextResponse.json({ ok: true, menu: menu.map((m) => ({ ...m, options: options.get(m.id) ?? [] })) });
}
