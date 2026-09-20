"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ปุ่ม "ตรวจแล้ว" รายคน บนตารางเซอร์วิสชาร์จ (owner 2026-09-20). ผู้ตรวจกดเพื่อทำ
// เครื่องหมายว่า ตรวจสอบรายการคำนวณของคนนั้นในเดือนนี้ครบแล้ว — เป็นแค่เครื่องหมาย
// ไม่กระทบยอดเงิน. คีย์ด้วย user+เดือน จึงเห็นตรงกันทั้งหน้ารายสาขาและหน้ารวมบริษัท.
export default function SvcReviewButton({
  userId, yearMonth, reviewed, reviewedByName, canEdit
}: {
  userId: number;
  yearMonth: string;
  reviewed: boolean;
  reviewedByName?: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  async function set(next: boolean) {
    if (busy) return;
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch("/api/admin/persona/service-charge/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, year_month: yearMonth, reviewed: next })
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setErr(true);
      setBusy(false);
    }
  }

  // Reviewed → green ✓ badge; click to un-mark (only if this admin may edit).
  if (reviewed) {
    return (
      <span className="inline-flex items-center gap-1">
        <button type="button" onClick={canEdit ? () => set(false) : undefined} disabled={busy || !canEdit}
          className={`text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold whitespace-nowrap ${canEdit ? "hover:bg-emerald-200" : ""} disabled:opacity-100`}
          title={reviewedByName ? `ตรวจแล้วโดย ${reviewedByName}${canEdit ? " · กดเพื่อยกเลิก" : ""}` : "ตรวจแล้ว"}>
          {busy ? "…" : "✓ ตรวจแล้ว"}
        </button>
        {err && <span className="text-[10px] text-rose-600">ลองใหม่</span>}
      </span>
    );
  }

  if (!canEdit) return null;

  return (
    <button type="button" onClick={() => set(true)} disabled={busy}
      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-50 hover:text-slate-700 font-medium whitespace-nowrap disabled:opacity-50"
      title="ทำเครื่องหมายว่าตรวจสอบรายการคำนวณของคนนี้แล้ว">
      {busy ? "…" : "ตรวจแล้ว"}{err ? " (ลองใหม่)" : ""}
    </button>
  );
}
