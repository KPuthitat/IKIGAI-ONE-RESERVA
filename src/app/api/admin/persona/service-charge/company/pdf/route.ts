import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computeCompanySvcSummary, isSharedSvcMonth } from "@/lib/service-charge";
import { generateSvcSummaryPdf, type SvcPdfData } from "@/lib/svc-summary-pdf";
import { TH_MONTHS_FULL } from "@/lib/revshare";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/service-charge/company/pdf?month=YYYY-MM
//
// Company-wide Service-Charge summary PDF for the accounting office (owner
// 2026-08-20): combined totals + per-branch split + per-person distribution.
// Company is derived from the caller's active branch — no company_id in the query.

const typeLabel = (t: string | null) => (t === "ft" ? "ประจำ" : t === "pt" ? "พาร์ทไทม์" : "อื่นๆ");
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: Request) {
  const user = requirePayrollAccess();
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "bad_month" }, { status: 400 });
  }

  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (!companyId) return NextResponse.json({ error: "no_company" }, { status: 400 });
  const company = db.prepare("SELECT name_th, tax_id, address FROM companies WHERE id = ?")
    .get(companyId) as { name_th: string; tax_id: string | null; address: string | null } | undefined;

  const summary = computeCompanySvcSummary(companyId, month);

  // Per-branch attribution: staff share earned at each branch (Σ byBranch gross),
  // net proportional to that gross (WHT/GI are person-level), and headcount.
  const branches: SvcPdfData["branches"] = summary.branches.map((b) => {
    let staffAttributed = 0, netAttributed = 0, headcount = 0;
    for (const r of summary.rows) {
      const bb = r.byBranch.find((x) => x.branchId === b.branchId);
      if (!bb || bb.grossAllocation <= 0) continue;
      staffAttributed += bb.grossAllocation;
      netAttributed += r.grossAllocation > 0 ? r.netPayout * (bb.grossAllocation / r.grossAllocation) : 0;
      headcount += 1;
    }
    return {
      name: b.branchName, collected: round2(b.totalCollected),
      staffAttributed: round2(staffAttributed), netAttributed: round2(netAttributed), headcount
    };
  });

  const rows: SvcPdfData["rows"] = summary.rows.map((r) => ({
    name: r.displayName,
    typeLabel: typeLabel(r.employmentType),
    branchesLabel: r.byBranch.map((b) => b.branchName).join(", ") || "—",
    gross: r.grossAllocation,
    foodClawback: r.foodClawback,
    otherDeductions: r.otherDeductions,
    preTax: r.netAllocation,
    wht: r.whtAmount,
    groupInsurance: r.groupInsurance,
    net: r.netPayout,
    statusLabel: r.forfeited
      ? (r.forfeitReason === "resignation" ? "ตัดสิทธิ์ (ลาออก)" : "ตัดสิทธิ์ (สาย)")
      : r.exempted ? "ยกเว้นให้" : "ได้รับ"
  }));
  const totalFoodClawback = round2(summary.rows.reduce((s, r) => s + r.foodClawback, 0));
  const totalOtherDeductions = round2(summary.rows.reduce((s, r) => s + r.otherDeductions, 0));

  const [yyyy, mm] = month.split("-").map(Number);
  const generatedLabel = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short"
  });

  const pdf = await generateSvcSummaryPdf({
    company: { name: company?.name_th ?? "", taxId: company?.tax_id ?? null, address: company?.address ?? null },
    monthLabel: `${TH_MONTHS_FULL[mm]} ${yyyy + 543}`,
    shared: isSharedSvcMonth(companyId, month),
    payoutDate: summary.payoutDate,
    generatedLabel,
    totals: {
      collected: round2(summary.totalCollected),
      staffPool: round2(summary.staffPoolTotal),
      companyPool: round2(summary.companyPoolTotal),
      foodClawback: totalFoodClawback,
      otherDeductions: totalOtherDeductions,
      wht: round2(summary.totalWht),
      groupInsurance: round2(summary.totalGroupInsurance),
      netPayout: round2(summary.totalNetPayout)
    },
    branches,
    rows
  });

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="svc-summary-${companyId}-${month}.pdf"`
    }
  });
}
