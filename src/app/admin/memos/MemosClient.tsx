"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";
import type { MemoDetail, MemoRow, MemoStatus } from "@/lib/memos";
import SignaturePad from "./SignaturePad";

type Choice = { id: number; name: string; role: string; cLevel: boolean; hasSignature: boolean };
type ListData = {
  me: { userId: number; hasSignature: boolean; isCLevel: boolean; role: string }; memos: MemoRow[]; awaiting: MemoRow[];
  branches: Array<{ id: number; name: string }>; vendors: Record<number, Array<{ id: number; name: string }>>; categories: Array<{ name: string; kind: string }>; signers: Choice[];
  accounts: Array<{ id: number; name: string; last4: string | null; purpose: string | null }>; executiveIds: number[]; topExecIds: number[];
};
type FormItem = { description: string; qty: string; unit: string; unit_price: string };
type Form = { id?: number; branch_id: number; subject: string; body: string; category: string; needed_date: string; vendor_id: number | null; vendor_name: string; vat_rate: 0 | 7; items: FormItem[]; signer_ids: number[];
  kind: "purchase" | "funding"; pay_account_id: number | null; from_account_id: number | null; to_account_id: number | null; week_start: string; amount: string };

const STATUS: Record<MemoStatus, { th: string; cls: string }> = {
  draft: { th: "ร่าง", cls: "bg-slate-100 text-slate-700" }, pending: { th: "รอลงนาม", cls: "bg-amber-100 text-amber-800" }, approved: { th: "ลงนามครบ · เปิด PR ได้", cls: "bg-emerald-100 text-emerald-800" },
  rejected: { th: "ไม่เห็นชอบ", cls: "bg-rose-100 text-rose-700" }, cancelled: { th: "ยกเลิก", cls: "bg-slate-200 text-slate-600" }, pr_opened: { th: "เปิด PR แล้ว", cls: "bg-sky-100 text-sky-800" }
};
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (s: string | null) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—");
const EVENT_TH: Record<string, string> = { create: "สร้าง Memo", update: "แก้ไข", submit: "ส่งขอลงนาม", sign: "ลงลายมือชื่อ", approved: "ลงนามครบ — อนุมัติ Memo", reject: "ไม่เห็นชอบ", reopen: "ดึงกลับมาแก้ไข", cancel: "ยกเลิก", open_pr: "เปิด PR" };
const blank = (branch: number, kind: "purchase" | "funding" = "purchase", accounts: ListData["accounts"] = []): Form => ({ kind, pay_account_id: null, week_start: "", amount: "",
  from_account_id: kind === "funding" ? (accounts.find((a) => a.purpose === "working") ?? accounts[0])?.id ?? null : null, to_account_id: kind === "funding" ? accounts.find((a) => a.purpose === "procurement")?.id ?? null : null,
  branch_id: branch, subject: "", body: "", category: "", needed_date: "", vendor_id: null, vendor_name: "", vat_rate: 0, items: [{ description: "", qty: "1", unit: "", unit_price: "" }], signer_ids: [] });

async function call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; j: Record<string, unknown> }> {
  try {
    const r = await fetch(apiUrl(path), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, status: r.status, j };
  } catch { return { ok: false, status: 0, j: { message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" } }; }
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function printMemo(m: MemoDetail) {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  const rows = m.items.map((i) => `<tr><td>${i.lineNo}</td><td>${esc(i.description)}</td><td class="r">${i.qty} ${esc(i.unit)}</td><td class="r">${baht(i.unitPrice)}</td><td class="r">${baht(i.amount)}</td></tr>`).join("");
  const sig = m.signers.map((s) => `<div class="sig"><div class="img">${s.signature ? `<img src="${s.signature}" alt="">` : ""}</div><div class="n">(${esc(s.name)})</div><div class="d">${s.status === "signed" ? `ลงนามเมื่อ ${esc(when(s.signedAt))}` : s.status === "rejected" ? `ไม่เห็นชอบ: ${esc(s.comment)}` : "ยังไม่ลงนาม"}</div></div>`).join("");
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(m.memoNo)}</title><style>
    body{font-family:'LINE Seed Sans TH',system-ui,sans-serif;color:#0f172a;margin:28px;font-size:14px;line-height:1.55} h1{font-size:20px;margin:0 0 4px} .m{color:#475569;font-size:12px}
    table{width:100%;border-collapse:collapse;margin:10px 0} td,th{border:1px solid #94a3b8;padding:5px 8px;text-align:left} .r{text-align:right} .sigs{display:flex;flex-wrap:wrap;gap:24px;margin-top:28px}
    .sig{width:200px;text-align:center} .img{height:70px;display:flex;align-items:flex-end;justify-content:center;border-bottom:1px solid #334155} .img img{max-height:66px;max-width:190px} .n{margin-top:4px;font-weight:600} .d{font-size:11px;color:#475569}
  </style></head><body><h1>บันทึกข้อความ (Memo) ${m.kind === "funding" ? "ขอเบิกเงิน" : "ขอซื้อ"}</h1><div class="m">${esc(m.memoNo)} · ${esc(m.branchName)} · ผู้ขอ ${esc(m.authorName)}${m.prNo ? ` · PR ${esc(m.prNo)}` : ""}</div>
    <p><b>เรื่อง</b> ${esc(m.subject)}</p>${m.body ? `<p>${esc(m.body).replace(/\n/g, "<br>")}</p>` : ""}
    ${m.kind === "funding" ? `<p class="m">โอนจาก ${esc(m.fromAccountName ?? "—")} ไปยัง ${esc(m.toAccountName ?? "—")}${m.weekStart ? ` · สัปดาห์เริ่ม ${esc(m.weekStart)}` : ""}</p><p><b>จำนวนเงินที่ขอเบิก ${baht(m.total)} บาท</b></p>` : `<p class="m">หมวด ${esc(m.category)} · ผู้จำหน่าย ${esc(m.vendorName || "—")} · วันที่ต้องการ ${esc(m.neededDate ?? "—")}${m.payAccountName ? ` · จ่ายจาก ${esc(m.payAccountName)}` : ""}</p>
    <table><thead><tr><th>#</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">รวม</th></tr></thead><tbody>${rows}
    <tr><td colspan="4" class="r">รวมก่อนภาษี</td><td class="r">${baht(m.subtotal)}</td></tr>${m.vatRate ? `<tr><td colspan="4" class="r">VAT ${m.vatRate}%</td><td class="r">${baht(m.vatAmount)}</td></tr>` : ""}
    <tr><td colspan="4" class="r"><b>ยอดรวม</b></td><td class="r"><b>${baht(m.total)}</b></td></tr></tbody></table>`}
    <div class="sigs">${sig}</div><script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

export default function MemosClient({ openId }: { openId: number | null }) {
  const [data, setData] = useState<ListData | null>(null);
  const [tab, setTab] = useState<"sign" | "mine" | "all">("sign");
  const [detail, setDetail] = useState<MemoDetail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pad, setPad] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await call("GET", "/api/admin/memos");
    if (r.ok) { const d = r.j as unknown as ListData; setData(d); if (d.awaiting.length === 0) setTab((t) => (t === "sign" ? "mine" : t)); }
    else setMsg({ ok: false, text: (r.j.message as string) ?? "โหลดไม่สำเร็จ" });
  }, []);
  const open = useCallback(async (id: number) => {
    const r = await call("GET", `/api/admin/memos?id=${id}`);
    if (r.ok) setDetail(r.j.memo as MemoDetail); else setMsg({ ok: false, text: "ไม่พบ Memo หรือท่านไม่มีสิทธิ์ดู" });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openId) open(openId); }, [openId, open]);

  async function act(action: string, id: number, extra: Record<string, unknown> = {}, okText = "เรียบร้อย"): Promise<Record<string, unknown> | null> {
    setBusy(true); setMsg(null);
    const r = await call("POST", "/api/admin/memos", { action, id, ...extra });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: (r.j.message as string) ?? "ไม่สำเร็จ" }); return { error: r.j.error, detail: r.j.detail } as Record<string, unknown>; }
    setMsg({ ok: true, text: okText }); await load(); await open(id);
    return null;
  }

  if (!data) return <div className="card text-sm text-slate-500">กำลังโหลด…</div>;
  const mine = data.memos.filter((m) => m.authorId === data.me.userId);
  const list = tab === "sign" ? data.awaiting : tab === "mine" ? mine : data.memos;
  const defaultBranch = data.branches[0]?.id ?? 0;

  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      {!data.me.hasSignature && (
        <div className="card flex flex-wrap items-center gap-3 border-amber-300 bg-amber-50">
          <div className="text-sm text-amber-900 flex-1 min-w-[14rem]">ท่านยังไม่ได้ตั้งลายเซ็น — ต้องมีก่อนจึงลงลายมือชื่อ Memo ได้ (และต้องมี PIN ที่ตั้งไว้ที่หน้าลงเวลา)</div>
          <button type="button" className="btn-primary min-h-[44px] px-4" onClick={() => setPad(true)}>วาดลายเซ็น</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([["sign", `รอฉันลงนาม (${data.awaiting.length})`], ["mine", `Memo ของฉัน (${mine.length})`], ["all", `ทั้งหมด (${data.memos.length})`]] as const).map(([k, th]) =>
          <button key={k} type="button" className={`chip ${tab === k ? "chip-active" : ""}`} onClick={() => setTab(k)}>{th}</button>)}
        <div className="flex-1" />
        {data.me.hasSignature && <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => setPad(true)}>ลายเซ็นของฉัน</button>}
        {data.branches.length > 0 && <button type="button" className="btn-primary min-h-[44px] px-4" onClick={() => { setDetail(null); setForm(blank(defaultBranch)); }}>เขียน Memo ขอซื้อ</button>}
        {data.branches.length > 0 && data.accounts.length >= 2 && <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => { setDetail(null); setForm(blank(defaultBranch, "funding", data.accounts)); }}>ขอเบิกเงิน (โอนระหว่างบัญชี)</button>}
      </div>

      {list.length === 0 ? <div className="card text-sm text-slate-500 text-center py-8">{tab === "sign" ? "ไม่มี Memo รอลงนาม" : "ยังไม่มี Memo"}</div> : (
        <ul className="space-y-2">
          {list.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => { setForm(null); open(m.id); }} className={`card w-full text-left !p-4 hover:bg-slate-50 min-h-[64px] ${detail?.id === m.id ? "ring-2 ring-brand/40" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0"><div className="font-semibold text-slate-900 break-words">{m.kind === "funding" && <span className="mr-1.5 rounded bg-violet-100 text-violet-800 text-[11px] px-1.5 py-0.5">ขอเบิกเงิน</span>}{m.subject}</div><div className="text-xs text-slate-500">{m.memoNo} · {m.branchName} · ผู้ขอ {m.authorName}</div></div>
                  <div className="text-right shrink-0"><div className="font-bold tabular-nums">฿{baht(m.total)}</div><span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] ${STATUS[m.status].cls}`}>{STATUS[m.status].th}</span></div>
                </div>
                {m.status === "pending" && <div className="mt-2 flex items-center gap-2"><div className="h-2 flex-1 rounded-full bg-slate-200 overflow-hidden"><div className="h-full nk-gradient" style={{ width: `${m.signerCount ? (m.signed / m.signerCount) * 100 : 0}%` }} /></div><span className="text-[11px] text-slate-600">ลงนาม {m.signed}/{m.signerCount}</span></div>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {form && <MemoForm form={form} data={data} busy={busy} onChange={setForm} onCancel={() => setForm(null)}
        onSave={async (f, send) => {
          setBusy(true); setMsg(null);
          const body = { id: f.id, kind: f.kind, pay_account_id: f.pay_account_id, from_account_id: f.from_account_id, to_account_id: f.to_account_id, week_start: f.week_start || null, amount: f.kind === "funding" ? Number(f.amount) || undefined : undefined, branch_id: f.branch_id, subject: f.subject, body: f.body, category: f.category, needed_date: f.needed_date || null, vendor_id: f.vendor_id, vendor_name: f.vendor_name, vat_rate: f.vat_rate,
            items: f.items.filter((i) => i.description.trim()).map((i) => ({ description: i.description.trim(), qty: Number(i.qty), unit: i.unit, unit_price: Number(i.unit_price) })), signer_ids: f.signer_ids };
          const r = await call("POST", "/api/admin/memos", { action: "save", memo: body });
          if (!r.ok) { setBusy(false); setMsg({ ok: false, text: (r.j.message as string) ?? "บันทึกไม่สำเร็จ" }); return; }
          const id = r.j.id as number;
          if (send) { const s = await call("POST", "/api/admin/memos", { action: "submit", id }); if (!s.ok) { setBusy(false); setMsg({ ok: false, text: `บันทึกร่างแล้ว แต่ส่งไม่ได้: ${(s.j.message as string) ?? ""}` }); setForm(null); await load(); await open(id); return; } }
          setBusy(false); setForm(null); setMsg({ ok: true, text: send ? "ส่งขอลงนามแล้ว — ผู้ลงนามได้รับแจ้งเตือน" : "บันทึกร่างแล้ว" }); await load(); await open(id);
        }} />}

      {detail && !form && <MemoView m={detail} data={data} busy={busy} act={act} onEdit={() => setForm({ id: detail.id, branch_id: detail.branchId, subject: detail.subject, body: detail.body, category: detail.category, needed_date: detail.neededDate ?? "", vendor_id: detail.vendorId, vendor_name: detail.vendorName,
        vat_rate: detail.vatRate === 7 ? 7 : 0, items: detail.items.map((i) => ({ description: i.description, qty: String(i.qty), unit: i.unit, unit_price: String(i.unitPrice) })), signer_ids: detail.signers.map((s) => s.userId),
          kind: detail.kind, pay_account_id: detail.payAccountId, from_account_id: detail.fromAccountId, to_account_id: detail.toAccountId, week_start: detail.weekStart ?? "", amount: detail.kind === "funding" ? String(detail.total) : "" })}
        onNeedSignature={() => setPad(true)} onClose={() => setDetail(null)} />}

      {pad && <SignaturePad current={null} onClose={() => setPad(false)} onSaved={async () => { setPad(false); setMsg({ ok: true, text: "บันทึกลายเซ็นแล้ว" }); await load(); }} />}
    </div>
  );
}

function MemoView({ m, data, busy, act, onEdit, onNeedSignature, onClose }: {
  m: MemoDetail; data: ListData; busy: boolean; act: (a: string, id: number, x?: Record<string, unknown>, t?: string) => Promise<Record<string, unknown> | null>; onEdit: () => void; onNeedSignature: () => void; onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [obr, setObr] = useState<string | null>(null);
  const isAuthor = m.authorId === data.me.userId || data.me.role === "super_admin";
  const mySigner = m.signers.find((s) => s.userId === data.me.userId);
  const canSign = m.status === "pending" && mySigner?.status === "pending";

  return (
    <section className="card space-y-4" aria-label="รายละเอียด Memo">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><div className="text-xs text-slate-500">{m.memoNo} · {m.branchName} · ผู้ขอ {m.authorName}</div><h2 className="text-lg font-bold text-slate-900 break-words">{m.subject}</h2></div>
        <div className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS[m.status].cls}`}>{STATUS[m.status].th}</span><button type="button" className="text-sm text-slate-500 underline min-h-[44px]" onClick={onClose}>ปิด</button></div>
      </div>
      {m.body && <p className="text-sm text-slate-700 whitespace-pre-line">{m.body}</p>}
      {m.kind === "funding" ? (
        <div className="rounded-xl bg-violet-50 border border-violet-200 p-3 text-sm space-y-1">
          <div>โอนจาก <b>{m.fromAccountName}</b> → <b>{m.toAccountName}</b>{m.weekStart ? ` · สัปดาห์เริ่ม ${m.weekStart}` : ""}</div>
          <div className="text-lg font-bold tabular-nums">฿{baht(m.total)}</div>
          {m.status === "approved" && <div className="text-xs text-violet-900">ลงนามครบแล้ว — รอฝ่ายการเงินโอนและบันทึกที่หน้า <a className="underline" href={apiUrl("/admin/accounta/funding")}>เงินโอนระหว่างบัญชี</a></div>}
        </div>
      ) : <div className="text-xs text-slate-500">หมวด {m.category} · ผู้จำหน่าย {m.vendorName || "—"} · วันที่ต้องการ {m.neededDate ?? "—"}{m.payAccountName ? ` · จ่ายจาก ${m.payAccountName}` : ""}</div>}

      {/* phone: one card per line; wider screens: a table */}
      {m.kind !== "funding" && <><ul className="sm:hidden space-y-2">
        {m.items.map((i) => <li key={i.lineNo} className="rounded-xl bg-slate-50 px-3 py-2"><div className="font-medium break-words">{i.lineNo}. {i.description}</div><div className="flex justify-between text-xs text-slate-600 mt-0.5"><span>{i.qty} {i.unit} × {baht(i.unitPrice)}</span><b className="tabular-nums text-slate-900">{baht(i.amount)}</b></div></li>)}
        {m.vatRate > 0 && <li className="flex justify-between text-sm px-1 text-slate-600"><span>VAT {m.vatRate}%</span><span className="tabular-nums">{baht(m.vatAmount)}</span></li>}
        <li className="flex justify-between px-1 font-bold"><span>ยอดรวม</span><span className="tabular-nums">฿{baht(m.total)}</span></li>
      </ul>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1 pr-2 w-8">#</th><th className="py-1 pr-2">รายการ</th><th className="py-1 pr-2 text-right">จำนวน</th><th className="py-1 pr-2 text-right">ราคา/หน่วย</th><th className="py-1 text-right">รวม</th></tr></thead>
          <tbody>
            {m.items.map((i) => <tr key={i.lineNo} className="border-b border-slate-100"><td className="py-1 pr-2 tabular-nums">{i.lineNo}</td><td className="py-1 pr-2">{i.description}</td><td className="py-1 pr-2 text-right tabular-nums">{i.qty} {i.unit}</td><td className="py-1 pr-2 text-right tabular-nums">{baht(i.unitPrice)}</td><td className="py-1 text-right tabular-nums">{baht(i.amount)}</td></tr>)}
            {m.vatRate > 0 && <tr><td colSpan={4} className="py-1 text-right text-slate-500">VAT {m.vatRate}%</td><td className="py-1 text-right tabular-nums">{baht(m.vatAmount)}</td></tr>}
            <tr><td colSpan={4} className="py-1 text-right font-semibold">ยอดรวม</td><td className="py-1 text-right font-bold tabular-nums">฿{baht(m.total)}</td></tr>
          </tbody>
        </table>
      </div></>}

      <div>
        <div className="font-semibold text-slate-800 text-sm mb-2">ผู้ลงนาม ({m.signed}/{m.signerCount})</div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {m.signers.map((s) => (
            <li key={s.userId} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-sm">{s.name}</span>
                <span className={`text-[11px] rounded-full px-2 py-0.5 ${s.status === "signed" ? "bg-emerald-100 text-emerald-800" : s.status === "rejected" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{s.status === "signed" ? "ลงนามแล้ว" : s.status === "rejected" ? "ไม่เห็นชอบ" : "รอลงนาม"}</span></div>
              {s.signature && /* eslint-disable-next-line @next/next/no-img-element */ <img src={s.signature} alt={`ลายเซ็น ${s.name}`} className="h-14 mt-1 object-contain" />}
              <div className="text-[11px] text-slate-500">{s.signedAt ? when(s.signedAt) : ""}{s.comment ? ` · เหตุผล: ${s.comment}` : ""}</div>
            </li>
          ))}
        </ul>
      </div>

      {canSign && (
        <div className="rounded-xl border-2 border-brand/30 p-3 space-y-2">
          <div className="font-semibold text-sm text-slate-800">ลงลายมือชื่อ</div>
          {!data.me.hasSignature ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-amber-900"><span>ยังไม่มีลายเซ็น</span><button type="button" className="btn-primary min-h-[44px] px-4" onClick={onNeedSignature}>วาดลายเซ็น</button></div>
          ) : rejecting ? (
            <div className="space-y-2">
              <textarea className="input w-full" rows={2} maxLength={1000} placeholder="เหตุผลที่ไม่เห็นชอบ (จำเป็น)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2"><button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => setRejecting(false)}>กลับ</button>
                <button type="button" className="min-h-[44px] px-4 rounded-xl bg-rose-600 text-white font-semibold disabled:opacity-60" disabled={busy || !reason.trim()} onClick={() => act("reject", m.id, { reason }, "บันทึกว่าไม่เห็นชอบแล้ว")}>ยืนยันไม่เห็นชอบ</button></div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-32 min-h-[44px] text-center tracking-widest" inputMode="numeric" type="password" maxLength={4} placeholder="PIN 4 หลัก" aria-label="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
              <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || pin.length !== 4} onClick={async () => { const r = await act("sign", m.id, { pin }, "ลงลายมือชื่อแล้ว"); if (!r) setPin(""); }}>เห็นชอบและลงลายมือชื่อ</button>
              <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => setRejecting(true)}>ไม่เห็นชอบ</button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {isAuthor && m.status === "draft" && <><button type="button" className="btn-secondary min-h-[44px] px-4" onClick={onEdit}>แก้ไข</button>
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy} onClick={() => act("submit", m.id, {}, "ส่งขอลงนามแล้ว — ผู้ลงนามได้รับแจ้งเตือน")}>ส่งขอลงนาม</button></>}
        {isAuthor && (m.status === "pending" || m.status === "rejected") && <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy} onClick={() => act("reopen", m.id, {}, "ดึงกลับเป็นร่างแล้ว (ลายเซ็นที่ลงไว้ถูกล้าง)")}>{m.status === "rejected" ? "แก้ไขแล้วส่งใหม่" : "ดึงกลับมาแก้ไข"}</button>}
        {isAuthor && m.status === "approved" && m.kind !== "funding" && <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy} onClick={async () => {
          const r = await act("open_pr", m.id, obr ? { over_budget_reason: obr } : {}, "เปิด PR แล้ว — ส่งให้ผู้บริหารอนุมัติ");
          if (r && r.detail === "over_budget_reason_required") { const why = window.prompt("ยอดนี้เกินงบ (หรือยังไม่ได้ตั้งงบ) กรุณาระบุเหตุผล"); if (why?.trim()) { setObr(why.trim()); await act("open_pr", m.id, { over_budget_reason: why.trim() }, "เปิด PR แล้ว — ส่งให้ผู้บริหารอนุมัติ"); } }
        }}>เปิด PR จาก Memo</button>}
        {isAuthor && ["draft", "pending", "rejected", "approved"].includes(m.status) && <button type="button" className="min-h-[44px] px-4 rounded-xl border border-rose-300 text-rose-700 text-sm" disabled={busy} onClick={() => { if (window.confirm("ยกเลิก Memo นี้?")) act("cancel", m.id, {}, "ยกเลิกแล้ว"); }}>ยกเลิก Memo</button>}
        {m.prId && <a className="btn-secondary min-h-[44px] px-4 inline-flex items-center" href={apiUrl(`/admin/accounta/purchasing?pr=${m.prId}`)}>ดู {m.prNo}</a>}
        <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => printMemo(m)}>พิมพ์ Memo (พร้อมลายเซ็น)</button>
      </div>

      <details className="text-sm"><summary className="cursor-pointer text-slate-600 min-h-[44px] flex items-center">ประวัติ ({m.events.length})</summary>
        <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{m.events.map((e, i) => <li key={i}>{when(e.at)} · {e.actor} · {EVENT_TH[e.action] ?? e.action}{e.detail ? ` (${e.detail})` : ""}</li>)}</ul></details>
    </section>
  );
}

function MemoForm({ form, data, busy, onChange, onSave, onCancel }: { form: Form; data: ListData; busy: boolean; onChange: (f: Form) => void; onSave: (f: Form, send: boolean) => void; onCancel: () => void }) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => onChange({ ...form, [k]: v });
  const setItem = (i: number, patch: Partial<FormItem>) => set("items", form.items.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const subtotal = form.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
  const vat = Math.round(subtotal * form.vat_rate) / 100;
  const vendors = data.vendors[form.branch_id] ?? [];
  const toggle = (id: number) => set("signer_ids", form.signer_ids.includes(id) ? form.signer_ids.filter((x) => x !== id) : [...form.signer_ids, id]);
  const funding = form.kind === "funding";
  const valid = form.subject.trim() && form.signer_ids.length > 0 && (funding ? Number(form.amount) > 0 && form.from_account_id && form.to_account_id && form.from_account_id !== form.to_account_id : form.category && form.items.some((i) => i.description.trim() && Number(i.qty) > 0));

  return (
    <section className="card space-y-3" aria-label="ฟอร์ม Memo">
      <h2 className="text-lg font-bold text-slate-800">{form.id ? "แก้ไข Memo" : funding ? "ขอเบิกเงิน — โอนระหว่างบัญชี" : "เขียน Memo ขอซื้อ"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm"><span className="label">สาขา</span><select className="input w-full min-h-[44px]" value={form.branch_id} onChange={(e) => onChange({ ...form, branch_id: Number(e.target.value), vendor_id: null })} disabled={!!form.id}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        {funding && <>
          <label className="block text-sm"><span className="label">โอนจากบัญชี</span><select className="input w-full min-h-[44px]" value={form.from_account_id ?? ""} onChange={(e) => set("from_account_id", e.target.value ? Number(e.target.value) : null)}><option value="">เลือกบัญชี</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` · ${a.last4}` : ""}</option>)}</select></label>
          <label className="block text-sm"><span className="label">ไปยังบัญชี</span><select className="input w-full min-h-[44px]" value={form.to_account_id ?? ""} onChange={(e) => set("to_account_id", e.target.value ? Number(e.target.value) : null)}><option value="">เลือกบัญชี</option>{data.accounts.filter((a) => a.id !== form.from_account_id).map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` · ${a.last4}` : ""}</option>)}</select></label>
          <label className="block text-sm"><span className="label">จำนวนเงินที่ขอ (บาท)</span><input className="input w-full min-h-[44px] text-right" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d.]/g, ""))} /></label>
          <label className="block text-sm"><span className="label">สำหรับสัปดาห์ที่เริ่มวันที่</span><input type="date" className="input w-full min-h-[44px]" value={form.week_start} onChange={(e) => set("week_start", e.target.value)} /></label>
        </>}
        {!funding && <label className="block text-sm"><span className="label">จ่ายจากบัญชี</span><select className="input w-full min-h-[44px]" value={form.pay_account_id ?? ""} onChange={(e) => set("pay_account_id", e.target.value ? Number(e.target.value) : null)}><option value="">ยังไม่ระบุ</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` · ${a.last4}` : ""}</option>)}</select></label>}
        {!funding && <label className="block text-sm"><span className="label">หมวดค่าใช้จ่าย</span><select className="input w-full min-h-[44px]" value={form.category} onChange={(e) => set("category", e.target.value)}><option value="">เลือกหมวด</option>{data.categories.map((c) => <option key={c.name} value={c.name}>{c.name}{c.kind === "capex" ? " (CAPEX)" : ""}</option>)}</select></label>}
        <label className="block text-sm sm:col-span-2"><span className="label">เรื่อง</span><input className="input w-full min-h-[44px]" maxLength={200} value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="เช่น ขอซื้อเครื่องปรับอากาศ ห้องคลินิก" /></label>
        <label className="block text-sm sm:col-span-2"><span className="label">เหตุผล / รายละเอียด</span><textarea className="input w-full" rows={3} maxLength={4000} value={form.body} onChange={(e) => set("body", e.target.value)} /></label>
        {!funding && <><label className="block text-sm"><span className="label">วันที่ต้องการของ</span><input type="date" className="input w-full min-h-[44px]" value={form.needed_date} onChange={(e) => set("needed_date", e.target.value)} /></label>
        <label className="block text-sm"><span className="label">ผู้จำหน่าย</span>
          <select className="input w-full min-h-[44px]" value={form.vendor_id ?? ""} onChange={(e) => onChange({ ...form, vendor_id: e.target.value ? Number(e.target.value) : null, vendor_name: "" })}><option value="">ไม่อยู่ในรายชื่อ (พิมพ์เอง)</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        {form.vendor_id == null && <label className="block text-sm sm:col-span-2"><span className="label">ชื่อผู้จำหน่าย</span><input className="input w-full min-h-[44px]" maxLength={200} value={form.vendor_name} onChange={(e) => set("vendor_name", e.target.value)} /></label>}</>}
      </div>

      {!funding && <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-800">รายการ</div>
        {form.items.map((it, i) => (
          <div key={i} className="grid gap-2 grid-cols-[1fr_5rem] sm:grid-cols-[1fr_6rem_6rem_8rem_auto] items-center rounded-xl border border-slate-200 p-2">
            <input className="input min-h-[44px] col-span-2 sm:col-span-1" placeholder="รายการ" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
            <input className="input min-h-[44px] text-right" inputMode="decimal" placeholder="จำนวน" aria-label="จำนวน" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value.replace(/[^\d.]/g, "") })} />
            <input className="input min-h-[44px]" placeholder="หน่วย" aria-label="หน่วย" value={it.unit} maxLength={20} onChange={(e) => setItem(i, { unit: e.target.value })} />
            <input className="input min-h-[44px] text-right" inputMode="decimal" placeholder="ราคา/หน่วย" aria-label="ราคาต่อหน่วย" value={it.unit_price} onChange={(e) => setItem(i, { unit_price: e.target.value.replace(/[^\d.]/g, "") })} />
            <button type="button" className="min-h-[44px] px-3 text-rose-600 text-sm disabled:opacity-30" disabled={form.items.length === 1} onClick={() => set("items", form.items.filter((_, n) => n !== i))} aria-label="ลบรายการ">ลบ</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => set("items", [...form.items, { description: "", qty: "1", unit: "", unit_price: "" }])}>+ เพิ่มรายการ</button>
          <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" checked={form.vat_rate === 7} onChange={(e) => set("vat_rate", e.target.checked ? 7 : 0)} />ภาษีมูลค่าเพิ่ม 7%</label>
          <div className="ml-auto text-sm tabular-nums">รวม <b>฿{baht(subtotal + vat)}</b>{form.vat_rate ? <span className="text-slate-500"> (VAT {baht(vat)})</span> : null}</div>
        </div>
      </div>}

      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-800">ผู้ที่ต้องลงนาม (เลือกได้หลายคน — ลงนามครบทุกคนจึงอนุมัติ Memo)</div>
        {funding && <p className="text-xs text-violet-800">การเบิกเงินต้องเลือกผู้ลงนามให้ครบตามอำนาจอนุมัติของบัญชีต้นทางและยอดนี้ — ผู้บริหารมีป้ายกำกับ</p>}
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.signers.map((s) => (
            <li key={s.id}><label className={`flex items-center gap-3 rounded-xl border px-3 py-2 min-h-[48px] cursor-pointer ${form.signer_ids.includes(s.id) ? "border-brand bg-brand/5" : "border-slate-200"}`}>
              <input type="checkbox" checked={form.signer_ids.includes(s.id)} onChange={() => toggle(s.id)} />
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium break-words">{s.name}</span><span className="block text-[11px] text-slate-500">{data.topExecIds.includes(s.id) ? "ผู้บริหารสูงสุด" : s.cLevel ? "ผู้บริหาร" : s.role === "super_admin" ? "เจ้าของระบบ" : "แอดมิน"}{s.hasSignature ? "" : " · ยังไม่ตั้งลายเซ็น"}</span></span>
            </label></li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy || !form.subject.trim() || (!funding && !form.category)} onClick={() => onSave(form, false)}>บันทึกร่าง</button>
        <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || !valid} onClick={() => onSave(form, true)}>บันทึกและส่งขอลงนาม</button>
      </div>
    </section>
  );
}
