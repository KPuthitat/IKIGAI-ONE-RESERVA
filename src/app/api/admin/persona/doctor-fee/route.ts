import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import {
  isDfBranch, computeDoctorFees, listRules, importedSpan, eligibleDoctors
} from "@/lib/df-db";

// GET /api/admin/persona/doctor-fee?start=YYYY-MM-DD&end=YYYY-MM-DD
//   → the Doctor-Fee computation for a period, plus the rules / imported span /
//     eligible doctors the page needs. Clinic branch only.

export const dynamic = "force-dynamic";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });

  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!dateRe.test(start) || !dateRe.test(end) || start > end) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  const result = computeDoctorFees(branchId, start, end);
  return NextResponse.json({
    ok: true,
    result,
    rules: listRules(branchId),
    span: importedSpan(branchId),
    doctors: eligibleDoctors()
  });
}
