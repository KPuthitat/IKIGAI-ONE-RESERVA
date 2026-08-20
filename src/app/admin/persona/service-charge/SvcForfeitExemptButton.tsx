"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ปุ่มยกเว้นการตัดสิทธิ์ SVC (owner 2026-08-20). การตัดสิทธิ์ (สายเกิน 20% / ลาออก) เป็น
// อัตโนมัติ แต่ผู้บริหารกด "ยกเว้นให้" รายคน/รายเดือนได้ → คนนั้นได้รับ SVC ตามปกติ.
// ใช้ได้ทั้งหน้ารายสาขาและหน้ารวมบริษัท (คีย์ด้วย user+เดือน เหมือนกัน).
const reasonLabel = (r: "late_20pct" | "resignation" | null) =>
  r === "late_20pct" ? "สายเกิน 20%" : r === "resignation" ? "ลาออก" : "";

export default function SvcForfeitExemptButton({
  userId, yearMonth, forfeited, exempted, reason, canEdit
}: {
  userId: number;
  yearMonth: string;
  forfeited: boolean;
  exempted: boolean;
  reason: "late_20pct" | "resignation" | null;
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
      const res = await fetch("/api/admin/persona/service-charge/forfeit-exemption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, year_month: yearMonth, exempted: next })
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setErr(true);
      setBusy(false);
    }
  }

  // Exempted → show the waived badge + an undo link (exec can re-apply the rule).
  if (exempted) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold whitespace-nowrap"
          title={`ยกเว้นการตัดสิทธิ์ให้แล้ว (เดิม: ${reasonLabel(reason)})`}>
          ✓ ยกเว้นให้ · เดิม {reasonLabel(reason)}
        </span>
        {canEdit && (
          <button type="button" onClick={() => set(false)} disabled={busy}
            className="text-[10px] text-slate-400 hover:text-rose-600 underline disabled:opacity-50">
            {busy ? "…" : "ยกเลิก"}
          </button>
        )}
        {err && <span className="text-[10px] text-rose-600">ลองใหม่</span>}
      </span>
    );
  }

  // Forfeited + editable → offer the waive button.
  if (forfeited && canEdit) {
    return (
      <button type="button" onClick={() => set(true)} disabled={busy}
        className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium whitespace-nowrap disabled:opacity-50"
        title="จ่าย SVC ให้คนนี้เดือนนี้ แม้จะถูกตัดสิทธิ์อัตโนมัติ">
        {busy ? "…" : "ยกเว้นให้"}{err ? " (ลองใหม่)" : ""}
      </button>
    );
  }

  return null;
}
