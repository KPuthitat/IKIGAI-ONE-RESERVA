import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import {
  buildPayrollSummaryDoc, parseScope, scopeToken, renderPayrollSummaryCsv
} from "@/lib/payroll-summary-doc";
import { renderPayrollSummaryXlsx } from "@/lib/payroll-summary-xlsx";
import { generatePayrollSummaryPdf } from "@/lib/payroll-summary-pdf";

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
  const generatedLabel = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short"
  });
  const slug = scopeToken(scope).replace(/[^a-z0-9]+/gi, "-");
  const filename = `payroll-summary-${slug}-${m}`;

  if (format === "csv") {
    return new NextResponse(renderPayrollSummaryCsv(doc, generatedLabel, note), {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`
      }
    });
  }
  if (format === "xlsx") {
    const buf = renderPayrollSummaryXlsx(doc, generatedLabel, note);
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}.xlsx"`
      }
    });
  }
  const pdf = await generatePayrollSummaryPdf(doc, generatedLabel, note);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}.pdf"`
    }
  });
}
