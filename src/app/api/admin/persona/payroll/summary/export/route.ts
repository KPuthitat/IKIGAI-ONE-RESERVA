import { thDateBE } from "@/lib/th-month";
import { NextResponse } from "next/server";
import { requirePayrollAccess } from "@/lib/auth";
import {
  buildPayrollSummaryDoc, parseScope, scopeToken, renderPayrollSummaryCsv
} from "@/lib/payroll-summary-doc";
import { renderPayrollSummaryXlsx } from "@/lib/payroll-summary-xlsx";
import { generatePayrollSummaryPdf } from "@/lib/payroll-summary-pdf";
import { contentDisposition, thMonthShort, thRange } from "@/lib/download-name";

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
  // The name says what it covers: สรุปค่าตอบแทน_<ขอบเขต>_<เดือน>_รอบจ่าย 2 พ.ย.-30 พ.ย. 2569 (the pay dates of the rounds inside)
  const payDates = doc.companies.flatMap((c) => c.branches.flatMap((b) => b.roundGroups.map((g) => g.info.payDate))).filter(Boolean).sort();
  const baseName = ["สรุปค่าตอบแทน", doc.scopeLabel, thMonthShort(m), payDates.length ? `รอบจ่าย ${thRange(payDates[0], payDates[payDates.length - 1])}` : ""].filter(Boolean).join("_");

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
