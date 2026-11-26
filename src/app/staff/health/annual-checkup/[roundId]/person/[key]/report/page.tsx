import { notFound, redirect } from "next/navigation";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import { parseSubjectKey } from "@/lib/annual-checkup-db";

export const dynamic = "force-dynamic";

// The A4 print for outside people was a second copy of the report. There is one report now — the A5 booklet (PDF) — so the old address
// just opens it.
export default function OldReportRedirect({ params }: { params: { roundId: string; key: string } }) {
  requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0 || !parseSubjectKey(params.key)) notFound();
  redirect(`/api/annual-checkup/report-pdf?roundId=${roundId}&subject=${params.key}`);
}
