import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  listCashAccounts, createCashAccount, updateCashAccount, deleteCashAccount
} from "@/lib/accounta-db";

// เงินสด/บัญชีธนาคารที่ติดตาม — manual-snapshot balances, scoped to the admin's
// active branch (+ company-wide accounts, branch_id NULL).
//
// GET    — list (active branch + company-wide), includes inactive
// POST   — create (company_wide=true → branch_id NULL)
// PATCH  — update fields / balance / active
// DELETE — remove an account (?id=)

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["cash", "bank"]).default("cash"),
  bank_label: z.string().trim().max(80).optional(),
  balance: z.number().finite().optional(),
  balance_as_of: z.string().regex(ISO).optional(),
  note: z.string().trim().max(300).optional(),
  company_wide: z.boolean().optional()
});
const PatchBody = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(["cash", "bank"]).optional(),
  bank_label: z.string().trim().max(80).nullable().optional(),
  balance: z.number().finite().optional(),
  balance_as_of: z.string().regex(ISO).nullable().optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional()
});

function branchOf(): number | null {
  return requirePermission("accounta.manage").activeBranchId ?? null;
}

export async function GET() {
  const branchId = branchOf();
  return NextResponse.json({
    ok: true,
    accounts: branchId != null ? listCashAccounts(branchId, true) : []
  });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  createCashAccount({
    branchId: d.company_wide ? null : branchId,
    name: d.name, type: d.type, bankLabel: d.bank_label ?? null,
    balance: d.balance ?? 0, balanceAsOf: d.balance_as_of ?? null,
    note: d.note ?? null, createdBy: user.id
  });
  return NextResponse.json({ ok: true, accounts: listCashAccounts(branchId, true) });
}

export async function PATCH(req: Request) {
  const branchId = branchOf();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { id, ...rest } = parsed.data;
  const ok = updateCashAccount(id, branchId, {
    name: rest.name, type: rest.type, bankLabel: rest.bank_label,
    balance: rest.balance, balanceAsOf: rest.balance_as_of, active: rest.active, note: rest.note
  });
  if (!ok) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  return NextResponse.json({ ok: true, accounts: listCashAccounts(branchId, true) });
}

export async function DELETE(req: Request) {
  const branchId = branchOf();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!deleteCashAccount(id, branchId)) return NextResponse.json({ error: "delete_failed" }, { status: 400 });
  return NextResponse.json({ ok: true, accounts: listCashAccounts(branchId, true) });
}
