import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listReports, createReport, reportIdsTouching, type IrStatus } from "@/lib/ir-db";
import { IrCreateBody, toCreateInput } from "@/lib/ir-schema";

// GET  /api/staff/ir   — this branch's incident reports (every employee may read
//                        the branch's reports — owner 2026-10-01) + which are mine
// POST /api/staff/ir   — file a detailed report as the signed-in employee
//
// Gate: any signed-in user with an active branch. The reporter is the session
// user; "anonymous" withholds the identity (and forfeits later self-editing).

function ctx() {
  const user = getSessionUser();
  if (!user) return { user: null, branchId: null };
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET(req: Request) {
  const { user, branchId } = ctx();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "all";
  const status = (["new", "reviewing", "action", "closed", "dismissed", "open", "all"]
    .includes(statusParam) ? statusParam : "all") as IrStatus | "open" | "all";
  const reports = listReports({ branchId, status });
  const mine = [...reportIdsTouching(branchId, user.id)];
  return NextResponse.json({ ok: true, reports, mine });
}

export async function POST(req: Request) {
  const { user, branchId } = ctx();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = IrCreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const report = createReport(toCreateInput(parsed.data, branchId, user.id));
  return NextResponse.json({ ok: true, report });
}
