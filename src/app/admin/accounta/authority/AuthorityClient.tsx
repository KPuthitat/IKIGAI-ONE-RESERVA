"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url";

type Rule = "one_exec" | "two_execs_or_top" | "top_only";
type TierRow = { upTo: string; rule: Rule };
type Tier = { id: number | null; accountId: number | null; upTo: number | null; rule: Rule };
type Person = { id: number; name: string; role: string; cLevel: boolean; top: boolean };
type Account = { id: number; name: string; last4: string | null; purpose: string | null; ownTiers: Tier[]; approverIds: number[]; effective: Tier[] };
type Snap = { accounts: Account[]; globalTiers: Tier[]; defaultTiers: Tier[]; people: Person[]; executiveIds: number[]; ruleText: Record<Rule, string> };
const PURPOSE_TH: Record<string, string> = { savings: "บัญชีออม", working: "เงินหมุนเวียน", payroll_tax: "Payroll + ภาษี", procurement: "จัดซื้อ", other: "อื่นๆ" };
const baht = (n: number) => n.toLocaleString("th-TH");

async function call(method: string, body?: unknown): Promise<{ ok: boolean; j: Record<string, unknown> }> {
  try { const r = await fetch(apiUrl("/api/admin/accounta/authority"), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); return { ok: r.ok && j.ok !== false, j }; }
  catch { return { ok: false, j: { message: "เชื่อมต่อไม่สำเร็จ" } }; }
}

export default function AuthorityClient() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => { const r = await call("GET"); if (r.ok) setSnap(r.j as unknown as Snap); else setMsg({ ok: false, text: (r.j.message as string) ?? "โหลดไม่สำเร็จ" }); }, []);
  useEffect(() => { load(); }, [load]);
  async function act(body: Record<string, unknown>, okText: string) { setMsg(null); const r = await call("POST", body); setMsg({ ok: r.ok, text: r.ok ? okText : (r.j.message as string) ?? "ไม่สำเร็จ" }); if (r.ok) await load(); return r.ok; }
  if (!snap) return <div className="card text-sm text-slate-500">กำลังโหลด…</div>;
  const execs = snap.people.filter((p) => p.cLevel || p.role === "super_admin" || p.top);

  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      <section className="card space-y-2" aria-label="ผู้บริหารสูงสุด">
        <h2 className="font-bold text-slate-800">ผู้บริหารสูงสุด</h2>
        <p className="text-xs text-slate-500">ผู้ที่ติ๊กไว้ อนุมัติแทน “ผู้บริหาร 2 คน” ได้คนเดียว และเป็นผู้เดียวที่อนุมัติขั้น “ผู้บริหารสูงสุดเท่านั้น” ได้ ถ้ายังไม่มีใครถูกติ๊ก เจ้าของระบบ (super admin) ทำหน้าที่แทนชั่วคราว</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {execs.map((p) => (
            <li key={p.id}><label className={`flex items-center gap-3 rounded-xl border px-3 py-2 min-h-[48px] cursor-pointer ${p.top ? "border-brand bg-brand/5" : "border-slate-200"}`}>
              <input type="checkbox" className="h-5 w-5" checked={p.top} onChange={(e) => act({ action: "set_top", userId: p.id, value: e.target.checked }, e.target.checked ? `ตั้ง ${p.name} เป็นผู้บริหารสูงสุดแล้ว` : `เอา ${p.name} ออกจากผู้บริหารสูงสุดแล้ว`)} />
              <span className="min-w-0"><span className="block text-sm font-medium break-words">{p.name}</span><span className="block text-[11px] text-slate-500">{p.role === "super_admin" ? "เจ้าของระบบ" : p.cLevel ? "ผู้บริหาร" : "แอดมิน"}</span></span>
            </label></li>
          ))}
        </ul>
        {execs.length === 0 && <p className="text-sm text-slate-500">ยังไม่มีผู้บริหาร — ตั้งป้ายผู้บริหารที่หน้าพนักงานก่อน</p>}
      </section>

      <TierSection title="ค่าเริ่มต้นทั้งบริษัท" hint="ใช้กับ PR ที่ไม่ระบุบัญชี หรือบัญชีที่ไม่ได้ตั้งขั้นเอง" tiers={snap.globalTiers} fallback={snap.defaultTiers} ruleText={snap.ruleText} onSave={(t) => act({ action: "set_tiers", accountId: null, tiers: t }, "บันทึกค่าเริ่มต้นแล้ว")} />

      {snap.accounts.map((a) => (
        <section key={a.id} className="space-y-3">
          <TierSection title={`${a.name}${a.last4 ? ` · ${a.last4}` : ""}${a.purpose ? ` · ${PURPOSE_TH[a.purpose]}` : ""}`} hint="ขั้นของบัญชีนี้โดยเฉพาะ (ว่าง = ใช้ค่าเริ่มต้นทั้งบริษัท)" tiers={a.ownTiers} fallback={a.effective} ruleText={snap.ruleText} onSave={(t) => act({ action: "set_tiers", accountId: a.id, tiers: t }, `บันทึกขั้นอนุมัติของ ${a.name} แล้ว`)} />
          <ApproverBox account={a} execs={execs} onSave={(ids) => act({ action: "set_approvers", accountId: a.id, userIds: ids }, `บันทึกผู้อนุมัติประจำ ${a.name} แล้ว`)} />
        </section>
      ))}
      {snap.accounts.length === 0 && <div className="card text-sm text-slate-600">ยังไม่มีบัญชีธนาคารในระบบ — เพิ่มที่ <a className="text-brand underline" href={apiUrl("/admin/accounta/cash-accounts")}>ช่องทางการเงิน / บัญชี</a> (ประเภทธนาคาร) ก่อน</div>}
    </div>
  );
}

function TierSection({ title, hint, tiers, fallback, ruleText, onSave }: { title: string; hint: string; tiers: Tier[]; fallback: Tier[]; ruleText: Record<Rule, string>; onSave: (t: Array<{ upTo: number | null; rule: Rule }>) => Promise<boolean> }) {
  const init = (): TierRow[] => tiers.map((t) => ({ upTo: t.upTo == null ? "" : String(t.upTo), rule: t.rule }));
  const [rows, setRows] = useState<TierRow[]>(init);
  useEffect(() => setRows(init()), [JSON.stringify(tiers)]);   // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, p: Partial<TierRow>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const last = rows.length - 1;
  const parsed = rows.map((r, i) => ({ upTo: i === last ? null : Number(r.upTo.replace(/,/g, "")), rule: r.rule }));
  const valid = rows.length === 0 || parsed.every((r, i) => (i === last ? true : r.upTo != null && r.upTo > 0 && Number.isFinite(r.upTo) && (i === 0 || r.upTo > (parsed[i - 1].upTo as number))));
  const shown = rows.length ? null : fallback;
  return (
    <div className="card space-y-3">
      <div><h2 className="font-bold text-slate-800 break-words">{title}</h2><p className="text-xs text-slate-500">{hint}</p></div>
      {shown && <ul className="text-sm text-slate-600 space-y-0.5">{shown.map((t, i) => <li key={i}>{t.upTo == null ? (shown.length > 1 ? "ยอดที่เกินนั้น" : "ทุกยอด") : `ยอดไม่เกิน ฿${baht(t.upTo)}`}: <b>{ruleText[t.rule]}</b> <span className="text-xs text-slate-400">(ค่าที่ใช้อยู่)</span></li>)}</ul>}
      {rows.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] items-center rounded-xl border border-slate-200 p-2">
          {i === last ? <div className="text-sm text-slate-700 px-2">{rows.length > 1 ? "ยอดที่เกินขั้นก่อนหน้า" : "ทุกยอด"}</div>
            : <label className="flex items-center gap-2 text-sm"><span className="text-slate-600 whitespace-nowrap">ยอดไม่เกิน ฿</span><input className="input min-h-[44px] w-full text-right" inputMode="decimal" value={r.upTo} onChange={(e) => set(i, { upTo: e.target.value.replace(/[^\d.,]/g, "") })} aria-label="ยอดสูงสุดของขั้น" /></label>}
          <select className="input min-h-[44px]" value={r.rule} onChange={(e) => set(i, { rule: e.target.value as Rule })}>{(Object.keys(ruleText) as Rule[]).map((k) => <option key={k} value={k}>{ruleText[k]}</option>)}</select>
          <button type="button" className="min-h-[44px] px-3 text-sm text-rose-600" onClick={() => setRows(rows.filter((_, k) => k !== i))}>ลบขั้น</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" disabled={rows.length >= 8} onClick={() => setRows(rows.length === 0 ? [{ upTo: "", rule: "two_execs_or_top" }] : [...rows.slice(0, -1), { upTo: "", rule: rows[last].rule }, { upTo: "", rule: rows[last].rule }].map((x, i, a) => ({ ...x, upTo: i === a.length - 1 ? "" : x.upTo })))}>+ เพิ่มขั้น</button>
        <button type="button" className="btn-primary min-h-[44px] px-5 text-sm" disabled={!valid} onClick={() => onSave(parsed)}>{rows.length === 0 ? "ใช้ค่าเริ่มต้น (ล้างขั้นที่ตั้งเอง)" : "บันทึก"}</button>
      </div>
      {!valid && <p className="text-xs text-rose-700">ยอดของแต่ละขั้นต้องเป็นตัวเลขและเพิ่มขึ้นตามลำดับ (ขั้นสุดท้ายไม่ต้องใส่ยอด)</p>}
    </div>
  );
}

function ApproverBox({ account, execs, onSave }: { account: Account; execs: Person[]; onSave: (ids: number[]) => Promise<boolean> }) {
  const [ids, setIds] = useState<number[]>(account.approverIds);
  useEffect(() => setIds(account.approverIds), [account.approverIds.join()]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: number) => setIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div className="card space-y-2">
      <h3 className="font-semibold text-slate-800 text-sm">ผู้อนุมัติประจำบัญชี {account.name}</h3>
      <p className="text-xs text-slate-500">ใช้กับขั้นที่เป็น “ผู้บริหาร 1 คน”: ถ้าเลือกไว้ เฉพาะคนเหล่านี้อนุมัติได้ (เช่น ผู้บริหารฝั่งจัดซื้อ KBANK) ถ้าไม่เลือก ผู้บริหารคนใดก็ได้</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {execs.map((p) => <li key={p.id}><label className={`flex items-center gap-3 rounded-xl border px-3 py-2 min-h-[44px] cursor-pointer ${ids.includes(p.id) ? "border-brand bg-brand/5" : "border-slate-200"}`}><input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} /><span className="text-sm break-words">{p.name}</span></label></li>)}
      </ul>
      <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => onSave(ids)}>บันทึกผู้อนุมัติประจำบัญชี</button>
    </div>
  );
}
