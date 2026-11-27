import { NextResponse } from "next/server";
import { listInFlight } from "@/lib/purchase-flow";
import { memoBranches, memoGate } from "@/lib/memos-api";

// Purchase tracker (owner 2026-11-26): every memo / PR still moving, with the flow chart's headline — who it is waiting on.
export const dynamic = "force-dynamic";

export async function GET() {
  const g = memoGate(); if ("error" in g) return g.error;
  return NextResponse.json({ ok: true, me: g.user.id, rows: listInFlight(g.viewer, memoBranches(g.viewer).map((b) => b.id)) });
}
