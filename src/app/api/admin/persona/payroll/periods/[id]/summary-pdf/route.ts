import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { thDateBE } from "@/lib/th-month";
import { contentDisposition, payRoundBaseName, token } from "@/lib/download-name";
import { buildRoundSummary } from "@/lib/round-summary";
import { generateRoundSummaryPdf } from "@/lib/round-summary-pdf";

export const dynamic = "force-dynamic";

// GET /api/admin/persona/payroll/periods/[id]/summary-pdf — the whole-round compensation summary as a laid-out A4
// landscape PDF (owner 2026-11-24), same numbers as the on-screen page (shared builder).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return new Response("invalid_id", { status: 400 });

  const db = getDb();
  const data = buildRoundSummary(db, id);
  if (!data) return new Response("period_not_found", { status: 404 });

  const b = data.period.branch_id != null ? db.prepare("SELECT name, slug FROM branches WHERE id = ?").get(data.period.branch_id) as { name: string; slug: string } | undefined : undefined;
  const base = payRoundBaseName("RoundSummary", data.period, b ? token(b.name, token(b.slug, `Branch-${data.period.branch_id}`)) : null);
  const pdf = await generateRoundSummaryPdf(data, thDateBE(new Date(), { bangkok: true, time: true }));
  return new Response(pdf as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", base, "pdf") }
  });
}
