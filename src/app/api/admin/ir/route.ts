import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listReports, createReport, type IrStatus, type IrSeverity } from "@/lib/ir-db";
import { IrCreateBody, toCreateInput } from "@/lib/ir-schema";
import { notifyIrRmGroupAsync } from "@/lib/ir-line";

// GET  /api/admin/ir            — list this branch's incident reports
// POST /api/admin/ir            — file a new report
//
// Gate: requirePermission("ir.manage"). The reporter identity is taken from
// the session; a report may be filed anonymously (is_anonymous), in which case
// we never persist reporter_user_id. The body is the SAME detailed shape the
// staff route accepts (ir-schema.ts) — one report format system-wide.

function ctx() {
  const user = requirePermission("ir.manage");
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET(req: Request) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "all";
  const status = (["new", "reviewing", "action", "closed", "dismissed", "open", "all"]
    .includes(statusParam) ? statusParam : "all") as IrStatus | "open" | "all";
  const sevParam = Number(url.searchParams.get("severity"));
  const severity = (sevParam >= 1 && sevParam <= 5 ? sevParam : undefined) as IrSeverity | undefined;
  const category = url.searchParams.get("category") || undefined;
  const reports = listReports({ branchId, status, severity, category });
  return NextResponse.json({ ok: true, reports });
}

export async function POST(req: Request) {
  const { user, branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = IrCreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const report = createReport(toCreateInput(parsed.data, branchId, user.id));
  // Tell the RM team's LINE group (owner 2026-10-02) — never blocks the filing.
  notifyIrRmGroupAsync(branchId, report.id);
  const reports = listReports({ branchId, status: "all" });
  return NextResponse.json({ ok: true, report, reports });
}
