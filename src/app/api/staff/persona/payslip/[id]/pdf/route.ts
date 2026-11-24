import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contentDisposition, payRoundBaseName, token } from "@/lib/download-name";
import { buildPayslipView } from "@/lib/payslip";
import { generatePayslipPdf } from "@/lib/payslip-pdf";

export const dynamic = "force-dynamic";

// GET /api/staff/persona/payslip/[id]/pdf — an employee's OWN payslip for one pay round as a PDF, and only once the
// round is paid (draft / finalized figures can still change before payout) — same rule as the page.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  const periodId = Number(params.id);
  if (!Number.isInteger(periodId) || periodId <= 0) return new Response("bad_request", { status: 400 });
  const view = buildPayslipView(getDb(), periodId, user.id);
  if (!view || view.period.status !== "paid") return new Response("not_found", { status: 404 });
  const pdf = await generatePayslipPdf(view, "staff");
  const emp = token(view.line.employee_code, `U${user.id}`);
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", payRoundBaseName(`Payslip_${emp}`, view.period, token(view.payslipBranchName, "")), "pdf") }
  });
}
