"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

// Inline-editable table of the last 60 days. Each row = one date.
// Clicking the value (or the "เพิ่ม" link on missing days) flips
// the cell to an input; blur or Enter saves. Single endpoint:
// PUT /api/admin/ascenda/revenue with { branch_id, date, revenue }
// upserts via the lib helper.

const TH_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
                   "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const TH_DAYS = ["อา","จ","อ","พ","พฤ","ศ","ส"];

function friendlyDate(d: string): { line1: string; line2: string } {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(`${d}T00:00:00+07:00`);
  return {
    line1: `${day} ${TH_MONTHS[m - 1]} ${(y + 543) % 100}`,
    line2: TH_DAYS[dt.getDay()]
  };
}

function sourceLabel(s: string | null): string {
  if (s === "shift_close") return "พนักงาน";
  if (s === "admin_edit") return "แอดมิน";
  return "—";
}

export default function RevenueClient({
  branchId,
  dates,
  byDate
}: {
  branchId: number;
  dates: string[];
  byDate: Record<string, { revenue: number; source: string | null }>;
}) {
  const router = useRouter();
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function startEdit(date: string) {
    const existing = byDate[date];
    setEditingDate(date);
    setEditValue(existing ? String(existing.revenue) : "");
    setMsg(null);
  }

  async function save(date: string) {
    if (editValue.trim() === "") {
      setEditingDate(null);
      return;
    }
    const n = Number(editValue);
    if (!isFinite(n) || n < 0) {
      setMsg({ kind: "err", text: "ใส่ตัวเลขที่ ≥ 0 เท่านั้น" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/ascenda/revenue"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: branchId, date, revenue: n })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message || j.error || "บันทึกไม่สำเร็จ" });
        return;
      }
      setEditingDate(null);
      setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาดเครือข่าย" });
    } finally {
      setBusy(false);
    }
  }

  // Monthly totals so admin sees the running total per month at a glance.
  const monthly: Record<string, number> = {};
  for (const d of dates) {
    const month = d.slice(0, 7);
    monthly[month] = (monthly[month] || 0) + (byDate[d]?.revenue ?? 0);
  }

  return (
    <div className="space-y-3">
      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-3 font-semibold text-slate-600 w-24">วันที่</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-right">ยอดขาย (บาท)</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 w-20 text-center">บันทึกโดย</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d, idx) => {
              const ymd = friendlyDate(d);
              const existing = byDate[d];
              const isEditing = editingDate === d;
              const prevMonth = idx > 0 ? dates[idx - 1].slice(0, 7) : null;
              const thisMonth = d.slice(0, 7);
              const showMonthRow = idx === 0 || prevMonth !== thisMonth;
              return (
                <>
                  {showMonthRow && (
                    <tr key={`${d}-month`} className="bg-slate-50">
                      <td colSpan={3} className="py-1.5 px-3 text-[11px] font-bold text-slate-600">
                        {TH_MONTHS[Number(thisMonth.split("-")[1]) - 1]}{" "}
                        {Number(thisMonth.split("-")[0]) + 543}
                        <span className="ml-2 font-normal text-slate-500">
                          ยอดรวม: {fmtMoney(monthly[thisMonth] ?? 0)} บาท
                        </span>
                      </td>
                    </tr>
                  )}
                  <tr key={d} className="border-b border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">
                      <span className="font-medium">{ymd.line1}</span>
                      <span className="ml-1 text-[10px] text-slate-400">({ymd.line2})</span>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {isEditing ? (
                        <input
                          type="number" inputMode="decimal" step="0.01" min={0}
                          autoFocus
                          className="input text-right max-w-[160px] ml-auto"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => save(d)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") save(d);
                            if (e.key === "Escape") setEditingDate(null);
                          }}
                          disabled={busy}
                        />
                      ) : existing ? (
                        <button type="button"
                          onClick={() => startEdit(d)}
                          className="font-mono tabular-nums text-slate-800 hover:text-brand">
                          {fmtMoney(existing.revenue)}
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => startEdit(d)}
                          className="text-brand hover:underline text-[11px]">
                          + เพิ่ม
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-center text-[10px] text-slate-500">
                      {sourceLabel(existing?.source ?? null)}
                    </td>
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-slate-500">
        คลิกที่ตัวเลขเพื่อแก้ไข · กด Enter หรือคลิกออกเพื่อบันทึก · Esc ยกเลิก
      </div>
    </div>
  );
}
