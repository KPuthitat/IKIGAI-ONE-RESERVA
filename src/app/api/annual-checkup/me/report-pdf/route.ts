import { getMyReportData } from "@/lib/annual-checkup-db";
import { handle, isViewOpen } from "@/lib/annual-checkup-api";
import { hasConsented } from "@/lib/annual-checkup-employee";
import { generateReportPdf } from "@/lib/health-report/report-pdf";
import { reportDisposition, reportFor } from "@/lib/health-report/pdf-data";

// GET ?round=<id> — the signed-in employee's OWN released report as an A5 PDF. Same gates as the page: session, consent, the open PIN window.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return handle(async (user) => {
    const round = Number(new URL(req.url).searchParams.get("round"));
    if (!Number.isInteger(round) || round <= 0) return new Response("bad_request", { status: 400 }) as never;
    if (!hasConsented(user.id)) return new Response("consent_required", { status: 403 }) as never;
    if (!isViewOpen(user)) return new Response("view_locked", { status: 403 }) as never;
    const d = getMyReportData(user, round);
    if (!d) return new Response("not_found", { status: 404 }) as never;
    const { report, consultUrl } = reportFor(d);
    const pdf = await generateReportPdf(report, { consultUrl });
    return new Response(pdf as unknown as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": reportDisposition(d) } }) as never;
  });
}
