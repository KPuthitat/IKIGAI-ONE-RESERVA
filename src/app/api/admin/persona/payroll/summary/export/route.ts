import { thDateBE } from "@/lib/th-month";
import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import {
  buildPayrollSummaryDoc, parseScope, scopeToken, renderPayrollSummaryCsv
} from "@/lib/payroll-summary-doc";
import { renderPayrollSummaryXlsx } from "@/lib/payroll-summary-xlsx";
import { generatePayrollSummaryPdf } from "@/lib/payroll-summary-pdf";
import { contentDisposition, monthTok, rangeTok, token } from "@/lib/download-name";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/payroll/summary/export?m=YYYY-MM&scope=all|company:<id>|branch:<id>&format=csv|xlsx|pdf&note=...
//
// สร้างเอกสารสรุปค่าตอบแทนรายเดือน (owner 2026-09-06): pick a company/branch and a
// format; the file carries a header, the pay rounds (รอบจ่าย) for reconciliation,
// and clearly-marked deduction columns.

export async function GET(req: Request) {
  requirePayrollAccess();
  const url = new URL(req.url);
  const m = url.searchParams.get("m") ?? "";
  if (!/^\d{4}-\d{2}$/.test(m)) return NextResponse.json({ error: "bad_month" }, { status: 400 });

  const scope = parseScope(url.searchParams.get("scope"));
  if (!scope) return NextResponse.json({ error: "bad_scope" }, { status: 400 });

  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    return NextResponse.json({ error: "bad_format" }, { status: 400 });
  }
  const note = url.searchParams.get("note")?.slice(0, 300) ?? null;

  const doc = buildPayrollSummaryDoc(m, scope);
  const generatedLabel = thDateBE(new Date(), { bangkok: true, time: true });
  // The name says what it covers: PayrollSummary_<scope>_<month>_PayDates-2026.11.02-30 (the pay dates of the rounds inside)
  const payDates = doc.companies.flatMap((c) => c.branches.flatMap((b) => b.roundGroups.map((g) => g.info.payDate))).filter(Boolean).sort();
  const db = getDb();
  const scopeTok = scope.kind === "all" ? "AllCompanies"
    : scope.kind === "company" ? (scope.id == null ? "NoCompany" : token((db.prepare("SELECT name_en FROM companies WHERE id = ?").get(scope.id) as { name_en: string | null } | undefined)?.name_en, `Company-${scope.id}`))
    : (() => { const b = db.prepare("SELECT name, slug FROM branches WHERE id = ?").get(scope.id) as { name: string; slug: string } | undefined; return b ? token(b.name, token(b.slug, `Branch-${scope.id}`)) : `Branch-${scope.id}`; })();
  const baseName = ["PayrollSummary", scopeTok, monthTok(m), payDates.length ? `PayDates-${rangeTok(payDates[0], payDates[payDates.length - 1])}` : ""].filter(Boolean).join("_");

  if (format === "csv") {
    return new NextResponse(renderPayrollSummaryCsv(doc, generatedLabel, note), {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", baseName, "csv")
      }
    });
  }
  if (format === "xlsx") {
    const buf = renderPayrollSummaryXlsx(doc, generatedLabel, note);
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition("attachment", baseName, "xlsx")
      }
    });
  }
  const pdf = await generatePayrollSummaryPdf(doc, generatedLabel, note);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition("inline", baseName, "pdf")
    }
  });
}
