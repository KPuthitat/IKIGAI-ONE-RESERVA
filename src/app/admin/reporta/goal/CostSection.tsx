"use client";

import { useState } from "react";
import type { CostRatios } from "@/lib/cost-guardrails";

type Props = { items: Array<{ label: string; r: CostRatios }>; busy: boolean; onSave: (code: string, min: number | null, max: number | null) => void };
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const COLOR = { over: "text-rose-700", under: "text-amber-700", ok: "text-emerald-700", na: "text-slate-400" } as const;

function Band({ code, min, max, busy, onSave }: { code: string; min: number | null; max: number | null; busy: boolean; onSave: Props["onSave"] }) {
  const [a, setA] = useState(min == null ? "" : String(min)), [b, setB] = useState(max == null ? "" : String(max));
  const dirty = a !== (min == null ? "" : String(min)) || b !== (max == null ? "" : String(max));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <span className="inline-flex items-center gap-1">
      <input className="input w-14 px-1 py-0.5 text-xs text-right" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} aria-label="ต่ำสุด %" />
      –
      <input className="input w-14 px-1 py-0.5 text-xs text-right" inputMode="decimal" value={b} onChange={(e) => setB(e.target.value)} aria-label="สูงสุด %" />
      %
      {dirty && <button type="button" className="btn-secondary text-xs px-2 py-0.5" disabled={busy} onClick={() => onSave(code, num(a), num(b))}>บันทึก</button>}
    </span>
  );
}

export default function CostSection({ items, busy, onSave }: Props) {
  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-slate-800">4. สัดส่วนต้นทุนต่อยอดขาย (เดือนนี้ถึงวันนี้)</h2>
      <p className="text-xs text-slate-500">
        คิดเป็น % ของรายได้ในบัญชี หักส่วนแบ่งที่ต้องโอนคืนพันธมิตรออกก่อน (ยอดขายของพันธมิตรไม่ใช่ของเรา) และไม่นับรายจ่ายลงทุน (CapEx) ·
        บิลมักเข้าช้า ครึ่งเดือนแรกต้นทุนจึงดูต่ำกว่าจริง ให้อ่านเป็นสัญญาณเตือนมากกว่าผลสรุป · แก้ช่วงเกณฑ์ได้ที่ช่องตัวเลข (ใช้ร่วมกับหน้ารายจ่ายของ ACCOUNTA)
      </p>
      {items.map(({ label, r }) => (
        <div key={label} className="rounded-xl border border-slate-200 p-3 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <b className="text-slate-800">{label}</b>
            <span className="text-xs text-slate-500">รายได้ {n(r.revenue)} บาท{r.partnerPayout > 0 ? ` (หักส่วนแบ่งพันธมิตร ${n(r.partnerPayout)} จาก ${n(r.revenueBooks)})` : ""}</span>
          </div>
          {r.revenue <= 0 ? <p className="text-sm text-slate-500">ยังไม่มีรายได้ลงบัญชีเดือนนี้</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-2">หมวด</th><th className="py-1 pr-2 text-right">ยอด (บาท)</th><th className="py-1 pr-2 text-right">% ของรายได้</th><th className="py-1">เกณฑ์</th></tr></thead>
                <tbody>
                  {r.rows.map((x) => (
                    <tr key={x.name} className="border-b border-slate-100">
                      <td className="py-1 pr-2">{x.name}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{n(x.spent)}</td>
                      <td className={`py-1 pr-2 text-right tabular-nums font-medium ${COLOR[x.status]}`}>{x.pct == null ? "—" : `${x.pct}%`}{x.status === "over" ? " ▲" : x.status === "under" ? " ▼" : ""}</td>
                      <td className="py-1">{x.code ? <Band key={`${x.code}-${x.min}-${x.max}`} code={x.code} min={x.min} max={x.max} busy={busy} onSave={onSave} /> : "—"}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-1 pr-2">กำไรก่อนภาษี</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{n(r.profit)}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${r.profitStatus === "under" ? "text-rose-700" : r.profitStatus === "ok" ? "text-emerald-700" : "text-slate-600"}`}>{r.profitPct == null ? "—" : `${r.profitPct}%`}</td>
                    <td className="py-1"><Band key={`P-${r.profitBand.min}-${r.profitBand.max}`} code="PROFIT" min={r.profitBand.min} max={r.profitBand.max} busy={busy} onSave={onSave} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
