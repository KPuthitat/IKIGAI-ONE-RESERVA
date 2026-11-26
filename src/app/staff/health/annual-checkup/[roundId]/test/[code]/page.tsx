import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import { loadItems } from "@/lib/health-report/store";

export const dynamic = "force-dynamic";

// "ลงผลรายรายการ" exists once: the item sheet (/item/<code>). The old per-test sheet opens the first item of that test.
export default function OldTestSheetRedirect({ params }: { params: { roundId: string; code: string } }) {
  requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0 || !/^[A-Z0-9_]{1,20}$/.test(params.code)) notFound();
  const first = loadItems(getDb()).find((i) => i.test === params.code && !i.hidden && !i.computed && i.kind !== "file");
  if (!first) redirect(`/staff/health/annual-checkup/${roundId}`);
  redirect(`/staff/health/annual-checkup/${roundId}/item/${first.code}`);
}
