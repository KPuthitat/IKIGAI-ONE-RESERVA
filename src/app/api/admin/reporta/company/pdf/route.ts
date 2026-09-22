import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { companyOverview } from "@/lib/salesa-analytics";
import { generateReportaCompanyPdf } from "@/lib/reporta-company-pdf";
import { thMonthLabel } from "@/lib/th-month";

// GET /api/admin/reporta/company/pdf?year=&month= — the ANALYTICA company
// overview (รวมทุกสาขา) as a one-page A4 PDF (owner 2026-09-25). Scoped to the
// company of the caller's active branch, same as the company page.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 400 });

  const db = getDb();
  const companyRow = db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined;
  const companyId = companyRow?.company_id ?? null;
  if (companyId == null) return NextResponse.json({ error: "no_company" }, { status: 400 });

  const url = new URL(req.url);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const nowY = Number(today.slice(0, 4)), nowM = Number(today.slice(5, 7));
  const yearRaw = url.searchParams.get("year") ?? "";
  const monthRaw = url.searchParams.get("month") ?? "";
  const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : nowY;
  const month = /^([1-9]|1[0-2])$/.test(monthRaw) ? Number(monthRaw) : nowM;

  const branchIds = (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(companyId) as Array<{ id: number }>).map((b) => b.id);
  const ov = companyOverview(branchIds, year, month, today);

  const companyName = (db.prepare("SELECT name_th AS name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined)?.name ?? "บริษัท";
  const monthLabel = thMonthLabel(`${year}-${String(month).padStart(2, "0")}`);

  const pdf = await generateReportaCompanyPdf(ov, { companyName, monthLabel });
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="reporta-company-${year}-${String(month).padStart(2, "0")}.pdf"`
    }
  });
}
