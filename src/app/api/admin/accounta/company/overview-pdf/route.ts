import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { companyOverviewMonth } from "@/lib/accounta-db";
import { generateCompanyOverviewPdf } from "@/lib/company-overview-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/accounta/company/overview-pdf?month=YYYY-MM
// One-page company-overview infographic PDF for C-level presentation
// (owner 2026-09-02). Company is derived from the caller's active branch.
export async function GET(req: Request) {
  const user = requirePermission("accounta.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "bad_month" }, { status: 400 });

  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (!companyId) return NextResponse.json({ error: "no_company" }, { status: 400 });

  const ov = companyOverviewMonth(companyId, month);
  const pdf = await generateCompanyOverviewPdf(ov);

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="company-overview-${companyId}-${month}.pdf"`
    }
  });
}
