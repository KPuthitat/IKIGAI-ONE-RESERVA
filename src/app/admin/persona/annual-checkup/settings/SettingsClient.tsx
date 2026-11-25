"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Item = { id: number; code: string; section: string; name_en: string; unit: string | null; ref_text: string | null; pmin: number | null; pmax: number | null; needsCheck: number; kind: string };
type Ref = { itemId: number; sex: "M" | "F" | "A"; ageMin: number | null; ageMax: number | null; low: number | null; high: number | null; lowIncl: boolean; highIncl: boolean };
type Tpl = { id: number; section: string; kind: "summary" | "recommendation"; text: string; active: boolean };
type Props = { cfg: Record<string, string>; items: Item[]; refs: Ref[]; expl: Array<{ key: string; title: string | null; body: string }>; templates: Tpl[]; sections: Array<{ key: string; th: string }> };

async function save(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  try { return await (await fetch(apiUrl("/api/admin/persona/annual-checkup/settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export default function SettingsClient({ cfg, items, refs, expl, templates, sections }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, okText: string) => { setBusy(true); setMsg(null); const r = await save(body); setBusy(false); setMsg({ ok: r.ok, text: r.ok ? okText : r.message ?? "ไม่สำเร็จ" }); if (r.ok) router.refresh(); return r.ok; };

  // config
  const [consult, setConsult] = useState(cfg.consult_url ?? ""), [mult, setMult] = useState(cfg.critical_enzyme_multiple ?? "5");
  // item editor
  const [itemId, setItemId] = useState<number>(items.find((i) => i.needsCheck)?.id ?? items[0]?.id);
  const it = items.find((i) => i.id === itemId)!;
  type Draft = { unit: string; refText: string; pmin: string; pmax: string; refs: Ref[]; confirmed: boolean };
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const base = (x: Item): Draft => ({ unit: x.unit ?? "", refText: x.ref_text ?? "", pmin: x.pmin == null ? "" : String(x.pmin), pmax: x.pmax == null ? "" : String(x.pmax), refs: refs.filter((r) => r.itemId === x.id), confirmed: false });
  const d: Draft = drafts[itemId] ?? base(it);
  const set = (patch: Partial<Draft>) => setDrafts({ ...drafts, [itemId]: { ...d, ...patch } });
  const load = (id: number) => setItemId(id);
  // explanations
  const [exKey, setExKey] = useState(expl[0]?.key ?? ""); const exRow = expl.find((e) => e.key === exKey);
  const [exBody, setExBody] = useState<{ key: string; body: string } | null>(null);
  const exText = exBody && exBody.key === exKey ? exBody.body : exRow?.body ?? "";
  // templates
  const [newT, setNewT] = useState<{ section: string; kind: "summary" | "recommendation"; text: string }>({ section: "overall", kind: "summary", text: "" });
  const secTh = useMemo(() => ({ ...Object.fromEntries(sections.map((s) => [s.key, s.th])), overall: "ภาพรวม" } as Record<string, string>), [sections]);

  return (
    <div className="space-y-4">
      {msg && <div role="status" className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      <section className="card space-y-2">
        <h2 className="font-bold text-slate-800">ทั่วไป</h2>
        <label className="block text-xs text-slate-500">ลิงก์ช่องทางปรึกษาแพทย์ (ใช้กับปุ่มปรึกษาแพทย์และ QR "SCAN ME" ในเล่ม — ต้องขึ้นต้น https://)</label>
        <div className="flex gap-2"><input className="input min-h-[44px] flex-1" value={consult} onChange={(e) => setConsult(e.target.value)} placeholder="https://line.me/R/ti/p/@athomeclinic" /><button className="btn-primary min-h-[44px] px-4" disabled={busy} type="button" onClick={() => run({ action: "set_config", key: "consult_url", value: consult }, "บันทึกลิงก์ปรึกษาแพทย์แล้ว")}>บันทึก</button></div>
        <label className="block text-xs text-slate-500">เอนไซม์ตับ (AST, ALT) เกินกี่เท่าของค่าสูงสุดที่อ้างอิง จึงแจ้งเตือนแพทย์ทันที</label>
        <div className="flex gap-2"><input className="input min-h-[44px] w-28" inputMode="decimal" value={mult} onChange={(e) => setMult(e.target.value)} /><button className="btn-primary min-h-[44px] px-4" disabled={busy} type="button" onClick={() => run({ action: "set_config", key: "critical_enzyme_multiple", value: mult }, "บันทึกเกณฑ์แจ้งเตือนแล้ว")}>บันทึก</button></div>
      </section>

      <section className="card space-y-2">
        <h2 className="font-bold text-slate-800">หน่วยและค่าอ้างอิงรายการตรวจ <span className="text-xs font-normal text-amber-700">⚠ = รอแพทย์ยืนยัน ({items.filter((i) => i.needsCheck).length} รายการ)</span></h2>
        <select className="input min-h-[44px] w-full" value={itemId} onChange={(e) => load(Number(e.target.value))}>{items.map((i) => <option key={i.id} value={i.id}>{i.needsCheck ? "⚠ " : ""}{i.code} — {i.name_en}</option>)}</select>
        <div className="grid sm:grid-cols-2 gap-2">
          <label className="text-xs text-slate-500">หน่วย<input className="input min-h-[44px] w-full" value={d.unit} onChange={(e) => set({ unit: e.target.value })} /></label>
          <label className="text-xs text-slate-500">ข้อความค่าอ้างอิงที่พิมพ์ในเล่ม (ถ้าเว้นว่างจะสร้างจากช่วงตัวเลข)<input className="input min-h-[44px] w-full" value={d.refText} onChange={(e) => set({ refText: e.target.value })} /></label>
          <label className="text-xs text-slate-500">ช่วงที่เป็นไปได้ ต่ำสุด (ถามยืนยันถ้าต่ำกว่านี้)<input className="input min-h-[44px] w-full" inputMode="decimal" value={d.pmin} onChange={(e) => set({ pmin: e.target.value })} /></label>
          <label className="text-xs text-slate-500">ช่วงที่เป็นไปได้ สูงสุด<input className="input min-h-[44px] w-full" inputMode="decimal" value={d.pmax} onChange={(e) => set({ pmax: e.target.value })} /></label>
        </div>
        {it.kind === "number" && (
          <div className="space-y-1">
            <div className="text-sm font-semibold text-slate-700">ช่วงค่าอ้างอิงตามเพศและอายุ</div>
            {d.refs.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 text-sm">
                <select className="input min-h-[44px]" value={r.sex} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, sex: e.target.value as Ref["sex"] }; set({ refs: n }); }}><option value="A">ทุกเพศ</option><option value="M">ชาย</option><option value="F">หญิง</option></select>
                อายุ<input className="input min-h-[44px] w-16" inputMode="numeric" placeholder="จาก" value={r.ageMin ?? ""} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, ageMin: numOrNull(e.target.value) }; set({ refs: n }); }} />–<input className="input min-h-[44px] w-16" inputMode="numeric" placeholder="ถึง" value={r.ageMax ?? ""} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, ageMax: numOrNull(e.target.value) }; set({ refs: n }); }} />
                ค่า<input className="input min-h-[44px] w-20" inputMode="decimal" placeholder="ต่ำสุด" value={r.low ?? ""} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, low: numOrNull(e.target.value) }; set({ refs: n }); }} />
                <label className="text-xs"><input type="checkbox" checked={r.lowIncl} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, lowIncl: e.target.checked }; set({ refs: n }); }} /> รวมค่านี้</label>
                –<input className="input min-h-[44px] w-20" inputMode="decimal" placeholder="สูงสุด" value={r.high ?? ""} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, high: numOrNull(e.target.value) }; set({ refs: n }); }} />
                <label className="text-xs"><input type="checkbox" checked={r.highIncl} onChange={(e) => { const n = [...d.refs]; n[i] = { ...r, highIncl: e.target.checked }; set({ refs: n }); }} /> รวมค่านี้</label>
                <button type="button" className="text-rose-700 underline min-h-[44px] px-2" onClick={() => set({ refs: d.refs.filter((_, k) => k !== i) })}>ลบ</button>
              </div>
            ))}
            <button type="button" className="btn-secondary min-h-[44px] px-3 text-sm" onClick={() => set({ refs: [...d.refs, { itemId, sex: "A", ageMin: null, ageMax: null, low: null, high: null, lowIncl: true, highIncl: true }] })}>+ เพิ่มช่วง</button>
          </div>
        )}
        <label className="flex items-center gap-2 min-h-[44px] text-sm"><input type="checkbox" checked={d.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} /> แพทย์ตรวจสอบรายการนี้แล้ว (เอาเครื่องหมาย ⚠ ออก)</label>
        <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy} onClick={() => run({ action: "item_update", itemId, unit: d.unit, refText: d.refText, plausibleMin: numOrNull(d.pmin), plausibleMax: numOrNull(d.pmax), confirmed: d.confirmed, ...(it.kind === "number" ? { refs: d.refs.map((r) => ({ sex: r.sex, ageMin: r.ageMin, ageMax: r.ageMax, low: r.low, high: r.high, lowIncl: r.lowIncl, highIncl: r.highIncl })) } : {}) }, `บันทึก ${it.code} แล้ว`)}>บันทึกรายการนี้</button>
      </section>

      <section className="card space-y-2">
        <h2 className="font-bold text-slate-800">ข้อความคำอธิบาย "รายการนี้คืออะไร"</h2>
        <select className="input min-h-[44px] w-full" value={exKey} onChange={(e) => { setExKey(e.target.value); setExBody(null); }}>{expl.map((e) => <option key={e.key} value={e.key}>{e.key}{e.title ? ` — ${e.title.slice(0, 40)}` : ""}</option>)}</select>
        <textarea className="input w-full min-h-[140px] text-sm" value={exText} onChange={(e) => setExBody({ key: exKey, body: e.target.value })} />
        <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !exText.trim()} onClick={() => run({ action: "explanation_save", key: exKey, title: exRow?.title ?? null, body: exText }, "บันทึกข้อความคำอธิบายแล้ว")}>บันทึกข้อความ</button>
      </section>

      <section className="card space-y-2">
        <h2 className="font-bold text-slate-800">ข้อความสำเร็จรูปของแพทย์</h2>
        <div className="grid sm:grid-cols-[auto_auto_1fr_auto] gap-2 items-start">
          <select className="input min-h-[44px]" value={newT.section} onChange={(e) => setNewT({ ...newT, section: e.target.value })}><option value="overall">ภาพรวม</option>{sections.map((s) => <option key={s.key} value={s.key}>{s.th}</option>)}</select>
          <select className="input min-h-[44px]" value={newT.kind} onChange={(e) => setNewT({ ...newT, kind: e.target.value as "summary" | "recommendation" })}><option value="summary">สรุปผล</option><option value="recommendation">คำแนะนำ</option></select>
          <input className="input min-h-[44px]" placeholder="ข้อความ" value={newT.text} onChange={(e) => setNewT({ ...newT, text: e.target.value })} />
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !newT.text.trim()} onClick={async () => { if (await run({ action: "template_save", ...newT }, "เพิ่มข้อความแล้ว")) setNewT({ ...newT, text: "" }); }}>เพิ่ม</button>
        </div>
        <ul className="divide-y divide-slate-100 text-sm">
          {templates.map((t) => <li key={t.id} className="py-1.5 flex items-center justify-between gap-2"><span><span className="text-xs text-slate-500">{secTh[t.section] ?? t.section} · {t.kind === "summary" ? "สรุปผล" : "คำแนะนำ"}</span><br />{t.text}</span><button type="button" className="text-rose-700 underline min-h-[44px] px-2" disabled={busy} onClick={() => { if (window.confirm("ลบข้อความนี้?")) run({ action: "template_delete", id: t.id }, "ลบแล้ว"); }}>ลบ</button></li>)}
        </ul>
      </section>
    </div>
  );
}
