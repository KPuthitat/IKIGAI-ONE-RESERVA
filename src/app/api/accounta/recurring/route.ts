import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listRecurring, createRecurring, postDueRecurringExpenses } from "@/lib/accounta-db";
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
  // Post immediately if it's already due this month, so it shows in the ledger
  // without waiting for the cron (owner 2026-07-04). Idempotent — the
  // last_posted_month guard stops the cron double-posting later.
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const posted = postDueRecurringExpenses(today);
  return NextResponse.json({ ok: true, id, posted });
}
