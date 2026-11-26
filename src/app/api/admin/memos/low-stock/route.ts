import { NextResponse } from "next/server";
import { lowStockItems } from "@/lib/inventa-stock";
import { memoBranches, memoGate } from "@/lib/memos-api";

// Items of a branch below their safety stock — the starting point of a purchase memo made from INVENTA (owner 2026-11-26).
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = memoGate(); if ("error" in g) return g.error;
  const branchId = Number(new URL(req.url).searchParams.get("branch"));
  if (!memoBranches(g.viewer).some((b) => b.id === branchId)) return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ในสาขานี้" }, { status: 403 });
  return NextResponse.json({ ok: true, items: lowStockItems(branchId) });
}
