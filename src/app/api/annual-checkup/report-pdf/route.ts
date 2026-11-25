import { getReportDataClinical, parseSubjectKey } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";
import { generateReportPdf } from "@/lib/health-report/report-pdf";
import { reportDisposition, reportFor } from "@/lib/health-report/pdf-data";

// GET ?roundId=&subject=u12|e5 — clinical staff print the booklet of a person whose results are released (the person's own view of it).
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return handleClinical(async (user) => {
    const sp = new URL(req.url).searchParams;
    const roundId = Number(sp.get("roundId")), subject = parseSubjectKey(sp.get("subject") ?? "");
    if (!Number.isInteger(roundId) || roundId <= 0 || !subject) return new Response("bad_request", { status: 400 }) as never;
    const d = getReportDataClinical(user, roundId, subject);
    if (!d) return new Response("not_released", { status: 404 }) as never;
    const { report, consultUrl } = reportFor(d);
    return new Response(await generateReportPdf(report, { consultUrl }) as unknown as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": reportDisposition(d) } }) as never;
  });
}
