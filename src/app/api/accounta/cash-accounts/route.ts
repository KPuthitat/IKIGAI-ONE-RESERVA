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
const TYPE = z.enum(["cash", "bank", "ewallet", "credit_card"]);
// Detail fields shared by create + update. card_last4 is constrained to ≤4
// digits — the UI never collects a full card number and the lib strips to 4.
const detail = {
  bank_name: z.string().trim().max(80).nullable().optional(),
  account_type: z.string().trim().max(40).nullable().optional(),
  account_name: z.string().trim().max(120).nullable().optional(),
  account_no: z.string().trim().max(40).nullable().optional(),
  account_branch: z.string().trim().max(80).nullable().optional(),
  account_branch_no: z.string().trim().max(20).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  card_last4: z.string().trim().regex(/^\d{0,4}$/).nullable().optional(),
  use_income: z.boolean().optional(),
  use_expense: z.boolean().optional()
};

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  type: TYPE.default("cash"),
  bank_label: z.string().trim().max(80).optional(),
  balance: z.number().finite().optional(),
  balance_as_of: z.string().regex(ISO).optional(),
  note: z.string().trim().max(300).optional(),
  company_wide: z.boolean().optional(),
  ...detail
});
const PatchBody = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  type: TYPE.optional(),
  bank_label: z.string().trim().max(80).nullable().optional(),
  balance: z.number().finite().optional(),
  balance_as_of: z.string().regex(ISO).nullable().optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  ...detail
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
    note: d.note ?? null, createdBy: user.id,
    bankName: d.bank_name ?? null, accountType: d.account_type ?? null, accountName: d.account_name ?? null,
    accountNo: d.account_no ?? null, accountBranch: d.account_branch ?? null, accountBranchNo: d.account_branch_no ?? null,
    description: d.description ?? null, cardLast4: d.card_last4 ?? null,
    useIncome: d.use_income, useExpense: d.use_expense
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
    balance: rest.balance, balanceAsOf: rest.balance_as_of, active: rest.active, note: rest.note,
    bankName: rest.bank_name, accountType: rest.account_type, accountName: rest.account_name,
    accountNo: rest.account_no, accountBranch: rest.account_branch, accountBranchNo: rest.account_branch_no,
    description: rest.description, cardLast4: rest.card_last4,
    useIncome: rest.use_income, useExpense: rest.use_expense
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
