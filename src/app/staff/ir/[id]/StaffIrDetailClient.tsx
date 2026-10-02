"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IrReportView from "@/app/components/ir/IrReportView";
import IrReportForm, { type ColleagueOption } from "@/app/components/ir/IrReportForm";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import type { IrReportDetail } from "@/lib/ir-db";

export default function StaffIrDetailClient({
  initialReport, canEdit, colleagues, selfUserId
}: {
  initialReport: IrReportDetail; canEdit: boolean; colleagues: ColleagueOption[]; selfUserId: number;
}) {
  const router = useRouter();
  const [r, setR] = useState<IrReportDetail>(initialReport);
  const [editing, setEditing] = useState(false);
  const [justEdited, setJustEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Push the (edited) report to the risk-management LINE group again
  // (owner 2026-10-02: "ยังไม่มีปุ่มส่งรายงานซ้ำในการแก้ไขครั้งถัดไป").
  async function resend() {
    setSending(true); setSendMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/staff/ir/${r.id}/resend`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setSendMsg({ kind: "err", text: humanizeApiError(j, "ส่งไม่สำเร็จ") }); return; }
      setSendMsg({ kind: "ok", text: "ส่งรายงานถึงทีมบริหารความเสี่ยงอีกครั้งเรียบร้อยแล้ว" });
      setJustEdited(false);
    } catch {
      setSendMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    } finally {
      setSending(false);
    }
  }

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
        onDone={async () => { await reload(); setEditing(false); setJustEdited(true); setSendMsg(null); router.refresh(); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-slate-600">รายงานนี้เป็นของท่าน สามารถเพิ่มเติมหรือแก้ไขข้อเท็จจริง การวิเคราะห์ และข้อเสนอแนะได้จนกว่าทีมบริหารความเสี่ยงจะปิดเคส</span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary text-sm" onClick={() => setEditing(true)}>แก้ไขรายงาน</button>
              <button type="button" className={`btn text-sm ${justEdited ? "btn-primary" : "btn-secondary"}`} disabled={sending} onClick={resend}
                title="แจ้งทีมบริหารความเสี่ยงทาง LINE ว่ารายงานนี้มีข้อมูลเพิ่มเติม">
                {sending ? "กำลังส่ง…" : "ส่งรายงานถึงทีมบริหารความเสี่ยงอีกครั้ง"}
              </button>
            </div>
          </div>
          {justEdited && !sendMsg && (
            <div className="text-xs text-emerald-700">บันทึกการแก้ไขแล้ว หากต้องการให้ทีมบริหารความเสี่ยงทราบว่ามีข้อมูลเพิ่มเติม กรุณาเลือก “ส่งรายงานถึงทีมบริหารความเสี่ยงอีกครั้ง”</div>
          )}
          {sendMsg && <div className={`text-xs ${sendMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{sendMsg.text}</div>}
        </div>
      )}
      <IrReportView r={r} />
    </div>
  );
}
