import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getExpense, confirmExpense } from "@/lib/accounta-db";
import { canConfirmBranch } from "@/lib/accounta-access";
import { syncReceiptToDrive } from "@/lib/google-drive";

// POST /api/accounta/expenses/[id]/confirm — promote a LINE draft into the
// ledger. Requires a branch to be assigned first (owner: ลงบันทึกแยกตามสาขา),
// so an unreviewed draft can never enter the company-wide totals unscoped.

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
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
  // ACCOUNTA branch access (owner 2026-06-25): only someone with confirm-level
  // on this branch may post it into the ledger.
  if (!canConfirmBranch(user.id, user.role, exp.branch_id)) {
    return NextResponse.json(
      { error: "forbidden_branch", message: "คุณไม่มีสิทธิ์ยืนยันลงบัญชีของสาขานี้" },
      { status: 403 }
    );
  }

  const ok = confirmExpense(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Best-effort: push the receipt to the branch's Drive (no-op when the
  // branch has no Drive config; never throws). Awaited so the upload + its
  // status land within the request on the long-lived PM2 process.
  await syncReceiptToDrive(id);
  return NextResponse.json({ ok: true });
}
