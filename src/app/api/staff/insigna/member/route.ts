import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { getMemberByScan, customerBillStats, countPendingBills, addMemberBill } from "@/lib/insigna";

// Staff checkout scan (owner 2026-10-03). GET ?q= resolves what the scanner
// read (member-card QR URL, scan token or a typed member code) to the member's
// pseudonymous summary — code, visits, last visit — never a name. POST ties a
// bill number of the active branch to that member; if the day's receipt file
// isn't imported yet the link waits and resolves on import. Any logged-in
// staff of the branch may do this (operational counter action, like claiming
// a reward code).

export const dynamic = "force-dynamic";

function summary(hash: string, member_code: string) {
  const s = customerBillStats(hash);
  return { member_code, visits: s.distinctDays, bills: s.billCount, lastVisit: s.lastVisit, totalNett: s.totalNett, pending: countPendingBills(hash), topItems: s.topItems.slice(0, 3) };
}

export function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "no_query" }, { status: 400 });
  const m = getMemberByScan(q);
  if (!m?.member_code) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, member: summary(m.customer_hash, m.member_code) });
}

const Body = z.object({
  q: z.string().min(1).max(300),
  bill_no: z.string().min(1).max(40),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const m = getMemberByScan(parsed.data.q);
  if (!m?.member_code) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const sale_date = parsed.data.sale_date ?? today;
  const result = addMemberBill({ customer_hash: m.customer_hash, branch_id: branchId, sale_date, bill_no: parsed.data.bill_no.trim(), linked_by: user.id });
  logPersonaAction(user.id, "insigna.member_bill_link", null);
  return NextResponse.json({ ok: result === "linked" || result === "pending" || result === "already_yours", result, member: summary(m.customer_hash, m.member_code) });
}
