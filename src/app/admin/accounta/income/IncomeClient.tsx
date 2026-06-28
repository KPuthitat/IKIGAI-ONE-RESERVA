"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { humanizeApiError } from "@/lib/error-messages";
import { useConfirm } from "@/app/components/useConfirm";

type Ref = { id: number; name: string };
type Channel = { id: number; name: string };
type Income = {
  id: number; branch_id: number | null; branch_name: string | null;
  company_id: number | null; company_name: string | null;
  income_date: string; channel: string | null; amount: number; note: string | null;
  source: string;
  is_outstanding: number; settled_date: string | null; is_vat: number; is_revenue: number;
};
type Summary = { total: number; byChannel: Array<{ channel: string; total: number }> };

type Form = {
  id: number | null; branch_id: string; company_id: string;
  income_date: string; channel: string; amount: string; note: string;
  is_vat: boolean; is_revenue: boolean;
};

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function blank(channel = ""): Form {
  return { id: null, branch_id: "", company_id: "", income_date: todayISO(), channel, amount: "", note: "", is_vat: true, is_revenue: true };
}

// ประเภทรายรับ → (is_vat, is_revenue). A VAT-exempt SALE is still revenue.
type IncKind = "sale_vat" | "sale_novat" | "financing";
function kindOf(f: { is_vat: boolean; is_revenue: boolean }): IncKind {
  if (!f.is_revenue) return "financing";
  return f.is_vat ? "sale_vat" : "sale_novat";
}
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
const TH_MON = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function monthLabel(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${TH_MON[m]} ${y + 543}`; }

// Group rows month → day, preserving the query's desc order (owner 2026-06-25:
// this page is now for reviewing/editing entered rows, แยกเดือน → แยกวัน).
function groupByMonthDay(rows: Income[]) {
  const mOrder: string[] = [];
  const mMap = new Map<string, Map<string, Income[]>>();
  for (const r of rows) {
    const mk = r.income_date.slice(0, 7);
    if (!mMap.has(mk)) { mMap.set(mk, new Map()); mOrder.push(mk); }
    const dMap = mMap.get(mk)!;
    if (!dMap.has(r.income_date)) dMap.set(r.income_date, []);
    dMap.get(r.income_date)!.push(r);
  }
  return mOrder.map((mk) => {
    const days = [...mMap.get(mk)!.entries()].map(([date, rs]) => ({ date, total: rs.reduce((s, x) => s + x.amount, 0), rows: rs }));
    return { month: mk, total: days.reduce((s, d) => s + d.total, 0), days };
  });
}

export default function IncomeClient(props: {
  month: string; activeBranchId: number | null; branches: Ref[]; companies: Ref[]; channels: Channel[];
  initialIncome: Income[]; initialSummary: Summary;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [month, setMonth] = useState(props.month);
  // Default to the active branch so the list + summary + dropdown all agree —
  // previously the filter defaulted to "ทุกสาขา" while the page pre-scoped the
  // list to the active branch, so the top totals showed other branches' income
  // (owner 2026-06-24: "มียอดขายที่ไม่ใช่ของนามะ").
  const [branchId, setBranchId] = useState(props.activeBranchId != null ? String(props.activeBranchId) : "");
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

  // Bulk CSV import with preview-before-commit (owner 2026-06-27).
  const importRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  type ImportPreview = {
    willImport: number; total: number; failed: number; unresolvedBranch: number;
    dateFrom: string | null; dateTo: string | null;
    byCategory: Array<{ name: string; count: number; amount: number }>;
    sample: Array<{ income_date: string; channel: string | null; amount: number; note: string | null }>;
    errors: Array<{ row: number; message: string }>;
  };
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  function downloadTemplate() {
    const header = "branch,company,income_date,channel,amount,note,is_vat,is_revenue";
    const sample = [
      "NAMA PASTA SRIRACHA,,2026-01-05,เงินสด,5000,ขายหน้าร้าน,1,1",
      "HYPOPLARAEMIA,,2026-01-06,เงินยืมกรรมการ,100000,กรรมการให้กู้ยืม,0,0"
    ];
    const blob = new Blob(["﻿" + [header, ...sample].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ACCOUNTA_income_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function previewCsv(file: File) {
    setPreviewBusy(true); setErr(null); setImportMsg(null); setPreview(null);
    try {
      const fd = new FormData();
      fd.append("csv", file);
      fd.append("dry_run", "1");
      const res = await fetch(apiUrl("/api/accounta/income/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "อ่านไฟล์ไม่สำเร็จ")); return; }
      setPreview(j as ImportPreview);
      setPreviewFile(file);
    } finally { setPreviewBusy(false); }
  }

  async function confirmImport() {
    if (!previewFile) return;
    setBusy(true); setErr(null); setImportMsg("กำลังนำเข้า…");
    try {
      const fd = new FormData();
      fd.append("csv", previewFile);
      const res = await fetch(apiUrl("/api/accounta/income/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setImportMsg(null); setErr(humanizeApiError(j, "นำเข้าไม่สำเร็จ")); return; }
      setImportMsg(`นำเข้าสำเร็จ ${j.imported} รายการ${j.failed ? ` · ข้าม ${j.failed} (ผิดรูปแบบ)` : ""}`);
      setPreview(null); setPreviewFile(null);
      await reload(); router.refresh();
    } finally { setBusy(false); }
  }

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

  // New income is always keyed to the active branch (owner 2026-06-25: no
  // cross-branch entry — switch branch at the top-left to record another).
  function openAdd() {
    setForm({ ...blank(channels[0]?.name ?? ""), branch_id: props.activeBranchId != null ? String(props.activeBranchId) : "" });
    setNewChan(null); setErr(null); setOpen(true);
  }
  function openEdit(r: Income) {
    setForm({
      id: r.id, branch_id: r.branch_id != null ? String(r.branch_id) : "",
      company_id: r.company_id != null ? String(r.company_id) : "",
      income_date: r.income_date, channel: r.channel ?? "", amount: String(r.amount), note: r.note ?? "",
      is_vat: r.is_vat !== 0, is_revenue: r.is_revenue !== 0
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
        amount: amt, note: form.note.trim() || null, is_vat: form.is_vat, is_revenue: form.is_revenue
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
    const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบรายรับ ${r.channel ?? ""} ฿${fmtMoney(r.amount)} ?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
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
      {ConfirmDialog}
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
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={downloadTemplate} className="text-xs text-slate-500 hover:text-brand underline">
            เทมเพลต CSV
          </button>
          <button type="button" onClick={() => importRef.current?.click()} disabled={busy || previewBusy}
            className="btn-secondary !py-1.5 disabled:opacity-50">
            {previewBusy ? "กำลังอ่านไฟล์…" : "นำเข้า CSV"}
          </button>
          <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) previewCsv(f); e.target.value = ""; }} />
        </span>
      </div>
      {importMsg && <p className="text-sm text-emerald-700">{importMsg}</p>}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { setPreview(null); setPreviewFile(null); } }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8 p-5 space-y-4">
            <div>
              <h3 className="text-lg font-bold text-slate-800">ตรวจสอบก่อนนำเข้า (รายรับ)</h3>
              <p className="text-xs text-slate-500 mt-0.5">ยังไม่บันทึกจนกว่าจะกด “ยืนยันนำเข้า” · การนำเข้าไม่มีปุ่มย้อนกลับ</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
                <div className="text-[11px] text-slate-500">จะนำเข้า</div>
                <div className="text-xl font-bold text-emerald-700">{preview.willImport.toLocaleString("en-US")}</div>
                <div className="text-[10px] text-slate-400">รายการ</div>
              </div>
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
                <div className="text-[11px] text-slate-500">ยอดรวม</div>
                <div className="text-xl font-bold text-emerald-700">฿{fmtMoney(preview.total)}</div>
                <div className="text-[10px] text-slate-400">{preview.dateFrom && preview.dateTo ? `${preview.dateFrom} → ${preview.dateTo}` : "—"}</div>
              </div>
              <div className={`rounded-lg border p-3 text-center ${preview.failed > 0 ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-100"}`}>
                <div className="text-[11px] text-slate-500">ข้าม (ผิดรูปแบบ)</div>
                <div className={`text-xl font-bold ${preview.failed > 0 ? "text-amber-700" : "text-slate-400"}`}>{preview.failed.toLocaleString("en-US")}</div>
                <div className="text-[10px] text-slate-400">รายการ</div>
              </div>
            </div>

            {preview.unresolvedBranch > 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                ⚠ {preview.unresolvedBranch} รายการระบุสาขาที่จับคู่ไม่ได้ — จะลงเป็นยังไม่ผูกสาขา
              </p>
            )}

            <div>
              <div className="text-xs font-bold text-slate-600 mb-1">แยกตามช่องทาง</div>
              <div className="border border-slate-100 rounded-lg divide-y divide-slate-50 max-h-40 overflow-y-auto">
                {preview.byCategory.map((c) => (
                  <div key={c.name} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <span className="text-slate-700">{c.name} <span className="text-slate-400 text-[11px]">×{c.count}</span></span>
                    <span className="font-mono text-emerald-700">฿{fmtMoney(c.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-bold text-slate-600 mb-1">ตัวอย่าง {preview.sample.length} แถวแรก</div>
              <div className="border border-slate-100 rounded-lg divide-y divide-slate-50 max-h-44 overflow-y-auto text-[12px]">
                {preview.sample.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="text-slate-400 shrink-0 w-20">{s.income_date}</span>
                    <span className="text-slate-700 truncate flex-1">{s.channel || "—"}</span>
                    <span className="text-slate-400 shrink-0 text-[11px] truncate max-w-[10rem]">{s.note || ""}</span>
                    <span className="font-mono text-emerald-700 shrink-0">฿{fmtMoney(s.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            {preview.errors.length > 0 && (
              <div>
                <div className="text-xs font-bold text-amber-700 mb-1">แถวที่ข้าม (ตัวอย่าง)</div>
                <div className="border border-amber-100 rounded-lg divide-y divide-amber-50 max-h-28 overflow-y-auto text-[11px]">
                  {preview.errors.slice(0, 10).map((e, i) => (
                    <div key={i} className="px-3 py-1 text-amber-700">แถว {e.row}: {e.message}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setPreview(null); setPreviewFile(null); }} disabled={busy}
                className="btn-secondary disabled:opacity-50">ยกเลิก</button>
              <button type="button" onClick={confirmImport} disabled={busy || preview.willImport === 0}
                className="btn-primary disabled:opacity-50">
                {busy ? "กำลังนำเข้า…" : `ยืนยันนำเข้า ${preview.willImport.toLocaleString("en-US")} รายการ`}
              </button>
            </div>
          </div>
        </div>
      )}

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
        <div className="card text-center py-10 text-slate-500">ยังไม่มีรายรับในช่วงที่เลือก</div>
      ) : (
        <div className="space-y-4">
          {groupByMonthDay(rows).map((mo) => (
            <div key={mo.month} className="space-y-2">
              <div className="flex items-baseline justify-between border-b border-slate-200 pb-1">
                <span className="text-sm font-bold text-slate-700">{monthLabel(mo.month)}</span>
                <span className="text-sm font-bold text-emerald-700">฿{fmtMoney(mo.total)}</span>
              </div>
              {mo.days.map((d) => (
                <div key={d.date} className="card p-0 overflow-hidden">
                  <div className="flex items-baseline justify-between bg-slate-50 px-3 py-1.5 border-b border-slate-100">
                    <span className="text-xs font-semibold text-slate-600">{formatLongDate(d.date, "th")}</span>
                    <span className="text-xs font-mono font-bold text-emerald-700">฿{fmtMoney(d.total)}</span>
                  </div>
                  <table className="w-full text-sm">
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                              {r.channel || (r.source === "shift_close" ? "ยอดขายรวม" : "—")}
                              {r.source === "shift_close" && (
                                <span className="text-[10px] font-normal bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-1.5 py-px">Check list หลังเลิกงาน</span>
                              )}
                              {!!r.is_outstanding && (
                                r.settled_date
                                  ? <span className="text-[10px] font-normal bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-1.5 py-px">รับชำระแล้ว</span>
                                  : <span className="text-[10px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">ค้างชำระ</span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500">{r.branch_name || "—"}{r.note ? ` · ${r.note}` : ""}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-emerald-700 whitespace-nowrap">฿{fmtMoney(r.amount)}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {r.source === "shift_close" ? (
                              <span className="text-[11px] text-slate-300" title="ยอดนี้ดึงจากรายงานปิดกะอัตโนมัติ — แก้ไขได้ที่สมุดรายวัน">อัตโนมัติ</span>
                            ) : (
                              <>
                                <button type="button" onClick={() => openEdit(r)} disabled={busy} className="text-xs text-slate-500 hover:text-brand">แก้ไข</button>
                                <button type="button" onClick={() => remove(r)} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600 ml-3">ลบออก</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
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
                {form.id == null ? (
                  <div className="input bg-slate-50 text-slate-600 flex items-center">
                    {props.branches.find((b) => String(b.id) === form.branch_id)?.name ?? "สาขาที่เปิดอยู่"}
                  </div>
                ) : (
                  <select className="input" value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>
                    <option value="">— ไม่ระบุ —</option>
                    {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                )}
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
              <div className="sm:col-span-2">
                <label className="label !text-xs">ประเภทรายรับ</label>
                <select className="input" value={kindOf(form)}
                  onChange={(e) => { const f = KIND_FLAGS[e.target.value as IncKind]; setForm((s) => ({ ...s, ...f })); }}>
                  {KIND_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  เงินกู้/เงินยืมกรรมการ เลือก “ไม่นับยอดขาย” — ยังเป็นเงินเข้าในช่องทาง แต่ไม่รวมในยอดขายเฉลี่ย/ประมาณการ และไม่คิดภาษี
                </p>
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
