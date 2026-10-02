"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IrReportView from "@/app/components/ir/IrReportView";
import IrReportForm, { type ColleagueOption } from "@/app/components/ir/IrReportForm";
import { apiUrl } from "@/lib/url";
import type { IrReportDetail } from "@/lib/ir-db";

export default function StaffIrDetailClient({
  initialReport, canEdit, colleagues, selfUserId
}: {
  initialReport: IrReportDetail; canEdit: boolean; colleagues: ColleagueOption[]; selfUserId: number;
}) {
  const router = useRouter();
  const [r, setR] = useState<IrReportDetail>(initialReport);
  const [editing, setEditing] = useState(false);

  async function reload() {
    try {
      const res = await fetch(apiUrl(`/api/staff/ir/${r.id}`), { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setR(j.report as IrReportDetail);
    } catch { /* keep the current view */ }
  }

  if (editing) {
    return (
      <IrReportForm
        apiBase="/api/staff/ir"
        colleagues={colleagues}
        selfUserId={selfUserId}
        initial={r}
        onDone={async () => { await reload(); setEditing(false); router.refresh(); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-600">รายงานนี้ของคุณ — เพิ่มเติม/แก้ไขข้อเท็จจริง การวิเคราะห์ และข้อเสนอแนะได้จนกว่าทีม RM จะปิดเคส</span>
          <button type="button" className="btn btn-secondary text-sm" onClick={() => setEditing(true)}>แก้ไขรายงาน</button>
        </div>
      )}
      <IrReportView r={r} />
    </div>
  );
}
