import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contentDisposition, monthTok, token } from "@/lib/download-name";
import { buildBankPayslip, paidBankPayslipMonths } from "@/lib/payslip-bank";
import { generateBankPayslipPdf } from "@/lib/bank-payslip-pdf";

export const dynamic = "force-dynamic";

// GET /api/staff/persona/payslip/bank-pdf?m=YYYY-MM — an employee's OWN formal A4 monthly payslip as a PDF, only for
// months in which every pay round is paid (draft / finalized figures can still change).
export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  const month = new URL(req.url).searchParams.get("m") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return new Response("bad_request", { status: 400 });
  const db = getDb();
  if (!paidBankPayslipMonths(db, user.id).includes(month)) return new Response("not_found", { status: 404 });
  const d = buildBankPayslip(db, user.id, month);
  if (!d) return new Response("not_found", { status: 404 });
  const pdf = await generateBankPayslipPdf(d);
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", ["BankPayslipA4", token(d.employeeCode, `U${user.id}`), monthTok(month)].join("_"), "pdf") }
  });
}
