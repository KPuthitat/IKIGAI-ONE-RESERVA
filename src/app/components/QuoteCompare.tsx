"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/url";
import { combinedScore } from "@/lib/quotes-score";
import type { Compare, ComparePerms, Quote } from "@/lib/quotes";

// Quotation comparison (owner 2026-11-27): rival quotes, each scored on price and on every other benefit (0–100 % sliders, with a reason),
// weighed against each other with a weight slider that re-ranks live; the team and the executives pick the winner.
type Vendor = { id: number; name: string };
type Draft = { id?: number; vendorName: string; vendorId: number | null; amount: string; quoteNo: string; validUntil: string; note: string; priceScore: number; priceReason: string; benefitScore: number; benefitReason: string };
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const blank = (): Draft => ({ vendorName: "", vendorId: null, amount: "", quoteNo: "", validUntil: "", note: "", priceScore: 50, priceReason: "", benefitScore: 50, benefitReason: "" });
const toDraft = (q: Quote): Draft => ({ id: q.id, vendorName: q.vendorName, vendorId: q.vendorId, amount: String(q.amount), quoteNo: q.quoteNo, validUntil: q.validUntil ?? "", note: q.note, priceScore: q.priceScore, priceReason: q.priceReason, benefitScore: q.benefitScore, benefitReason: q.benefitReason });

async function call(method: "GET" | "POST", qs: string, body?: unknown): Promise<{ ok: boolean; j: Record<string, unknown> }> {
  try {
    const r = await fetch(apiUrl(`/api/admin/quotes${qs}`), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, j };
  } catch { return { ok: false, j: { message: "เชื่อมต่อไม่สำเร็จ" } }; }
}

function Pct({ label, value, onChange, disabled }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="flex items-center justify-between"><span className="font-medium text-slate-700">{label}</span><b className="tabular-nums text-brand">{value}%</b></span>
      <input type="range" min={0} max={100} step={5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full h-11 accent-[var(--brand,#7c5cff)]" />
      <span className="flex justify-between text-[10px] text-slate-400 -mt-2"><span>0%</span><span>50%</span><span>100%</span></span>
    </label>
  );
}
function Bar({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center gap-2 text-xs"><span className="w-20 shrink-0 text-slate-500">{label}</span><div className="h-2 flex-1 rounded-full bg-slate-200 overflow-hidden"><div className="h-full nk-gradient" style={{ width: `${value}%` }} /></div><b className="w-10 text-right tabular-nums">{value}%</b></div>;
}

export default function QuoteCompare({ scope, refId, onChanged }: { scope: "memo" | "pr"; refId: number; onChanged?: () => void }) {
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [perms, setPerms] = useState<ComparePerms>({ edit: false, choose: false });
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [weight, setWeight] = useState(60);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [choosing, setChoosing] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const [sole, setSole] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((j: Record<string, unknown>) => {
    const c = j.compare as Compare; setCmp(c); setPerms(j.perms as ComparePerms); if (j.vendors) setVendors(j.vendors as Vendor[]);
    setWeight(c.weightPrice); setSole(c.soleReason);
  }, []);
  useEffect(() => { (async () => { const r = await call("GET", `?scope=${scope}&id=${refId}`); if (r.ok) apply(r.j); else setMsg({ ok: false, text: (r.j.message as string) ?? "โหลดใบเสนอราคาไม่สำเร็จ" }); })(); }, [scope, refId, apply]);

  async function post(body: Record<string, unknown>, okText?: string): Promise<boolean> {
    setBusy(true); setMsg(null);
    const r = await call("POST", "", { scope, id: refId, ...body });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: (r.j.message as string) ?? "ไม่สำเร็จ" }); return false; }
    apply(r.j); if (okText) setMsg({ ok: true, text: okText }); onChanged?.(); return true;
  }

  const ranked = useMemo(() => {
    if (!cmp) return [];
    const cheapest = Math.min(...cmp.quotes.filter((q) => q.amount > 0).map((q) => q.amount), Infinity);
    const rows = cmp.quotes.map((q) => ({ q, score: combinedScore(q.priceScore, q.benefitScore, weight), cheapest: q.amount > 0 && q.amount === cheapest }));
    return rows.sort((a, b) => b.score - a.score);
  }, [cmp, weight]);

  if (!cmp) return <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">{msg?.text ?? "กำลังโหลดใบเสนอราคา…"}</div>;
  const top = ranked[0]?.score;
  const chosen = cmp.quotes.find((q) => q.id === cmp.chosenQuoteId);

  return (
    <section className="rounded-xl border-2 border-slate-200 p-3 space-y-3" aria-label="เปรียบเทียบใบเสนอราคา">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold text-slate-800">เปรียบเทียบใบเสนอราคา</h3>
          <p className="text-xs text-slate-500">สินค้า/บริการที่ไม่ได้มีเพียงรายเดียวในตลาด ต้องมีคู่เทียบอย่างน้อย 2 ราย ให้คะแนนด้านราคาและด้านประโยชน์อื่น (%) พร้อมเหตุผล แล้วชั่งน้ำหนักเพื่อเลือก</p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${!cmp.required ? "bg-slate-100 text-slate-600" : cmp.ready.ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{!cmp.required ? "ปิดกฎเทียบราคาอยู่" : cmp.ready.ok ? "ครบถ้วน" : "ยังไม่ครบ"}</span>
      </div>
      {msg && <div role="status" className={`rounded-lg px-3 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      {/* sole source */}
      <div className="rounded-lg bg-slate-50 p-2.5 space-y-1.5">
        <label className={`flex items-start gap-2 text-sm min-h-[44px] ${perms.edit ? "cursor-pointer" : ""}`}>
          <input type="checkbox" className="mt-1 h-5 w-5" checked={cmp.soleSource} disabled={!perms.edit || busy} onChange={(e) => post({ action: "set_sole", on: e.target.checked, reason: sole }, e.target.checked ? "ระบุว่าเป็นรายเดียวในตลาดแล้ว" : undefined)} />
          <span><b>สินค้า/บริการนี้มีเพียงรายเดียวในตลาด</b> — ไม่ต้องเทียบ แต่ต้องระบุเหตุผล</span>
        </label>
        {cmp.soleSource && (perms.edit
          ? <div className="space-y-1.5"><textarea className="input w-full" rows={2} maxLength={600} value={sole} onChange={(e) => setSole(e.target.value)} placeholder="เช่น เป็นเครื่องเดียวที่ได้รับรอง อย. / อะไหล่แท้มีตัวแทนจำหน่ายรายเดียว" />
              <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" disabled={busy} onClick={() => post({ action: "set_sole", on: true, reason: sole }, "บันทึกเหตุผลแล้ว")}>บันทึกเหตุผล</button></div>
          : <p className="text-sm text-slate-700 whitespace-pre-line">เหตุผล: {cmp.soleReason}</p>)}
      </div>

      {!cmp.soleSource && (
        <>
          {cmp.quotes.length >= 2 && (
            <div className="rounded-lg bg-violet-50 border border-violet-200 p-2.5">
              <div className="text-sm font-semibold text-violet-900">ชั่งน้ำหนัก: ราคา {weight}% · ประโยชน์อื่น {100 - weight}%</div>
              <input type="range" min={0} max={100} step={5} value={weight} onChange={(e) => setWeight(Number(e.target.value))} aria-label="น้ำหนักด้านราคา" className="w-full h-11 accent-[var(--brand,#7c5cff)]" />
              <div className="flex justify-between text-[11px] text-violet-800 -mt-2"><span>← เน้นประโยชน์อื่น</span><span>เน้นราคา →</span></div>
              <p className="text-[11px] text-violet-800 mt-1">เลื่อนซ้าย-ขวาเพื่อดูว่าอันดับเปลี่ยนอย่างไร คะแนนรวม = ราคา × {weight}% + ประโยชน์อื่น × {100 - weight}%</p>
            </div>
          )}

          <ul className="space-y-2">
            {ranked.map(({ q, score, cheapest }, i) => (
              <li key={q.id} className={`rounded-xl border p-3 space-y-2 ${q.id === cmp.chosenQuoteId ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 break-words">{q.vendorName}</div>
                    <div className="text-xs text-slate-500">{[q.quoteNo && `เลขที่ ${q.quoteNo}`, q.validUntil && `ใช้ได้ถึง ${q.validUntil}`, q.createdByName && `บันทึกโดย ${q.createdByName}`].filter(Boolean).join(" · ")}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {q.id === cmp.chosenQuoteId && <span className="rounded bg-emerald-600 text-white text-[11px] px-1.5 py-0.5">เลือกแล้ว</span>}
                      {cmp.quotes.length >= 2 && i === 0 && score === top && <span className="rounded bg-brand text-white text-[11px] px-1.5 py-0.5">คะแนนรวมสูงสุด</span>}
                      {cheapest && cmp.quotes.length >= 2 && <span className="rounded bg-sky-100 text-sky-800 text-[11px] px-1.5 py-0.5">ราคาต่ำสุด</span>}
                    </div>
                  </div>
                  <div className="text-right"><div className="font-bold tabular-nums">฿{baht(q.amount)}</div><div className="text-xs text-slate-500">คะแนนรวม <b className="text-slate-900 text-base tabular-nums">{score}</b></div></div>
                </div>
                <Bar label="ด้านราคา" value={q.priceScore} />
                {q.priceReason && <p className="text-xs text-slate-600 pl-[5.5rem] whitespace-pre-line break-words">{q.priceReason}</p>}
                <Bar label="ประโยชน์อื่น" value={q.benefitScore} />
                {q.benefitReason && <p className="text-xs text-slate-600 pl-[5.5rem] whitespace-pre-line break-words">{q.benefitReason}</p>}
                {q.note && <p className="text-xs text-slate-500">หมายเหตุ: {q.note}</p>}
                {(perms.edit || perms.choose) && (
                  <div className="flex flex-wrap gap-2">
                    {perms.choose && q.id !== cmp.chosenQuoteId && <button type="button" className="btn-primary min-h-[44px] px-4 text-sm" disabled={busy} onClick={() => { setChoosing(q.id); setWhy(""); }}>เลือกเจ้านี้</button>}
                    {perms.edit && <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => setDraft(toDraft(q))}>แก้ไข / ให้คะแนน</button>}
                    {perms.edit && <button type="button" className="min-h-[44px] px-3 text-sm text-rose-600" disabled={busy} onClick={() => { if (window.confirm(`ลบใบเสนอราคาของ ${q.vendorName}?`)) post({ action: "delete_quote", quoteId: q.id }, "ลบแล้ว"); }}>ลบ</button>}
                  </div>
                )}
                {choosing === q.id && (
                  <div className="rounded-lg border border-brand/40 p-2 space-y-2">
                    <div className="text-sm">เลือก <b>{q.vendorName}</b> (คะแนนรวม {score} ที่น้ำหนักราคา {weight}%) — ระบุเหตุผลเปรียบเทียบด้านราคาและประโยชน์อื่น</div>
                    <textarea className="input w-full" rows={3} maxLength={600} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="เช่น แพงกว่า 7% แต่รับประกัน 3 ปีและซ่อมถึงที่ คุ้มกว่าในระยะยาว" />
                    <div className="flex gap-2"><button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => setChoosing(null)}>ยกเลิก</button>
                      <button type="button" className="btn-primary min-h-[44px] px-4 text-sm" disabled={busy || !why.trim()} onClick={async () => { if (await post({ action: "choose", quoteId: q.id, weightPrice: weight, reason: why }, `เลือก ${q.vendorName} แล้ว`)) setChoosing(null); }}>ยืนยันเลือก</button></div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {cmp.quotes.length === 0 && <p className="text-sm text-slate-500 text-center py-3">ยังไม่มีใบเสนอราคา</p>}
          {chosen && <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-sm text-emerald-900"><b>เลือก {chosen.vendorName}</b> (น้ำหนักราคา {cmp.weightPrice}% / ประโยชน์อื่น {100 - cmp.weightPrice}%){cmp.chosenByName ? ` โดย ${cmp.chosenByName}` : ""}<div className="whitespace-pre-line">เหตุผล: {cmp.chosenReason}</div></div>}

          {perms.edit && !draft && cmp.quotes.length < 8 && <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => setDraft(blank())}>+ เพิ่มใบเสนอราคา</button>}
          {draft && (
            <div className="rounded-xl border-2 border-brand/30 p-3 space-y-3">
              <h4 className="font-semibold text-slate-800">{draft.id ? "แก้ไขใบเสนอราคา" : "เพิ่มใบเสนอราคา"}</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm sm:col-span-2"><span className="label">ผู้เสนอราคา (ชื่อบริษัท/ร้าน)</span>
                  <input className="input w-full min-h-[44px]" list="quote-vendors" maxLength={200} value={draft.vendorName} onChange={(e) => { const v = vendors.find((x) => x.name === e.target.value); setDraft({ ...draft, vendorName: e.target.value, vendorId: v?.id ?? null }); }} />
                  <datalist id="quote-vendors">{vendors.map((v) => <option key={v.id} value={v.name} />)}</datalist></label>
                <label className="block text-sm"><span className="label">ยอดที่เสนอ (บาท รวมภาษี)</span><input className="input w-full min-h-[44px] text-right" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(/[^\d.]/g, "") })} /></label>
                <label className="block text-sm"><span className="label">เลขที่ใบเสนอราคา</span><input className="input w-full min-h-[44px]" maxLength={60} value={draft.quoteNo} onChange={(e) => setDraft({ ...draft, quoteNo: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">ใช้ได้ถึงวันที่</span><input type="date" className="input w-full min-h-[44px]" value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} /></label>
                <label className="block text-sm"><span className="label">หมายเหตุ (เงื่อนไข/เครดิต/ค่าส่ง)</span><input className="input w-full min-h-[44px]" maxLength={600} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
              </div>
              <div className="space-y-2 rounded-lg bg-slate-50 p-2.5">
                <Pct label="คะแนนด้านราคา (ยิ่งคุ้มราคายิ่งสูง)" value={draft.priceScore} onChange={(n) => setDraft({ ...draft, priceScore: n })} />
                <textarea className="input w-full" rows={2} maxLength={600} value={draft.priceReason} onChange={(e) => setDraft({ ...draft, priceReason: e.target.value })} placeholder="เหตุผลด้านราคา เช่น ถูกกว่ารายอื่น 7% / ราคารวมค่าติดตั้งแล้ว" />
              </div>
              <div className="space-y-2 rounded-lg bg-slate-50 p-2.5">
                <Pct label="คะแนนด้านประโยชน์อื่นที่บริษัทจะได้" value={draft.benefitScore} onChange={(n) => setDraft({ ...draft, benefitScore: n })} />
                <textarea className="input w-full" rows={2} maxLength={600} value={draft.benefitReason} onChange={(e) => setDraft({ ...draft, benefitReason: e.target.value })} placeholder="เช่น รับประกัน 3 ปี / ซ่อมถึงที่ / เครดิต 30 วัน / คุณภาพดีกว่า / ส่งเร็ว" />
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" onClick={() => setDraft(null)}>ยกเลิก</button>
                <button type="button" className="btn-primary min-h-[44px] px-5 text-sm" disabled={busy || !draft.vendorName.trim() || !(Number(draft.amount) > 0)} onClick={async () => {
                  const ok = await post({ action: "save_quote", quote: { id: draft.id, vendorId: draft.vendorId, vendorName: draft.vendorName, quoteNo: draft.quoteNo, validUntil: draft.validUntil || null, amount: Number(draft.amount), note: draft.note,
                    priceScore: draft.priceScore, priceReason: draft.priceReason, benefitScore: draft.benefitScore, benefitReason: draft.benefitReason } }, "บันทึกใบเสนอราคาแล้ว");
                  if (ok) setDraft(null);
                }}>บันทึกใบเสนอราคา</button>
              </div>
            </div>
          )}
        </>
      )}

      {cmp.required && !cmp.ready.ok && (perms.edit || perms.choose) && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-sm text-amber-900"><div className="font-semibold">ที่ยังต้องทำก่อนส่ง</div><ul className="list-disc pl-5">{cmp.ready.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
      )}
    </section>
  );
}
