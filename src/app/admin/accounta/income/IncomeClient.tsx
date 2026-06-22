"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";

type Ref = { id: number; name: string };
type Channel = { id: number; name: string };
type Income = {
  id: number; branch_id: number | null; branch_name: string | null;
  company_id: number | null; company_name: string | null;
  income_date: string; channel: string | null; amount: number; note: string | null;
  source: string;
  is_outstanding: number; settled_date: string | null;
};
type Summary = { total: number; byChannel: Array<{ channel: string; total: number }> };

type Form = {
  id: number | null; branch_id: string; company_id: string;
  income_date: string; channel: string; amount: string; note: string;
};

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function blank(channel = ""): Form {
  return { id: null, branch_id: "", company_id: "", income_date: todayISO(), channel, amount: "", note: "" };
}

export default function IncomeClient(props: {
  month: string; branches: Ref[]; companies: Ref[]; channels: Channel[];
  initialIncome: Income[]; initialSummary: Summary;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(props.month);
  const [branchId, setBranchId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<Income[]>(props.initialIncome);
  const [summary, setSummary] = useState<Summary>(props.initialSummary);
  const [channels, setChannels] = useState<Channel[]>(props.channels);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(blank(props.channels[0]?.name ?? ""));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [newChan, setNewChan] = useState<string | null>(null);

  async function reload(next?: { month?: string; branch?: string; company?: string }) {
    const m = next?.month ?? month, b = next?.branch ?? branchId, co = next?.company ?? companyId;
    setBusy(true); setErr(null);
    try {
      const q = new URLSearchParams({ month: m });
      if (b) q.set("branch", b);
      if (co) q.set("company", co);
      const res = await fetch(apiUrl(`/api/accounta/income?${q}`));
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "โหลดไม่สำเร็จ")); return; }
      setRows(j.income); setSummary(j.summary);
    } finally { setBusy(false); }
  }

  function openAdd() { setForm(blank(channels[0]?.name ?? "")); setNewChan(null); setErr(null); setOpen(true); }
  function openEdit(r: Income) {
    setForm({
      id: r.id, branch_id: r.branch_id != null ? String(r.branch_id) : "",
      company_id: r.company_id != null ? String(r.company_id) : "",
      income_date: r.income_date, channel: r.channel ?? "", amount: String(r.amount), note: r.note ?? ""
    });
    setNewChan(null); setErr(null); setOpen(true);
  }

  async function addChannel() {
    const name = (newChan ?? "").trim();
    if (!name) { setNewChan(null); return; }
    try {
      const res = await fetch(apiUrl("/api/accounta/income-channels"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) { setChannels(j.channels); set("channel", name); }
    } finally { setNewChan(null); }
  }

  async function save() {
    const amt = Number(form.amount);
    if (!form.amount || !Number.isFinite(amt) || amt <= 0) { setErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        branch_id: form.branch_id ? Number(form.branch_id) : null,
        company_id: form.company_id ? Number(form.company_id) : null,
        income_date: form.income_date, channel: form.channel || null,
        amount: amt, note: form.note.trim() || null
      };
      const url = form.id ? `/api/accounta/income/${form.id}` : "/api/accounta/income";
      const res = await fetch(apiUrl(url), {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setOpen(false); await reload(); router.refresh();
    } finally { setBusy(false); }
  }

  async function remove(r: Income) {
    if (!window.confirm(`ลบรายรับ ${r.channel ?? ""} ฿${fmtMoney(r.amount)} ?`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/income/${r.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      await reload();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={openAdd} disabled={busy} className="btn-primary disabled:opacity-50">+ เพิ่มรายรับ</button>
        <input type="month" className="input !w-auto" value={month}
          onChange={(e) => { setMonth(e.target.value); reload({ month: e.target.value }); }} />
        <select className="input !w-auto" value={companyId}
          onChange={(e) => { setCompanyId(e.target.value); reload({ company: e.target.value }); }}>
          <option value="">ทุกบริษัท</option>
          {props.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input !w-auto" value={branchId}
          onChange={(e) => { setBranchId(e.target.value); reload({ branch: e.target.value }); }}>
          <option value="">ทุกสาขา</option>
          {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Channel summary */}
      <div className="card space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] tracking-wide text-slate-400">รวมรายรับเดือนนี้ (แยกช่องทาง)</span>
          <span className="text-2xl font-bold text-emerald-700">฿{fmtMoney(summary.total)}</span>
        </div>
        {summary.byChannel.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {summary.byChannel.map((c) => (
              <span key={c.channel} className="text-xs bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
                {c.channel} <b className="text-emerald-800">฿{fmtMoney(c.total)}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="card text-center py-10 text-slate-500">ยังไม่มีรายรับในเดือนนี้</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-400 border-b border-slate-100">
                <th className="px-3 py-2">วันที่</th>
                <th className="px-3 py-2">ช่องทาง</th>
                <th className="px-3 py-2">สาขา</th>
                <th className="px-3 py-2 text-right">จำนวนเงิน</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatLongDate(r.income_date, "th")}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5">
                      {r.channel || (r.source === "shift_close" ? "ยอดขายรวม" : "—")}
                      {r.source === "shift_close" && (
                        <span className="text-[10px] font-normal bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-1.5 py-px">จากปิดกะ</span>
                      )}
                      {!!r.is_outstanding && (
                        r.settled_date
                          ? <span className="text-[10px] font-normal bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-1.5 py-px">รับชำระแล้ว</span>
                          : <span className="text-[10px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">ค้างชำระ</span>
                      )}
                    </div>
                    {r.note && <div className="text-[11px] text-slate-500">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.branch_name || "—"}</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-700 whitespace-nowrap">฿{fmtMoney(r.amount)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.source === "shift_close" ? (
                      <span className="text-[11px] text-slate-300" title="ยอดนี้ดึงจากรายงานปิดกะอัตโนมัติ — แก้ไขได้ที่ยอดขายรายวัน">อัตโนมัติ</span>
                    ) : (
                      <>
                        <button type="button" onClick={() => openEdit(r)} disabled={busy} className="text-xs text-slate-500 hover:text-brand">แก้</button>
                        <button type="button" onClick={() => remove(r)} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600 ml-3">ลบ</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onClick={() => !busy && setOpen(false)}>
          <div className="card w-full max-w-lg my-8 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{form.id ? "แก้ไขรายรับ" : "เพิ่มรายรับ"}</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label !text-xs">วันที่</label>
                <input type="date" className="input" value={form.income_date} onChange={(e) => set("income_date", e.target.value)} />
              </div>
              <div>
                <label className="label !text-xs">ช่องทางชำระเงิน</label>
                {newChan === null ? (
                  <select className="input" value={form.channel}
                    onChange={(e) => { if (e.target.value === "__add__") setNewChan(""); else set("channel", e.target.value); }}>
                    <option value="">— เลือก —</option>
                    {channels.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                    <option value="__add__">+ เพิ่มช่องทาง…</option>
                  </select>
                ) : (
                  <div className="flex gap-1">
                    <input className="input" autoFocus value={newChan} onChange={(e) => setNewChan(e.target.value)}
                      placeholder="เช่น TrueMoney / Rabbit LINE Pay"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChannel(); } }} />
                    <button type="button" className="btn-secondary !px-2" onClick={addChannel}>เพิ่ม</button>
                    <button type="button" className="btn-secondary !px-2" onClick={() => setNewChan(null)}>✕</button>
                  </div>
                )}
              </div>
              <div>
                <label className="label !text-xs">สาขา</label>
                <select className="input" value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>
                  <option value="">— ไม่ระบุ —</option>
                  {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label !text-xs">บริษัท</label>
                <select className="input" value={form.company_id} onChange={(e) => set("company_id", e.target.value)}>
                  <option value="">— ไม่ระบุ —</option>
                  {props.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label !text-xs">จำนวนเงิน</label>
                <input type="number" inputMode="decimal" className="input" value={form.amount}
                  onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
              </div>
              <div>
                <label className="label !text-xs">หมายเหตุ</label>
                <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-secondary" disabled={busy}>ยกเลิก</button>
              <button type="button" onClick={save} className="btn-primary disabled:opacity-50" disabled={busy}>
                {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
