import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contentDisposition, payRoundBaseName, token } from "@/lib/download-name";
import { buildPayslipView } from "@/lib/payslip";
import { generatePayslipPdf } from "@/lib/payslip-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/payroll/periods/[id]/payslip-pdf?userId=<id>[&as=staff] — one employee's payslip for a pay
// round as a laid-out A4 PDF (owner 2026-11-24). `as=staff` = exactly what the employee sees.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const periodId = Number(params.id), userId = Number(url.searchParams.get("userId"));
  if (!Number.isInteger(periodId) || periodId <= 0 || !Number.isInteger(userId) || userId <= 0) return new Response("bad_request", { status: 400 });

  const db = getDb();
  const view = buildPayslipView(db, periodId, userId);
  if (!view) return new Response("not_found", { status: 404 });
  const audience = url.searchParams.get("as") === "staff" ? "staff" : "admin";
  const pdf = await generatePayslipPdf(view, audience);
  const emp = token(view.line.employee_code, `U${userId}`);
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", payRoundBaseName(`Payslip_${emp}`, view.period, token(view.payslipBranchName, "")), "pdf") }
  });
}
