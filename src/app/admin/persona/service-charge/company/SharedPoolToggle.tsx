"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "รวมกอง SVC ทั้งบริษัท" toggle (owner 2026-08-18). When ON, every branch's daily
// SVC for the month is pooled and split across everyone who worked at ANY branch,
// weighted by hours — so a worker at a branch with no SVC entered (e.g. a new HYPO)
// still gets a share. Per-month, flippable by any payroll-access admin.
export default function SharedPoolToggle({
  yearMonth, shared, canEdit
}: {
  yearMonth: string;
  shared: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function flip(next: boolean) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/persona/service-charge/shared-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year_month: yearMonth, shared: next })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? "error");
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card ${shared ? "border-brand/40 bg-brand/5" : ""}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-bold text-slate-800">
            คำนวณเซอร์วิสชาร์จรวมทั้งบริษัท {shared ? "· เปิดอยู่" : ""}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 max-w-xl">
            เปิดเมื่ออยากให้คนที่ถูกส่งไปทำสาขาที่ยังไม่มียอด (เช่น สาขาเปิดใหม่) ได้รับ
            ส่วนแบ่งด้วย — เฉพาะคนกลุ่มนั้นจะถูกดึงเข้าไปรับส่วนแบ่งจากสาขาที่มียอด
            ตามชั่วโมง ส่วนคนที่ทำสาขาที่มียอดอยู่แล้วได้ของสาขาตัวเองตามปกติ. ตั้งได้เป็นรายเดือน
          </div>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => flip(!shared)}
            disabled={busy}
            aria-pressed={shared}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
              shared ? "bg-brand" : "bg-slate-300"
            } ${busy ? "opacity-50" : ""}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                shared ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        ) : (
          <span className="text-xs text-slate-400">
            {shared ? "เปิดอยู่" : "ปิดอยู่"}
          </span>
        )}
      </div>
      {err && (
        <div className="text-xs text-rose-600 mt-2">
          บันทึกไม่สำเร็จ ({err}) — ลองใหม่อีกครั้ง
        </div>
      )}
    </div>
  );
}
