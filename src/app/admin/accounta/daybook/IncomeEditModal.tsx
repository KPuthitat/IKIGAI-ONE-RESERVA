"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { grpMoney, parseMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import Select from "@/app/components/Select";

export type EditableIncome = {
  id: number;
  branch_id: number | null;
  company_id: number | null;
  income_date: string;
  channel: string | null;
  amount: number;
  note: string | null;
  is_vat?: number;
  is_revenue?: number;
};

// ประเภทรายรับ → (is_vat, is_revenue). A VAT-exempt SALE is still revenue;
// financing (loans/เงินยืมกรรมการ) is neither. Mirrors the รายรับ page.
type IncKind = "sale_vat" | "sale_novat" | "financing";
const KIND_FLAGS: Record<IncKind, { is_vat: boolean; is_revenue: boolean }> = {
  sale_vat: { is_vat: true, is_revenue: true },
  sale_novat: { is_vat: false, is_revenue: true },
  financing: { is_vat: false, is_revenue: false }
};
const KIND_OPTS: Array<{ v: IncKind; label: string }> = [
  { v: "sale_vat", label: "ขาย/บริการ — มี VAT 7%" },
  { v: "sale_novat", label: "ขาย/บริการ — ยกเว้น VAT" },
  { v: "financing", label: "เงินกู้/เงินเข้าอื่น — ไม่นับยอดขาย ไม่มีภาษี" }
];
function kindOf(r: { is_vat?: number; is_revenue?: number }): IncKind {
  if (r.is_revenue === 0) return "financing";
  return r.is_vat === 0 ? "sale_novat" : "sale_vat";
}

// In-place edit modal for a รายรับ row — parity with the expense modal so the
// daybook is the single workspace (owner 2026-06-29). Only manual rows reach
// here; shift-close rows stay read-only (edited at ยอดขายรายวัน).
export default function IncomeEditModal({
  income, channels, onClose, onSaved
}: {
  income: EditableIncome;
  channels: Array<{ id: number; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [incomeDate, setIncomeDate] = useState(income.income_date);
  const [channel, setChannel] = useState(income.channel ?? "");
  const [amount, setAmount] = useState(grpMoney(String(income.amount)));
  const [kind, setKind] = useState<IncKind>(kindOf(income));
  const [note, setNote] = useState(income.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const total = parseMoney(amount) || 0;
    if (!Number.isFinite(total) || total <= 0) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setBusy(true); setErr(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const flags = KIND_FLAGS[kind];
      const body = {
        branch_id: income.branch_id, company_id: income.company_id,
        income_date: incomeDate, channel: channel.trim() || null,
        amount: total, note: note.trim() || null,
        is_vat: flags.is_vat, is_revenue: flags.is_revenue
      };
      let res: Response;
      try { res = await fetch(apiUrl(`/api/accounta/income/${income.id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) {
        setErr((e as { name?: string })?.name === "AbortError" ? "ใช้เวลานานเกินไป — ลองอีกครั้ง" : "เชื่อมต่อไม่ได้ — ลองอีกครั้ง");
        return;
      }
      if (res.redirected && /\/login(\?|$)/.test(res.url)) { setErr("เซสชันหมดอายุ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง"); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      onSaved();
    } finally { clearTimeout(timer); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-800">แก้ไขรายรับ</div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="label !text-xs">ประเภทรายรับ</label>
            <Select value={kind} onChange={(v) => setKind(v as IncKind)}
              options={KIND_OPTS.map((o) => ({ value: o.v, label: o.label }))} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label !text-xs">วันที่</label>
              <input type="date" className="input" value={incomeDate} onChange={(e) => setIncomeDate(e.target.value)} />
            </div>
            <div>
              <label className="label !text-xs">ยอดเงิน</label>
              <input type="text" inputMode="decimal" className="input text-right font-mono" value={amount} onChange={(e) => setAmount(grpMoney(e.target.value))} />
            </div>
          </div>
          <div>
            <label className="label !text-xs">ช่องทาง / รายการ</label>
            <input className="input" list="inc-edit-channels" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="เช่น เงินสด · เงินยืมกรรมการ" />
            <datalist id="inc-edit-channels">{channels.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          </div>
          <div>
            <label className="label !text-xs">หมายเหตุ</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เว้นว่างได้" />
          </div>
          {err && <div className="text-xs text-rose-600">{err}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button type="button" onClick={onClose}
            className="rounded-md border border-slate-300 bg-white text-slate-600 px-5 py-2 text-sm font-medium hover:bg-slate-50">
            ยกเลิก
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="rounded-md bg-brand text-white px-5 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );
}
