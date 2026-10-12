"use client";

import { useRouter } from "next/navigation";
import IrReportForm, { type ColleagueOption } from "@/app/components/ir/IrReportForm";

export default function NewReportClient({ colleagues, selfUserId, isClinic = true }: { colleagues: ColleagueOption[]; selfUserId: number; isClinic?: boolean }) {
  const router = useRouter();
  return (
    <IrReportForm
      apiBase="/api/staff/ir"
      colleagues={colleagues}
      selfUserId={selfUserId}
      isClinic={isClinic}
      onDone={(r) => { router.push(`/staff/ir/${r.id}?sent=1`); router.refresh(); }}
      onCancel={() => router.push("/staff/ir")}
    />
  );
}
