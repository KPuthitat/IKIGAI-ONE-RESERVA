"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Per-person manual GROSS ("ยอดก่อนโอน") for a company-wide month (owner
// 2026-09-03). Shows the value; when overridden, a "กรอกเอง" badge + the computed
// original. Admins with payout access can set/clear it while the month is draft.
export default function SvcGrossOverrideEditor({
  userId, yearMonth, gross, original, overridden, canEdit
}: {
  userId: number;
  yearMonth: string;
  gross: number;
  original: number | null;
  overridden: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(overridden ? String(gross) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(gross: number | null) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/company/gross-override"), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ yearMonth, userId, gross })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message || j.error || "ไม่สำเร็จ"); return; }
      setOpen(false);
      router.refresh();
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusy(false); }
  }

  return (
    <div className="text-right">
      <div className="font-medium">{fmtMoney(gross)}</div>
      {overridden && (
        <div className="text-[10px] text-amber-700">
          <span className="px-1 rounded bg-amber-50 border border-amber-200">กรอกเอง</span>
          {original != null && <span className="text-slate-400"> · เดิม {fmtMoney(original)}</span>}
        </div>
      )}
      {canEdit && (
        open ? (
          <div className="mt-1 inline-flex flex-col items-end gap-1">
            <input type="number" step="0.01" min="0" autoFocus value={val}
              onChange={(e) => setVal(e.target.value)} placeholder="ยอดก่อนโอน"
              className="border border-slate-300 rounded px-2 py-1 text-xs w-28 text-right" />
            {err && <span className="text-[10px] text-rose-600">{err}</span>}
            <div className="flex gap-1">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}
                className="text-[10px] px-2 py-0.5 rounded border border-slate-300 text-slate-500">ปิด</button>
              {overridden && (
                <button type="button" disabled={busy} onClick={() => save(null)}
                  className="text-[10px] px-2 py-0.5 rounded border border-rose-200 text-rose-600">ล้างค่า</button>
              )}
              <button type="button" disabled={busy || val.trim() === "" || isNaN(Number(val))}
                onClick={() => save(Math.round(Number(val) * 100) / 100)}
                className="text-[10px] px-2 py-0.5 rounded bg-brand text-white font-medium disabled:opacity-40">
                {busy ? "..." : "บันทึก"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => { setVal(overridden ? String(gross) : ""); setOpen(true); setErr(null); }}
            className="text-[10px] text-brand hover:underline mt-0.5">
            {overridden ? "แก้ยอด" : "กรอกยอดเอง"}
          </button>
        )
      )}
    </div>
  );
}
