import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contentDisposition, monthTok, token } from "@/lib/download-name";
import { buildBankPayslip } from "@/lib/payslip-bank";
import { generateBankPayslipPdf } from "@/lib/bank-payslip-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/payroll/monthly-payslip/[userId]/bank-pdf?m=YYYY-MM — the formal A4 monthly payslip as a PDF
// (owner 2026-11-24). Same data as the page (buildBankPayslip).
export async function GET(req: Request, { params }: { params: { userId: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });
  const userId = Number(params.userId);
  const month = new URL(req.url).searchParams.get("m") ?? "";
  if (!Number.isInteger(userId) || userId <= 0 || !/^\d{4}-\d{2}$/.test(month)) return new Response("bad_request", { status: 400 });

  const d = buildBankPayslip(getDb(), userId, month);
  if (!d) return new Response("not_found", { status: 404 });
  const pdf = await generateBankPayslipPdf(d);
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", ["BankPayslipA4", token(d.employeeCode, `U${userId}`), monthTok(month)].join("_"), "pdf") }
  });
}
