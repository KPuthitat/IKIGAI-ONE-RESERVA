import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, userHasBranch } from "@/lib/auth";
import {
  isCustomerHash,
  linkBill,
  unlinkBill,
  listLinkedBills,
  customerBillStats
} from "@/lib/insigna";

// POST /api/admin/insigna/customers/[hash]/bills  — admin (insigna.view).
//
// Link or unlink a POS receipt to this customer's pseudonym, then return the
// refreshed list + CRM roll-up so the panel can re-render in one round-trip.

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("link"),
    branch_id: z.number().int().positive(),
    sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bill_no: z.string().min(1).max(40)
  }),
  z.object({
    action: z.literal("unlink"),
    branch_id: z.number().int().positive(),
    sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bill_no: z.string().min(1).max(40)
  })
]);

export async function POST(req: Request, { params }: { params: { hash: string } }) {
  const user = requirePermission("insigna.view");
  const hash = params.hash;
  if (!isCustomerHash(hash)) return NextResponse.json({ error: "bad_hash" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  // Only touch receipts of a branch the caller actually administers — the
  // permission check above is global, so guard the branch here.
  if (!userHasBranch(user, d.branch_id)) {
    return NextResponse.json({ error: "forbidden_branch" }, { status: 403 });
  }

  let result: string | null = null;
  if (d.action === "link") {
    result = linkBill({
      customer_hash: hash, branch_id: d.branch_id, sale_date: d.sale_date,
      bill_no: d.bill_no.trim(), linked_by: user.id
    });
  } else {
    unlinkBill(d.branch_id, d.sale_date, d.bill_no.trim());
    result = "unlinked";
  }

  return NextResponse.json({
    ok: result === "linked" || result === "unlinked" || result === "already_yours",
    result,
    bills: listLinkedBills(hash),
    stats: customerBillStats(hash)
  });
}
