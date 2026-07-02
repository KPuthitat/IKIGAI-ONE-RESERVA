import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listCCCharges, createCCCharge, creditCardReserve } from "@/lib/accounta-db";
import { CCBody, toCCInput } from "@/lib/accounta-validate";

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
}

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const b = new URL(req.url).searchParams.get("branch");
  const branchId = b && Number.isInteger(Number(b)) ? Number(b) : null;
  if (branchId == null) return NextResponse.json({ error: "branch_required" }, { status: 400 });
  return NextResponse.json({ ok: true, reserve: creditCardReserve(branchId, bkkMonth()), charges: listCCCharges(branchId) });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = CCBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createCCCharge(user.id, toCCInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
