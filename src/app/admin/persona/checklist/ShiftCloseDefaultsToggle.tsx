"use client";

// Branch-level toggles for the three default money fields on the
// shift_close report. Shown above the per-item checklist editor
// when ?type=shift_close. Each toggle controls whether the value
// renders in the prominent red headline box at the top of the
// LINE Flex card, or falls through to the regular checklist body
// (where it still appears, just without the dramatic background).
//
// Wired to POST /api/admin/persona/shift-close-defaults — the
// route updates the operator's currently-active branch row.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function ShiftCloseDefaultsToggle({
  initial
}: {
  initial: {
    closing_drawer: boolean;
    service_charge: boolean;
    daily_revenue: boolean;
  };
}) {
  const router = useRouter();
  const [drawer, setDrawer] = useState(initial.closing_drawer);
  const [svc, setSvc] = useState(initial.service_charge);
  const [revenue, setRevenue] = useState(initial.daily_revenue);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dirty =
    drawer !== initial.closing_drawer ||
    svc !== initial.service_charge ||
    revenue !== initial.daily_revenue;

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/shift-close-defaults"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          closing_drawer: drawer,
          service_charge: svc,
          daily_revenue: revenue
        })
      });
      if (!res.ok) {
        setMsg("บันทึกไม่สำเร็จ ลองอีกครั้ง");
        return;
      }
      setMsg("✓ บันทึกแล้ว");
      // router.refresh re-pulls the server-rendered page so `initial`
      // matches what's now on disk — `dirty` flips back to false.
      router.refresh();
      setTimeout(() => setMsg(null), 2200);
    } catch {
      setMsg("เครือข่ายมีปัญหา ลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<{
    label: string;
    hint: string;
    value: boolean;
    onChange: (next: boolean) => void;
  }> = [
    {
      label: "ยอดเงินปิดงาน",
      hint: "เงินสด + e-wallet + อื่นๆ ที่ปิดยอดท้ายวัน",
      value: drawer,
      onChange: setDrawer
    },
    {
      label: "เซอร์วิสชาร์จวันนี้",
      hint: "ยอด SVC ของวันนี้ก่อนหารแบ่ง",
      value: svc,
      onChange: setSvc
    },
    {
      label: "ยอดขายวันนี้",
      hint: "ASCENDA daily revenue ยอดขายรวมจากระบบ POS",
      value: revenue,
      onChange: setRevenue
    }
  ];

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-bold text-slate-800">
          🎯 ตัวเลขเด่นในกรอบแดง
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          เลือกว่าจะให้ตัวเลขไหนเด่นในกรอบแดงด้านบนของการ์ดสรุปท้ายวัน
          · เปิดทุกอันแสดงในกรอบแดง · ปิดเฉพาะอันที่ไม่จำเป็น
          ตัวที่ปิดยังคงปรากฏในเช็คลิสต์ปกติ (ตัวหนา) เพียงไม่อยู่ในกรอบแดง
        </p>
      </div>

      <div className="space-y-2">
        {rows.map((r) => (
          <label
            key={r.label}
            className={`flex items-start gap-3 cursor-pointer p-3 rounded-lg border transition ${
              r.value
                ? "border-rose-300 bg-rose-50/40"
                : "border-slate-200 bg-slate-50 opacity-80"
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={r.value}
              onChange={(e) => r.onChange(e.target.checked)}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-slate-800">{r.label}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{r.hint}</div>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex-shrink-0 mt-0.5 ${
                r.value
                  ? "bg-rose-500 text-white"
                  : "bg-slate-200 text-slate-500"
              }`}
            >
              {r.value ? "กรอบแดง" : "ปกติ"}
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2 justify-end">
        {msg && (
          <span className="text-xs text-slate-500 mr-auto">{msg}</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="btn-primary text-sm disabled:opacity-50"
        >
          {busy ? "กำลังบันทึก..." : dirty ? "บันทึก" : "บันทึกแล้ว"}
        </button>
      </div>
    </div>
  );
}
