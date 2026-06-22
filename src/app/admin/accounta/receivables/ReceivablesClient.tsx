"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";

type Row = { id: number; income_date: string; channel: string | null; amount: number; note: string | null };
type Entity = { channel: string; amount: number; count: number };

export default function ReceivablesClient({
  initialRows, initialByEntity, initialTotal
}: { initialRows: Row[]; initialByEntity: Entity[]; initialTotal: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [byEntity, setByEntity] = useState<Entity[]>(initialByEntity);
  const [total, setTotal] = useState<number>(initialTotal);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function settle(r: Row) {
    if (!window.confirm(`บันทึกรับชำระ "${r.channel ?? "ลูกหนี้"}" ฿${fmtMoney(r.amount)} วันนี้?`)) return;
    setBusyId(r.id); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/receivables"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setRows(j.rows); setByEntity(j.byEntity); setTotal(j.total);
      router.refresh();
    } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      <div className="card text-center py-3">
        <div className="text-[11px] text-slate-400">ลูกหนี้ค้างชำระคงค้างทั้งหมด</div>
        <div className="text-2xl font-bold text-amber-700">฿{fmtMoney(total)}</div>
      </div>

      {/* Outstanding by entity */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ค้างชำระแยกตามเจ้า</div>
        {byEntity.length === 0 ? (
          <p className="text-xs text-slate-400">ไม่มียอดค้างชำระ</p>
        ) : (
          <div className="space-y-1">
            {byEntity.map((e) => (
              <div key={e.channel} className="flex justify-between text-sm">
                <span className="text-slate-700">{e.channel} <span className="text-[11px] text-slate-400">({e.count} รายการ)</span></span>
                <span className="font-mono text-amber-700">฿{fmtMoney(e.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Open receivable line items */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">รายการค้างชำระ ({rows.length})</div>
        {rows.length === 0 ? (
          <p className="text-xs text-slate-400">ไม่มีรายการค้างชำระ — เก็บเงินครบแล้ว 🎉</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-100">
                  <th className="text-left py-1.5 px-2">วันที่ขาย</th>
                  <th className="text-left py-1.5 px-2">เจ้า / ช่องทาง</th>
                  <th className="text-right py-1.5 px-2">ยอด</th>
                  <th className="text-right py-1.5 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{formatLongDate(r.income_date, "th")}</td>
                    <td className="py-1.5 px-2 text-slate-700">{r.channel || "—"}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-amber-700">฿{fmtMoney(r.amount)}</td>
                    <td className="py-1.5 px-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => settle(r)} disabled={busyId === r.id}
                        className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                        ✓ รับชำระแล้ว
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
