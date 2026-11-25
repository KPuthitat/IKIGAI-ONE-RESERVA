import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contentDisposition, monthTok, token } from "@/lib/download-name";
import { buildMonthlyPayslip } from "@/lib/monthly-payslip";
import { generateMonthlyPayslipPdf } from "@/lib/monthly-payslip-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/payroll/monthly-payslip/[userId]/pdf?m=YYYY-MM — the combined monthly payslip as an A4 PDF.
export async function GET(req: Request, { params }: { params: { userId: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });
  const userId = Number(params.userId);
  const m = new URL(req.url).searchParams.get("m") ?? "";
  if (!Number.isInteger(userId) || userId <= 0 || !/^\d{4}-\d{2}$/.test(m)) return new Response("bad_request", { status: 400 });
  const db = getDb();
  const d = buildMonthlyPayslip(db, userId, m, "th");
  if (!d) return new Response("not_found", { status: 404 });
  const pdf = await generateMonthlyPayslipPdf(d, m);
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", ["MonthlyPayslip", token(d.profile.employee_code, `U${userId}`), monthTok(m)].join("_"), "pdf") }
  });
}
