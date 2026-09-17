import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch, clearDay, listDayMerchants, getMerchantName } from "@/lib/salesa-db";

// Delete imported data. Two modes (owner 2026-09-16/17):
//  • { date }        — remove one day's sales + menu (wrong day, re-import).
//  • { mode:"mismatched" } — remove every day whose POS merchant doesn't match
//    the branch (cleans up files imported into the wrong branch).
// Admin/หัวหน้างาน (reporta.manage) only.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  date: z.string().regex(ISO).optional(),
  mode: z.enum(["mismatched"]).optional()
});

const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function matches(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  if (parsed.data.mode === "mismatched") {
    const branchName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? `#${branchId}`;
    const expected = getMerchantName(branchId) ?? branchName;
    let removed = 0;
    for (const row of listDayMerchants(branchId)) {
      if (row.merchant && !matches(row.merchant, expected)) removed += clearDay(branchId, row.date);
    }
    return NextResponse.json({ ok: true, removed, expected });
  }

  if (!parsed.data.date) return NextResponse.json({ error: "date_required" }, { status: 400 });
  const removed = clearDay(branchId, parsed.data.date);
  return NextResponse.json({ ok: true, removed });
}
