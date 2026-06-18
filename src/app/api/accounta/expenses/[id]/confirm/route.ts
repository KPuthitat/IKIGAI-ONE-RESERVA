import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getExpense, confirmExpense } from "@/lib/accounta-db";

// POST /api/accounta/expenses/[id]/confirm — promote a LINE draft into the
// ledger. Requires a branch to be assigned first (owner: ลงบันทึกแยกตามสาขา),
// so an unreviewed draft can never enter the company-wide totals unscoped.

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const exp = getExpense(id);
  if (!exp) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (exp.branch_id == null) {
    return NextResponse.json(
      { error: "no_branch", message: "เลือกสาขาก่อนยืนยันเข้าสมุด" },
      { status: 400 }
    );
  }

  const ok = confirmExpense(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
