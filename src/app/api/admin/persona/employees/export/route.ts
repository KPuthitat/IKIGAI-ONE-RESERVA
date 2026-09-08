import { NextResponse } from "next/server";
import { requireAdmin, userCanViewPayroll } from "@/lib/auth";
import { buildEmployeeDoc, parseScope, scopeToken, renderEmployeeCsv } from "@/lib/employee-export";
import { renderEmployeeXlsx } from "@/lib/employee-export-xlsx";
import { generateEmployeePdf } from "@/lib/employee-export-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/employees/export?scope=all|company:<id>|branch:<id>&format=csv|xlsx|pdf&fields=a,b,c&note=...
//
// ดึงรายชื่อ + ข้อมูลพนักงาน (เลือกฟิลด์ได้) — owner 2026-09-07. Admin only; the
// sensitive (financial / national-ID) columns are honoured only for a caller with
// payroll access, otherwise they are silently dropped.
export async function GET(req: Request) {
  const user = requireAdmin();
  const url = new URL(req.url);

  const scope = parseScope(url.searchParams.get("scope"));
  if (!scope) return NextResponse.json({ error: "bad_scope" }, { status: 400 });

  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (!["csv", "xlsx", "pdf"].includes(format)) return NextResponse.json({ error: "bad_format" }, { status: 400 });

  const fields = (url.searchParams.get("fields") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const note = url.searchParams.get("note")?.slice(0, 300) ?? null;

  const doc = buildEmployeeDoc(scope, fields, userCanViewPayroll(user));
  const generatedLabel = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
  const filename = `employees-${scopeToken(scope).replace(/[^a-z0-9]+/gi, "-")}`;

  if (format === "csv") {
    return new NextResponse(renderEmployeeCsv(doc, generatedLabel, note), {
      headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.csv"` }
    });
  }
  if (format === "xlsx") {
    const buf = renderEmployeeXlsx(doc, generatedLabel, note);
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}.xlsx"`
      }
    });
  }
  const pdf = await generateEmployeePdf(doc, generatedLabel, note);
  return new NextResponse(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename}.pdf"` }
  });
}
