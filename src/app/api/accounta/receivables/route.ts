import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  listOutstandingReceivables, receivablesByEntity, receivablesTotal, settleReceivable
} from "@/lib/accounta-db";

// ลูกหนี้ค้างชำระ (owner 2026-06-22) — per active branch.
// GET   — open receivables (rows + by-entity summary + total)
// POST  — mark one collected (รับชำระแล้ว) with the cash-in date

function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function GET() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  return NextResponse.json({
    ok: true,
    rows: listOutstandingReceivables(branchId),
    byEntity: receivablesByEntity(branchId),
    total: receivablesTotal(branchId)
  });
}

const PostBody = z.object({
  id: z.number().int().positive(),
  settled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const date = parsed.data.settled_date ?? bkkToday();
  if (date > bkkToday()) {
    return NextResponse.json({ error: "future_date", message: "วันรับชำระเป็นอนาคตไม่ได้" }, { status: 400 });
  }
  const ok = settleReceivable(parsed.data.id, branchId, date);
  if (!ok) return NextResponse.json({ error: "not_found_or_settled" }, { status: 409 });
  return NextResponse.json({
    ok: true,
    rows: listOutstandingReceivables(branchId),
    byEntity: receivablesByEntity(branchId),
    total: receivablesTotal(branchId)
  });
}
