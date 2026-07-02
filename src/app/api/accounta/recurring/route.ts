import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listRecurring, createRecurring } from "@/lib/accounta-db";
import { RecurringBody, toRecurringInput } from "@/lib/accounta-validate";

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const b = new URL(req.url).searchParams.get("branch");
  const branchId = b && Number.isInteger(Number(b)) ? Number(b) : null;
  return NextResponse.json({ ok: true, recurring: listRecurring(branchId) });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = RecurringBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createRecurring(user.id, toRecurringInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
