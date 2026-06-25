"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";

type Draft = {
  id: number; branch_id: number | null; branch_name: string | null;
  vendor_name: string | null; category: string | null; amount_total: number;
  bill_date: string; has_doc: boolean; note: string | null;
};

export default function InboxClient({
  drafts, confirmable
}: { drafts: Draft[]; confirmable: "all" | number[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canConfirm = (branchId: number | null) =>
    branchId != null && (confirmable === "all" || confirmable.includes(branchId));

  async function confirm(d: Draft) {
    setBusyId(d.id); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${d.id}/confirm`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ยืนยันไม่สำเร็จ")); return; }
      startTransition(() => router.refresh());
    } finally { setBusyId(null); }
  }

  // Group by branch (null = "ยังไม่ระบุสาขา"), preserve date order.
  const groups = (() => {
    const order: string[] = [];
    const m = new Map<string, { branchId: number | null; name: string; rows: Draft[] }>();
    for (const d of drafts) {
      const k = d.branch_id == null ? "none" : String(d.branch_id);
      if (!m.has(k)) { m.set(k, { branchId: d.branch_id, name: d.branch_name || "ยังไม่ระบุสาขา", rows: [] }); order.push(k); }
      m.get(k)!.rows.push(d);
    }
    return order.map((k) => m.get(k)!);
  })();

  if (drafts.length === 0) {
    return <div className="card text-center py-10 text-slate-500">ไม่มีเอกสารรอลงบัญชี</div>;
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {groups.map((g) => (
        <div key={g.name} className="space-y-2">
          <div className="flex items-baseline justify-between border-b border-slate-200 pb-1">
            <span className="text-sm font-bold text-slate-700">{g.name}</span>
            <span className="text-xs text-slate-400">{g.rows.length} เอกสาร</span>
          </div>
          <div className="card p-0 divide-y divide-slate-50">
            {g.rows.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-slate-50/60">
                <div className="min-w-0">
                  <div className="font-medium text-slate-800 truncate">{d.vendor_name || "— ยังไม่ระบุร้าน —"}</div>
                  <div className="text-[11px] text-slate-400">
                    {formatLongDate(d.bill_date, "th")}{d.category ? ` · ${d.category}` : ""}
                    {d.has_doc && (
                      <a href={apiUrl(`/api/accounta/expenses/${d.id}/doc`)} target="_blank" rel="noreferrer"
                        className="text-brand hover:underline ml-2">ดูเอกสาร</a>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono font-semibold text-rose-700 whitespace-nowrap">฿{fmtMoney(d.amount_total)}</span>
                  <Link href={`/admin/accounta/expenses?edit=${d.id}`} className="text-xs text-slate-500 hover:text-brand">ตรวจ/แก้ไข</Link>
                  {canConfirm(d.branch_id) ? (
                    <button type="button" onClick={() => confirm(d)} disabled={busyId === d.id}
                      className="text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md px-2.5 py-1 disabled:opacity-50">
                      {busyId === d.id ? "…" : "ยืนยันลงบัญชี"}
                    </button>
                  ) : (
                    <span className="text-[11px] text-slate-300" title={d.branch_id == null ? "ตรวจ/แก้ไขเพื่อระบุสาขาก่อน" : "คุณมีสิทธิ์ดูอย่างเดียว"}>
                      {d.branch_id == null ? "ระบุสาขาก่อน" : "ดูอย่างเดียว"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
