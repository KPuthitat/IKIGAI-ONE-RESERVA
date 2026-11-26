"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/url";
import type { BankAccount, Candidate, ReconSummary } from "@/lib/bank-recon";

type Overview = { accounts: BankAccount[]; periods: Array<{ accountId: number; period: string; total: number; unmatched: number; closed: boolean }>; isOwner: boolean };
type Preview = { headers: string[]; columns: Record<string, number | null> | null; lines: Array<{ row: number; date: string; description: string; debit: number; credit: number; balance: number | null }>; lineTotal: number; totalDebit: number; totalCredit: number;
  opening: number | null; closing: number | null; chainBreaks: number; firstDate: string | null; lastDate: string | null; order: string; problems: string[]; hasBalance: boolean };

const PURPOSE_TH: Record<string, string> = { savings: "บัญชีออม", working: "เงินหมุนเวียน", payroll_tax: "Payroll + ภาษี", procurement: "จัดซื้อ", other: "อื่นๆ" };
const REASONS = ["ค่าธรรมเนียมธนาคาร", "ดอกเบี้ยรับ", "โอนเข้า/ออกบัญชีออม (ตัดออมรายเดือน)", "จ่ายเงินเดือน (Payroll)", "ชำระภาษี", "ยอดยกมา", "อื่นๆ (ระบุเอง)"];
const baht = (n: number | null) => (n == null ? "—" : n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const thDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d}/${m}/${y + 543}`; };
const monthTh = (p: string) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("th-TH", { month: "long", year: "numeric", timeZone: "UTC" }); };
const FIELDS: Array<[keyof NonNullable<Preview["columns"]>, string]> = [["date", "วันที่"], ["desc", "รายละเอียด"], ["debit", "ถอน/จ่าย"], ["credit", "ฝาก/รับ"], ["amount", "จำนวนเงิน (ช่องเดียว)"], ["type", "ประเภท (Dr/Cr)"], ["balance", "ยอดคงเหลือ"]];

async function api(method: string, path: string, body?: unknown, form?: FormData): Promise<{ ok: boolean; j: Record<string, unknown> }> {
  try {
    const r = await fetch(apiUrl(path), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: form ?? (body ? JSON.stringify(body) : undefined) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, j };
  } catch { return { ok: false, j: { message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" } }; }
}

export default function ReconcileClient() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [account, setAccount] = useState<number | null>(null);
  const [period, setPeriod] = useState<string>("");
  const [sum, setSum] = useState<ReconSummary | null>(null);
  const [filter, setFilter] = useState<"all" | "unmatched" | "matched" | "ignored">("unmatched");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const loadOv = useCallback(async () => {
    const r = await api("GET", "/api/admin/accounta/reconcile");
    if (!r.ok) { setMsg({ ok: false, text: (r.j.message as string) ?? "โหลดไม่สำเร็จ" }); return null; }
    const o = r.j as unknown as Overview; setOv(o); return o;
  }, []);
  const loadSum = useCallback(async (a: number, p: string) => {
    const r = await api("GET", `/api/admin/accounta/reconcile?account=${a}&period=${p}`);
    if (r.ok) setSum(r.j.summary as ReconSummary);
  }, []);
  useEffect(() => { loadOv().then((o) => { if (!o) return; const a = o.periods[0]?.accountId ?? o.accounts[0]?.id ?? null; setAccount(a); const per = o.periods.find((x) => x.accountId === a)?.period ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7); setPeriod(per); setShowImport(o.periods.length === 0); }); }, [loadOv]);
  useEffect(() => { if (account && period) loadSum(account, period); else setSum(null); }, [account, period, loadSum]);

  const refresh = async () => { await loadOv(); if (account && period) await loadSum(account, period); };
  async function act(body: Record<string, unknown>, okText: string) {
    setBusy(true); setMsg(null);
    const r = await api("POST", "/api/admin/accounta/reconcile", body);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? okText : (r.j.message as string) ?? "ไม่สำเร็จ" });
    if (r.ok) await refresh();
    return r.ok;
  }

  if (!ov) return <div className="card text-sm text-slate-500">กำลังโหลด…</div>;
  if (ov.accounts.length === 0) return <div className="card text-sm text-slate-700">ยังไม่มีบัญชีธนาคารในระบบ — เพิ่มที่ <a className="text-brand underline" href={apiUrl("/admin/accounta/cash-accounts")}>ช่องทางการเงิน / บัญชี</a> (ประเภทธนาคาร) ก่อน</div>;
  const myPeriods = ov.periods.filter((p) => p.accountId === account);
  const lines = (sum?.lines ?? []).filter((l) => filter === "all" || l.status === filter);

  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      <section className="card space-y-3" aria-label="เลือกบัญชีและเดือน">
        <div className="flex flex-wrap gap-2">
          {ov.accounts.map((a) => (
            <button key={a.id} type="button" onClick={() => { setAccount(a.id); setPeriod(ov.periods.find((p) => p.accountId === a.id)?.period ?? period); }} className={`chip ${account === a.id ? "chip-active" : ""}`}>
              {a.name}{a.accountLast4 ? ` · ${a.accountLast4}` : ""}{a.purpose ? ` · ${PURPOSE_TH[a.purpose]}` : ""}
            </button>
          ))}
        </div>
        {account && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2"><span className="text-slate-600">หน้าที่บัญชี</span>
              <select className="input min-h-[44px]" value={ov.accounts.find((a) => a.id === account)?.purpose ?? ""} onChange={(e) => act({ action: "set_purpose", account, purpose: e.target.value || null }, "บันทึกหน้าที่บัญชีแล้ว")}>
                <option value="">ไม่ระบุ</option>{Object.entries(PURPOSE_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="flex items-center gap-2"><span className="text-slate-600">เดือน</span>
              <select className="input min-h-[44px]" value={period} onChange={(e) => setPeriod(e.target.value)}>
                {!myPeriods.some((p) => p.period === period) && period && <option value={period}>{monthTh(period)}</option>}
                {myPeriods.map((p) => <option key={p.period} value={p.period}>{monthTh(p.period)} · {p.closed ? "ปิดงวดแล้ว" : p.unmatched ? `ค้าง ${p.unmatched}` : "ครบ"}</option>)}</select></label>
            <div className="flex-1" />
            <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => setShowImport(!showImport)}>{showImport ? "ซ่อนการนำเข้า" : "นำเข้า statement"}</button>
          </div>
        )}
      </section>

      {showImport && account && <ImportPanel accounts={ov.accounts} account={account} onDone={async (t) => { setMsg({ ok: true, text: t }); setShowImport(false); const o = await loadOv(); if (o) { const per = o.periods.find((p) => p.accountId === account)?.period; if (per) setPeriod(per); } if (account && period) await loadSum(account, period); }} onError={(t) => setMsg({ ok: false, text: t })} />}

      {sum && sum.counts.total === 0 && <div className="card text-sm text-slate-600 text-center py-8">ยังไม่มีรายการของเดือน {monthTh(period)} ในบัญชีนี้ — นำเข้า statement ก่อน</div>}

      {sum && sum.counts.total > 0 && (
        <>
          <section className="card space-y-3" aria-label="สรุปเดือน">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold text-slate-800">{monthTh(sum.period)}</h2>
              {sum.closed ? <span className="rounded-full bg-emerald-100 text-emerald-800 px-3 py-0.5 text-sm">ปิดงวดแล้ว{sum.closedByName ? ` โดย ${sum.closedByName}` : ""}</span>
                : sum.counts.unmatched === 0 ? <span className="rounded-full bg-sky-100 text-sky-800 px-3 py-0.5 text-sm">พร้อมปิดงวด</span> : <span className="rounded-full bg-amber-100 text-amber-800 px-3 py-0.5 text-sm">ค้าง {sum.counts.unmatched} รายการ</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-center">
              {[["ยอดต้นเดือน", baht(sum.opening)], ["รวมเงินเข้า", baht(sum.totalCredit)], ["รวมเงินออก", baht(sum.totalDebit)], ["ยอดปลายเดือน (statement)", baht(sum.closing)]].map(([l, v]) => (
                <div key={l} className="rounded-xl border border-slate-200 py-2"><div className="text-[11px] text-slate-500">{l}</div><div className="font-bold tabular-nums text-slate-900">{v}</div></div>
              ))}
            </div>
            {sum.balanceOk === true && sum.chainBreaks === 0 && <div className="text-sm text-emerald-700">✓ ยอดต้น + เงินเข้า − เงินออก = ยอดปลาย และยอดคงเหลือต่อเนื่องทุกรายการ (ไม่มีรายการขาด)</div>}
            {(sum.balanceOk === false || sum.chainBreaks > 0) && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">⚠ ยอดไม่ต่อเนื่อง {sum.chainBreaks} จุด{sum.balanceOk === false ? ` · ยอดที่คำนวณได้ ${baht(sum.computedClosing)} ไม่ตรงกับ statement ${baht(sum.closing)}` : ""} — อาจมีรายการขาดจากไฟล์ ตรวจไฟล์ หรือนำเข้าไฟล์เพิ่ม</div>}
            {sum.balanceOk == null && <div className="text-sm text-slate-500">ไฟล์ไม่มีคอลัมน์ยอดคงเหลือ จึงตรวจความต่อเนื่องของยอดไม่ได้</div>}
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-slate-100 px-3 py-1">ทั้งหมด {sum.counts.total}</span><span className="rounded-full bg-emerald-50 text-emerald-800 px-3 py-1">จับคู่แล้ว {sum.counts.matched}</span>
              <span className="rounded-full bg-sky-50 text-sky-800 px-3 py-1">อธิบายแล้ว {sum.counts.ignored}</span><span className="rounded-full bg-amber-50 text-amber-800 px-3 py-1">ค้าง {sum.counts.unmatched}</span>
            </div>
            {!sum.closed ? (
              <CloseBox sum={sum} busy={busy} onAuto={() => act({ action: "auto_match", account }, "จับคู่อัตโนมัติใหม่แล้ว")} onClose={(note) => act({ action: "close", account, period, note }, "ปิดงวดเรียบร้อย")} />
            ) : ov.isOwner && <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => { if (window.confirm("เปิดงวดที่ปิดแล้วเพื่อแก้ไข?")) act({ action: "reopen", account, period }, "เปิดงวดแล้ว"); }}>เปิดงวดเพื่อแก้ไข (เจ้าของระบบ)</button>}
          </section>

          <section className="card space-y-3" aria-label="รายการธนาคาร">
            <div className="flex flex-wrap gap-2">
              {([["unmatched", `ค้าง (${sum.counts.unmatched})`], ["matched", `จับคู่แล้ว (${sum.counts.matched})`], ["ignored", `อธิบายแล้ว (${sum.counts.ignored})`], ["all", `ทั้งหมด (${sum.counts.total})`]] as const).map(([k, th]) =>
                <button key={k} type="button" className={`chip ${filter === k ? "chip-active" : ""}`} onClick={() => setFilter(k)}>{th}</button>)}
            </div>
            {lines.length === 0 && <p className="text-sm text-slate-500 text-center py-4">ไม่มีรายการในตัวกรองนี้</p>}
            <ul className="divide-y divide-slate-100">
              {lines.map((l) => <LineRow key={l.id} l={l} closed={sum.closed} busy={busy} act={act} />)}
            </ul>
          </section>

          {sum.missingInBank.length > 0 && (
            <section className="card space-y-2" aria-label="บิลที่จ่ายแล้วแต่ไม่พบในธนาคาร">
              <h3 className="font-semibold text-slate-800 text-sm">บิลที่บันทึกว่าจ่ายด้วยการโอน แต่ยังไม่พบรายการในธนาคาร ({sum.missingInBank.length})</h3>
              <p className="text-xs text-slate-500">ดูจากทุกบัญชี — ถ้ายังไม่ได้นำเข้า statement ของบัญชีที่จ่าย รายการจะอยู่ที่นี่ หรืออาจบันทึกยอด/วันที่ผิดใน ACCOUNTA</p>
              <ul className="text-sm divide-y divide-slate-100">{sum.missingInBank.map((e) => <li key={e.id} className="py-1.5 flex justify-between gap-3"><span className="min-w-0 break-words">{thDate(e.date)} · {e.label}</span><b className="tabular-nums shrink-0">{baht(e.amount)}</b></li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function CloseBox({ sum, busy, onAuto, onClose }: { sum: ReconSummary; busy: boolean; onAuto: () => void; onClose: (note: string) => void }) {
  const [note, setNote] = useState("");
  const needNote = sum.chainBreaks > 0 || sum.balanceOk === false;
  return (
    <div className="space-y-2">
      {needNote && <textarea className="input w-full" rows={2} maxLength={500} placeholder="ยอดไม่ต่อเนื่อง — ระบุเหตุผลที่ปิดงวดได้ (จำเป็น)" value={note} onChange={(e) => setNote(e.target.value)} />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy} onClick={onAuto}>จับคู่อัตโนมัติอีกครั้ง</button>
        <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || sum.counts.unmatched > 0 || (needNote && !note.trim())} onClick={() => { if (window.confirm(`ปิดงวด ${sum.period}? หลังปิดจะแก้รายการของเดือนนี้ไม่ได้`)) onClose(note); }}>ปิดงวดเดือนนี้</button>
        <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={() => window.print()}>พิมพ์รายงาน</button>
      </div>
      {sum.counts.unmatched > 0 && <p className="text-xs text-slate-500">ต้องจับคู่หรืออธิบายรายการที่ค้างให้ครบก่อนจึงปิดงวดได้</p>}
    </div>
  );
}

function LineRow({ l, closed, busy, act }: { l: ReconSummary["lines"][number]; closed: boolean; busy: boolean; act: (b: Record<string, unknown>, t: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [custom, setCustom] = useState("");
  const loaded = useRef(false);
  async function toggle() {
    setOpen(!open);
    if (!open && !loaded.current) { loaded.current = true; const r = await api("GET", `/api/admin/accounta/reconcile?candidates=${l.id}`); if (r.ok) setCands(r.j.candidates as Candidate[]); }
  }
  const out = l.debit > 0;
  const tone = l.status === "matched" ? "bg-emerald-100 text-emerald-800" : l.status === "ignored" ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-800";
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-500">{thDate(l.date)}</div>
          <div className="text-sm font-medium text-slate-900 break-words">{l.description || "(ไม่มีรายละเอียด)"}</div>
          {l.status !== "unmatched" && <div className="text-xs text-slate-600 break-words">{l.status === "ignored" ? `อธิบาย: ${l.reason}` : `${l.matchLabel ?? ""}${l.auto ? " · อัตโนมัติ" : ""}`}</div>}
        </div>
        <div className="text-right shrink-0">
          <div className={`font-bold tabular-nums ${out ? "text-rose-700" : "text-emerald-700"}`}>{out ? "−" : "+"}{baht(out ? l.debit : l.credit)}</div>
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${tone}`}>{l.status === "matched" ? "จับคู่แล้ว" : l.status === "ignored" ? "อธิบายแล้ว" : "ค้าง"}</span>
        </div>
      </div>
      {!closed && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {l.status === "unmatched" ? <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={toggle}>{open ? "ซ่อน" : "จับคู่ / อธิบาย"}</button>
            : <button type="button" className="text-xs underline text-slate-500 min-h-[44px]" disabled={busy} onClick={() => act({ action: "unmatch", line: l.id }, "ยกเลิกการจับคู่แล้ว")}>ยกเลิกการจับคู่</button>}
        </div>
      )}
      {open && l.status === "unmatched" && !closed && (
        <div className="mt-2 rounded-xl border border-slate-200 p-3 space-y-3 bg-slate-50">
          <div>
            <div className="text-xs font-semibold text-slate-700 mb-1">จับคู่กับรายการในระบบ (ยอดเท่ากัน วันที่ห่างไม่เกิน 5 วัน)</div>
            {cands == null ? <div className="text-xs text-slate-500">กำลังค้นหา…</div> : cands.length === 0 ? <div className="text-xs text-slate-500">ไม่พบรายการที่ตรงกัน — ถ้าเป็นรายการที่ยังไม่ได้บันทึกใน ACCOUNTA ให้ไปบันทึกก่อน หรืออธิบายด้านล่าง</div> : (
              <ul className="space-y-1">{cands.map((c) => (
                <li key={`${c.kind}${c.ref}`} className="flex items-center gap-2"><span className="flex-1 min-w-0 text-sm break-words">{c.label} · {thDate(c.date)} · {baht(c.amount)}</span>
                  <button type="button" className="btn-primary min-h-[44px] px-3 text-sm" disabled={busy} onClick={() => act({ action: "match", line: l.id, kind: c.kind, ref: c.ref }, "จับคู่แล้ว")}>จับคู่</button></li>))}</ul>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-700">หรืออธิบายรายการนี้ (ไม่มีรายการในระบบให้จับคู่)</div>
            <select className="input w-full min-h-[44px]" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
            {reason.startsWith("อื่นๆ") && <input className="input w-full min-h-[44px]" maxLength={200} placeholder="ระบุเหตุผล" value={custom} onChange={(e) => setCustom(e.target.value)} />}
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" disabled={busy || (reason.startsWith("อื่นๆ") && !custom.trim())} onClick={() => act({ action: "explain", line: l.id, reason: reason.startsWith("อื่นๆ") ? custom.trim() : reason }, "บันทึกคำอธิบายแล้ว")}>บันทึกคำอธิบาย</button>
          </div>
        </div>
      )}
    </li>
  );
}

function ImportPanel({ accounts, account, onDone, onError }: { accounts: BankAccount[]; account: number; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [acc, setAcc] = useState(account);
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<string, number | null> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAcc(account), [account]);

  async function send(mode: "preview" | "import", mapping: Record<string, number | null> | null) {
    if (!file) return;
    setBusy(true);
    const f = new FormData(); f.set("file", file); f.set("account", String(acc)); f.set("mode", mode); if (mapping) f.set("mapping", JSON.stringify(mapping));
    const r = await api("POST", "/api/admin/accounta/reconcile", undefined, f);
    setBusy(false);
    if (!r.ok) { onError((r.j.message as string) ?? "ไม่สำเร็จ"); return; }
    if (mode === "preview") { const p = r.j.preview as Preview; setPv(p); setMap(p.columns); }
    else onDone(`นำเข้า ${r.j.inserted as number} รายการ (ซ้ำ ${r.j.duplicates as number}${(r.j.skippedClosed as number) ? ` · ข้ามเดือนที่ปิดแล้ว ${r.j.skippedClosed as number}` : ""}) · จับคู่อัตโนมัติ ${r.j.matched as number} รายการ${(r.j.chainBreaks as number) ? ` · ⚠ ยอดไม่ต่อเนื่อง ${r.j.chainBreaks as number} จุด` : ""}`);
  }
  return (
    <section className="card space-y-3" aria-label="นำเข้า statement">
      <h2 className="font-bold text-slate-800">นำเข้า statement จากธนาคาร</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm"><span className="label">บัญชี</span><select className="input w-full min-h-[44px]" value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.accountLast4 ? ` · ${a.accountLast4}` : ""}</option>)}</select></label>
        <label className="block text-sm"><span className="label">ไฟล์ (.csv / .xlsx)</span><input type="file" accept=".csv,.txt,.xlsx,.xls" className="input w-full" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPv(null); }} /></label>
      </div>
      <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={!file || busy} onClick={() => send("preview", null)}>{busy ? "กำลังอ่านไฟล์…" : "อ่านไฟล์และดูตัวอย่าง"}</button>
      <p className="text-xs text-slate-500">ขั้นนี้ยังไม่บันทึก ระบบอ่านคอลัมน์จากหัวตาราง (ไทย/อังกฤษ) และเช็กว่ายอดคงเหลือต่อเนื่อง ถ้าอ่านผิดให้เลือกคอลัมน์เอง</p>

      {pv && (
        <div className="space-y-3 border-t border-slate-200 pt-3">
          {pv.problems.length > 0 && <ul className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 list-disc pl-5">{pv.problems.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul>}
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="rounded-full bg-slate-100 px-3 py-1">{pv.lineTotal} รายการ</span><span className="rounded-full bg-slate-100 px-3 py-1">{pv.firstDate ? `${thDate(pv.firstDate)} – ${pv.lastDate ? thDate(pv.lastDate) : ""}` : "—"}</span>
            <span className="rounded-full bg-emerald-50 text-emerald-800 px-3 py-1">เข้า {baht(pv.totalCredit)}</span><span className="rounded-full bg-rose-50 text-rose-800 px-3 py-1">ออก {baht(pv.totalDebit)}</span>
            {pv.hasBalance && <span className={`rounded-full px-3 py-1 ${pv.chainBreaks ? "bg-rose-100 text-rose-800" : "bg-emerald-100 text-emerald-800"}`}>{pv.chainBreaks ? `ยอดไม่ต่อเนื่อง ${pv.chainBreaks} จุด` : "ยอดคงเหลือต่อเนื่อง ✓"}</span>}
          </div>
          <details className="text-sm" open={!pv.columns}><summary className="cursor-pointer min-h-[44px] flex items-center text-slate-700">คอลัมน์ที่อ่านได้ — แก้ได้ถ้าไม่ถูกต้อง</summary>
            <div className="grid gap-2 sm:grid-cols-2 mt-1">
              {FIELDS.map(([k, th]) => (
                <label key={k} className="flex items-center gap-2 text-sm"><span className="w-40 text-slate-600">{th}</span>
                  <select className="input flex-1 min-h-[44px]" value={map?.[k] ?? ""} onChange={(e) => setMap({ ...(map ?? { date: null }), [k]: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">— ไม่มี —</option>{pv.headers.map((h, i) => <option key={i} value={i}>{i + 1}. {h || "(ว่าง)"}</option>)}</select></label>
              ))}
            </div>
            <button type="button" className="btn-secondary min-h-[44px] px-4 mt-2 text-sm" disabled={!map || map.date == null || busy} onClick={() => send("preview", map)}>อ่านใหม่ด้วยคอลัมน์นี้</button>
          </details>
          {pv.lines.length > 0 && (
            <ul className="text-xs divide-y divide-slate-100 rounded-lg border border-slate-200">{pv.lines.map((l) => (
              <li key={l.row} className="px-3 py-1.5 flex justify-between gap-3"><span className="min-w-0 break-words">{thDate(l.date)} · {l.description}</span><span className={`tabular-nums shrink-0 ${l.debit ? "text-rose-700" : "text-emerald-700"}`}>{l.debit ? `−${baht(l.debit)}` : `+${baht(l.credit)}`}</span></li>))}
              {pv.lineTotal > pv.lines.length && <li className="px-3 py-1.5 text-slate-500">… และอีก {pv.lineTotal - pv.lines.length} รายการ</li>}</ul>
          )}
          <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || !pv.columns || pv.lineTotal === 0} onClick={() => send("import", map)}>{busy ? "กำลังนำเข้า…" : "ยืนยันนำเข้า"}</button>
        </div>
      )}
    </section>
  );
}
