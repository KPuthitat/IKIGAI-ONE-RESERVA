"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import PurchaseFlowChart, { FlowHeadline } from "@/app/components/PurchaseFlowChart";
import type { FlowRow } from "@/lib/purchase-flow";

const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DOT = { done: "bg-emerald-500", current: "nk-gradient", todo: "bg-slate-200", skipped: "bg-slate-300", failed: "bg-rose-500" } as const;

export default function FlowTrackerClient() {
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "me">("all");
  useEffect(() => {
    (async () => {
      try { const r = await fetch(apiUrl("/api/admin/purchase-flow")); const j = await r.json(); if (r.ok) setRows(j.rows); else setErr(j.message ?? "โหลดไม่สำเร็จ"); }
      catch { setErr("เชื่อมต่อไม่สำเร็จ"); }
    })();
  }, []);
  if (err) return <div className="card text-sm text-rose-700">{err}</div>;
  if (!rows) return <div className="card text-sm text-slate-500">กำลังโหลด…</div>;
  const mineCount = rows.filter((r) => r.waitingMe).length;
  const list = only === "me" ? rows.filter((r) => r.waitingMe) : rows;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`chip ${only === "all" ? "chip-active" : ""}`} onClick={() => setOnly("all")}>ทั้งหมด ({rows.length})</button>
        <button type="button" className={`chip ${only === "me" ? "chip-active" : ""}`} onClick={() => setOnly("me")}>รอฉัน ({mineCount})</button>
      </div>
      {list.length === 0 ? <div className="card text-sm text-slate-500 text-center py-8">{only === "me" ? "ไม่มีรายการที่รอท่าน" : "ไม่มีรายการค้าง"}</div> : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.key} className={`card !p-4 space-y-2 ${r.waitingMe ? "ring-2 ring-brand/40" : ""}`}>
              <button type="button" className="w-full text-left min-h-[44px]" onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 break-words">{r.flow.kind === "funding" && <span className="mr-1.5 rounded bg-violet-100 text-violet-800 text-[11px] px-1.5 py-0.5">ขอเบิกเงิน</span>}{r.waitingMe && <span className="mr-1.5 rounded bg-brand text-white text-[11px] px-1.5 py-0.5">รอท่าน</span>}{r.title}</div>
                    <div className="text-xs text-slate-500">{r.number} · {r.branchName}</div>
                  </div>
                  <div className="font-bold tabular-nums">฿{baht(r.amount)}</div>
                </div>
                <div className="mt-2 flex items-center gap-1" aria-hidden>{r.flow.steps.map((s) => <span key={s.key} className={`h-1.5 flex-1 rounded-full ${DOT[s.state]}`} />)}</div>
              </button>
              <FlowHeadline flow={r.flow} />
              {open === r.key && (
                <div className="pt-1 space-y-2">
                  <PurchaseFlowChart flow={r.flow} />
                  <div className="flex flex-wrap gap-2">
                    {r.flow.memoId && <a className="btn-secondary min-h-[44px] px-4 text-sm inline-flex items-center" href={apiUrl(`/admin/memos?id=${r.flow.memoId}`)}>เปิด Memo</a>}
                    {r.flow.prId && <a className="btn-secondary min-h-[44px] px-4 text-sm inline-flex items-center" href={apiUrl(`/admin/accounta/purchasing?pr=${r.flow.prId}`)}>เปิด {r.flow.prNo}</a>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
