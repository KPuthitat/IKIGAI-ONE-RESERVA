import { cookies } from "next/headers";
import { getLinkReportData } from "@/lib/annual-checkup-db";
import { LINK_COOKIE, readLinkToken } from "@/lib/annual-checkup-session";
import { generateReportPdf } from "@/lib/health-report/report-pdf";
import { reportDisposition, reportFor } from "@/lib/health-report/pdf-data";

// GET — PUBLIC but needs the 15-minute window opened with the date of birth; the report of the person behind THAT link only.
export const dynamic = "force-dynamic";
export async function GET() {
  const linkId = readLinkToken(cookies().get(LINK_COOKIE)?.value);
  if (linkId == null) return new Response("not_allowed", { status: 403 });
  const d = getLinkReportData(linkId);
  if (!d) return new Response("not_found", { status: 404 });
  const { report, consultUrl } = reportFor(d);
  return new Response(await generateReportPdf(report, { consultUrl }) as unknown as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": reportDisposition(d) } });
}
