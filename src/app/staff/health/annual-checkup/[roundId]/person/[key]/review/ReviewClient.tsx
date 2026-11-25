"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "../../../../shared";
import { FLAG_TH, withArrow, bmi, flagResult, globulin, indirectBilirubin, refLabel } from "@/lib/health-report/interpret";
import type { Tab } from "@/lib/health-report/tabs";

type Note = { summary: string; recommendation: string };
type Template = { section: string; kind: "summary" | "recommendation"; text: string };
const OVERALL = [{ v: "normal", th: "ปกติ" }, { v: "abnormal", th: "ผิดปกติ" }, { v: "follow_up", th: "ต้องติดตาม" }] as const;

function NoteBox({ section, value, set, templates, disabled }: { section: string; value: Note; set: (n: Note) => void; templates: Template[]; disabled: boolean }) {
  const pick = (kind: "summary" | "recommendation") => templates.filter((t) => t.kind === kind && (t.section === section || t.section === "overall"));
  const field = (kind: "summary" | "recommendation", label: string) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2"><label className="text-xs font-semibold text-slate-600">{label}</label>
        {!disabled && pick(kind).length > 0 && (
          <select className="input text-xs min-h-[36px] max-w-[60%]" value="" onChange={(e) => { if (e.target.value) set({ ...value, [kind]: (value[kind] ? value[kind] + "\n" : "") + e.target.value }); }}>
            <option value="">ข้อความสำเร็จรูป…</option>{pick(kind).map((t, i) => <option key={i} value={t.text}>{t.text}</option>)}
          </select>)}
      </div>
      <textarea disabled={disabled} className="input w-full min-h-[64px] text-sm" value={value[kind]} onChange={(e) => set({ ...value, [kind]: e.target.value })} />
    </div>
  );
  return <div className="space-y-2 rounded-lg bg-amber-50/50 border border-amber-100 p-3">{field("summary", "สรุปผล")}{field("recommendation", "คำแนะนำของแพทย์")}</div>;
}

export default function ReviewClient({ roundId, subject, tabs, sex, age, isApprover, unlocked, notes, templates, conclusion, counts }: {
  roundId: number; subject: string; tabs: Tab[]; sex: "M" | "F" | null; age: number | null; isApprover: boolean; unlocked: boolean;
  notes: Record<string, Note>; templates: Template[]; conclusion: { summary: "normal" | "abnormal" | "follow_up" | null; released: boolean } | null;
  counts: { required: number; recorded: number; verified: number; released: number };
}) {
  const router = useRouter();
  const [n, setN] = useState<Record<string, Note>>(() => ({ ...Object.fromEntries(tabs.map((t) => [t.key, notes[t.key] ?? { summary: "", recommendation: "" }])), overall: notes.overall ?? { summary: "", recommendation: "" } }));
  const [overall, setOverall] = useState<string>(conclusion?.summary ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const can = isApprover && unlocked;

  const run = async (path: string, body: Record<string, unknown>, ok: (r: Record<string, unknown>) => string, refresh = true) => {
    setBusy(true); setMsg(null);
    const r = await post(path, { roundId, subject, ...body });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "ไม่สำเร็จ" }); return false; }
    setMsg({ ok: true, text: ok(r) }); if (refresh) router.refresh(); return true;
  };
  const saveAll = async () => {
    setBusy(true); setMsg(null);
    for (const [section, v] of Object.entries(n)) {
      const r = await post("section-note", { roundId, subject, section, summary: v.summary || null, recommendation: v.recommendation || null });
      if (!r.ok) { setBusy(false); setMsg({ ok: false, text: r.message ?? "บันทึกไม่สำเร็จ" }); return false; }
    }
    const c = await post("conclusion", { roundId, subject, summary: (overall || null) as "normal" | null, doctorComment: n.overall.recommendation || n.overall.summary || null });
    setBusy(false);
    if (!c.ok) { setMsg({ ok: false, text: c.message ?? "บันทึกสรุปไม่สำเร็จ" }); return false; }
    setMsg({ ok: true, text: "บันทึกสรุปของแพทย์แล้ว" }); router.refresh(); return true;
  };

  return (
    <div className="space-y-4">
      {msg && <div className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}
      <div className="card text-sm text-slate-700">ลงผลแล้ว {counts.recorded}/{counts.required} · ตรวจสอบแล้ว {counts.verified}/{counts.required} · เปิดผลแล้ว {counts.released}/{counts.required}{conclusion?.released ? " · เปิดสรุปให้ผู้รับการตรวจแล้ว" : ""}</div>

      {tabs.map((t) => (
        <div key={t.key} className="card space-y-2">
          <h2 className="font-bold text-slate-800">{t.th} <span className="font-normal text-slate-500">· {t.en}</span></h2>
          {t.tests.map((x) => {
            const num = (c: string) => (typeof x.values[c] === "number" ? (x.values[c] as number) : null);
            return (
              <div key={x.orderId}>
                <div className="text-[11px] text-slate-400">{x.status === "released" ? "เปิดผลแล้ว" : x.status === "verified" ? "ตรวจสอบแล้ว" : x.status === "draft" ? "ร่าง (ยังไม่ตรวจสอบ)" : "ยังไม่ลงผล"}</div>
                {x.items.filter((i) => i.kind !== "file").map((it) => {
                  const v = it.computed === "bmi" ? bmi(num("WEIGHT"), num("HEIGHT")) : it.computed === "globulin" ? (num("TP") != null && num("ALB") != null ? globulin(num("TP")!, num("ALB")!) : null) : it.computed === "indirect_bili" ? (num("TBIL") != null && num("DBIL") != null ? indirectBilirubin(num("TBIL")!, num("DBIL")!) : null) : x.values[it.code] ?? null;
                  if (v == null || v === "") return null;
                  const f = flagResult({ kind: it.kind === "file" ? "text" : it.kind, refs: it.refs, normal: it.normal ?? undefined }, v, sex, age);
                  const word = f && f !== "normal" && f !== "info" ? withArrow(FLAG_TH[f]) : "";
                  return (
                    <div key={it.code} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1 text-sm">
                      <span className="min-w-0 break-words">{it.en}</span>
                      <span className={`shrink-0 tabular-nums ${word ? "text-rose-700 font-semibold" : ""}`}>{String(v)} <span className="text-xs text-slate-400">{it.unit ?? ""}</span>{word ? ` · ${word}` : ""} <span className="text-[11px] font-normal text-slate-400">[{refLabel({ refs: it.refs, refText: it.refText ?? undefined }).replace(/\n/g, " / ") || "—"}]</span></span>
                    </div>
                  );
                })}
                {x.file && <a href={x.file.href} target="_blank" rel="noopener" className="text-sm text-brand underline">เปิดไฟล์ที่แนบ (ภาพ/เอกสาร)</a>}
              </div>
            );
          })}
          <NoteBox section={t.key} value={n[t.key]} set={(v) => setN({ ...n, [t.key]: v })} templates={templates} disabled={!can} />
        </div>
      ))}

      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800">สรุปผลการตรวจสุขภาพและคำแนะนำของแพทย์ · Summary and recommendation</h2>
        <div className="flex flex-wrap gap-2">{OVERALL.map((o) => <button key={o.v} type="button" disabled={!can} onClick={() => setOverall(o.v)} className={`rounded-lg border px-4 min-h-[44px] text-sm ${overall === o.v ? "bg-brand text-white border-brand" : "bg-white border-slate-200"}`}>{o.th}</button>)}</div>
        <NoteBox section="overall" value={n.overall} set={(v) => setN({ ...n, overall: v })} templates={templates} disabled={!can} />
        {!can && <p className="text-xs text-slate-500">{isApprover ? "ปลดล็อกด้วยเลขใบอนุญาตด้านบนก่อน จึงจะบันทึกสรุป ตรวจสอบ และเปิดผลได้" : "เฉพาะแพทย์ผู้อนุมัติที่เขียนสรุปและเปิดผลได้"}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy || !can} onClick={saveAll}>บันทึกสรุป</button>
          <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy || !can} onClick={() => run("verify-all", {}, (r) => `ตรวจสอบแล้ว ${r.verified} รายการ`)}>ยืนยันผลทุกรายการ</button>
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !can || !overall} onClick={async () => { if (await saveAll() && window.confirm("เปิดผลให้ผู้รับการตรวจดูได้เลยหรือไม่?")) run("release", {}, (r) => `เปิดผลแล้ว ${r.released} รายการ`); }}>บันทึกและเปิดผล</button>
          <button type="button" className="min-h-[44px] px-4 rounded-lg border border-amber-400 text-amber-800 bg-amber-50 text-sm" disabled={busy || !can} onClick={() => { const note = window.prompt("ระบุสิ่งที่ทีมงานต้องแก้ไข (จะแสดงเป็นงานค้างของผู้ส่งผล):"); if (note && note.trim()) run("return", { note: note.trim() }, () => "ส่งกลับให้ทีมงานแก้ไขแล้ว"); }}>ส่งกลับให้แก้ไข</button>
        </div>
      </div>
    </div>
  );
}
