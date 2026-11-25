"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { post } from "../../shared";
import { FLAG_TH } from "@/lib/health-report/interpret";
import type { LabPlan } from "@/lib/health-report/lab-import";

type Line = { line: number; code: string; ref: string; result: string; who?: string };
const RESULT_TH: Record<string, string> = {
  registered: "ผูกรหัสแล้ว", same: "ผูกไว้แล้ว (เหมือนเดิม)", code_taken: "รหัสนี้ถูกใช้กับคนอื่นแล้ว", person_has_other_code: "คนนี้มีรหัสอื่นอยู่แล้ว",
  not_found: "ไม่พบคนในรอบนี้", ambiguous: "พบหลายคน ระบุให้ชัดขึ้น", bad_code: "รหัสไม่ถูกรูปแบบ (เช่น AHC69-0001)"
};
const STATE_TH: Record<string, string> = { new: "ใหม่", same: "ค่าเดิม ไม่เปลี่ยน", conflict: "ต่างจากค่าเดิม (ไม่เขียนทับถ้าไม่ติ๊ก)", bad: "รูปแบบผิด", not_ordered: "ไม่อยู่ในโปรแกรมตรวจ", locked: "ตรวจสอบแล้ว (ล็อก)", empty: "" };

export default function ImportClient({ roundId, people, coded }: { roundId: number; people: number; coded: number }) {
  const [codes, setCodes] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<LabPlan | null>(null);
  const [opt, setOpt] = useState({ overwrite: false, registerByName: false, confirmImplausible: false });
  const [showAll, setShowAll] = useState(false);

  async function registerCodes(dryRun: boolean) {
    setBusy(true); setMsg(null);
    const r = await post("exam-codes", { roundId, text: codes, dryRun });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.message ?? "ไม่สำเร็จ" }); return; }
    setLines(r.lines as Line[]);
    if (!dryRun) setMsg({ ok: true, text: `ผูกรหัสแล้ว ${(r.lines as Line[]).filter((l) => l.result === "registered").length} คน` });
  }

  async function send(mode: "preview" | "commit", o = opt) {
    if (!file) return;
    setBusy(true); setMsg(null);
    const f = new FormData();
    f.set("file", file); f.set("roundId", String(roundId)); f.set("mode", mode);
    for (const [k, v] of Object.entries(o)) if (v) f.set(k, "1");
    if (mode === "commit" && plan) f.set("planHash", plan.hash);
    let j: { ok: boolean; message?: string; plan?: LabPlan; result?: { rows: number; cellsSaved: number; overwritten: number; skipped: number; registered: number } };
    try { j = await (await fetch(apiUrl("/api/annual-checkup/lab-import"), { method: "POST", body: f })).json(); } catch { j = { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
    setBusy(false);
    if (!j.ok) { setMsg({ ok: false, text: j.message ?? "ไม่สำเร็จ" }); return; }
    if (mode === "preview") setPlan(j.plan!);
    else { const r = j.result!; setMsg({ ok: true, text: `นำเข้าแล้ว ${r.rows} คน · บันทึก ${r.cellsSaved} ค่า (เขียนทับ ${r.overwritten}) · ข้าม ${r.skipped}${r.registered ? ` · ผูกรหัสตามชื่อ ${r.registered}` : ""} — ผลเป็นร่าง รอแพทย์ตรวจสอบ` }); setPlan(null); setFile(null); }
  }

  const blocked = plan?.rows.filter((r) => r.status !== "ready" && r.status !== "nothing") ?? [];
  const suggest = blocked.filter((r) => r.suggestion);
  const shown = (plan?.rows ?? []).filter((r) => r.status === "ready");
  const attention = shown.filter((r) => r.cells.some((c) => c.state === "conflict" || c.state === "bad" || c.implausible || c.critical));

  return (
    <div className="space-y-4">
      {msg && <div className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}

      <section className="card space-y-2">
        <h2 className="font-bold text-slate-800">1. รหัสผู้รับการตรวจ <span className="text-sm font-normal text-slate-500">(ผูกแล้ว {coded}/{people} คน)</span></h2>
        <p className="text-xs text-slate-500">ไฟล์ของแล็บระบุคนด้วยรหัส เช่น AHC69-0001 ให้ผูกรหัสกับคนก่อน พิมพ์ทีละบรรทัด: รหัส เว้นวรรค แล้วตามด้วยรหัสพนักงานหรือชื่อ-นามสกุลเต็ม (วางจาก Excel ได้) รหัสหลอดที่มี -R ท้ายตัดให้เอง</p>
        <textarea className="input w-full min-h-[120px] font-mono text-sm" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={"AHC69-0001\tIKG-W46\nTSR69-0004\tนายสมชาย ใจดี"} />
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={busy || !codes.trim()} onClick={() => registerCodes(true)}>ตรวจก่อนบันทึก</button>
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !codes.trim()} onClick={() => registerCodes(false)}>ผูกรหัส</button>
        </div>
        {lines && <ul className="text-sm divide-y divide-slate-100">{lines.map((l) => <li key={l.line} className="py-1"><span className="font-mono">{l.code}</span> {l.ref} → <b className={l.result === "registered" || l.result === "same" ? "text-emerald-700" : "text-rose-700"}>{RESULT_TH[l.result] ?? l.result}</b>{l.who ? ` (${l.who})` : ""}</li>)}</ul>}
      </section>

      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">2. นำเข้าผลจากไฟล์ Excel ของแล็บ</h2>
        <p className="text-xs text-slate-500">ระบบจับคู่คนด้วยรหัส แล้วตรวจชื่อ-นามสกุลซ้ำอีกชั้น ถ้าชื่อไม่ตรงจะหยุดแถวนั้นและแจ้งเตือน ไม่นำเข้าเงียบๆ ดูตัวอย่างก่อนบันทึกทุกครั้ง ผลที่นำเข้าเป็นร่าง รอแพทย์ตรวจสอบ</p>
        <input type="file" accept=".xlsx,.txt,.csv,.rpt,.dat" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); setMsg(null); }} />
        <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !file} onClick={() => send("preview")}>ดูตัวอย่าง (ยังไม่บันทึก)</button>

        {plan && (
          <div className="space-y-3">
            {plan.issues.length > 0 && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm">{plan.issues.join(" ")}</div>}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-sm">
              {[["แถวที่นำเข้าได้", plan.counts.ready], ["แถวที่หยุดไว้", plan.counts.blocked], ["ค่าใหม่", plan.counts.newCells], ["ต่างจากค่าเดิม", plan.counts.conflicts], ["รูปแบบผิด", plan.counts.bad], ["ไม่อยู่ในโปรแกรม", plan.counts.notOrdered], ["ล็อกแล้ว", plan.counts.locked], ["ค่าผิดปกติมาก", plan.counts.implausible]].map(([k, v]) => (
                <div key={String(k)} className="rounded-lg border border-slate-200 py-2"><div className="text-lg font-bold tabular-nums">{String(v)}</div><div className="text-xs text-slate-500">{String(k)}</div></div>
              ))}
            </div>
            {plan.counts.critical > 0 && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">⚠ มีค่าที่ต้องแจ้งแพทย์ทันที {plan.counts.critical} ค่า (ดูเครื่องหมาย ⚠ ในตาราง)</div>}
            {plan.columns.filter((c) => c.why !== "mapped").length > 0 && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm">
                <b>คอลัมน์ที่ระบบไม่รู้จัก (ไม่ถูกนำเข้า):</b> {plan.columns.filter((c) => c.why !== "mapped").map((c) => `${c.header}${c.why === "ambiguous" ? " (ตรงหลายรายการ)" : ""}`).join(" · ")}
                <div className="text-xs text-slate-500 mt-1">ถ้าเป็นรายการที่ต้องการ ส่งไฟล์ตัวอย่างมาเพื่อเพิ่มชื่อคอลัมน์ หรือกรอกมือในหน้ากรอกผล</div>
              </div>
            )}
            {blocked.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm space-y-1">
                <b className="text-rose-800">แถวที่หยุดไว้ ({blocked.length}) — ไม่นำเข้า</b>
                {blocked.slice(0, 50).map((r) => <div key={r.sheetRow}>แถว {r.sheetRow}: {r.message}{r.suggestion ? ` (ชื่อตรงกับ ${r.suggestion.label} — ผูกรหัสให้ได้ด้านล่าง)` : ""}</div>)}
              </div>
            )}
            {attention.length > 0 && (
              <div className="space-y-1 text-sm">
                <b>ค่าที่ต้องดู ({attention.length} คน)</b>
                {attention.slice(0, showAll ? 500 : 30).map((r) => (
                  <div key={r.sheetRow} className="border-b border-slate-100 py-1"><span className="font-medium">{r.person}</span> <span className="text-xs text-slate-400">({r.code})</span>
                    <ul className="text-xs text-slate-700">
                      {r.cells.filter((c) => c.state === "conflict" || c.state === "bad" || c.implausible || c.critical).map((c) => (
                        <li key={c.col}>{c.header}: ไฟล์ <b>{c.raw}</b>{c.state === "conflict" ? ` · ค่าเดิม ${c.existing}` : ""}{c.state === "bad" ? " · รูปแบบผิด" : ""}{c.flag && c.flag !== "normal" && c.flag !== "info" ? ` · ${FLAG_TH[c.flag]}` : ""}{c.implausible ? " · ค่าผิดปกติมาก ตรวจก่อน" : ""}{c.critical ? " · ⚠ แจ้งแพทย์" : ""}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                {attention.length > 30 && !showAll && <button type="button" className="underline text-xs" onClick={() => setShowAll(true)}>แสดงทั้งหมด</button>}
              </div>
            )}
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2 min-h-[44px]"><input type="checkbox" checked={opt.overwrite} onChange={(e) => setOpt({ ...opt, overwrite: e.target.checked })} /> เขียนทับค่าเดิมที่ต่างกัน ({plan.counts.conflicts} ค่า) — ถ้าไม่ติ๊ก จะคงค่าเดิมไว้</label>
              {suggest.length > 0 && <label className="flex items-center gap-2 min-h-[44px]"><input type="checkbox" checked={opt.registerByName} onChange={(e) => { const o = { ...opt, registerByName: e.target.checked }; setOpt(o); send("preview", o); }} /> ผูกรหัสให้ {suggest.length} แถวที่ชื่อตรงกับคนในรอบ (ชื่อต้องตรงกันทุกตัวอักษร)</label>}
              {plan.counts.implausible > 0 && <label className="flex items-center gap-2 min-h-[44px]"><input type="checkbox" checked={opt.confirmImplausible} onChange={(e) => setOpt({ ...opt, confirmImplausible: e.target.checked })} /> ฉันตรวจค่าผิดปกติมากแล้ว ({plan.counts.implausible} ค่า) ให้บันทึกได้</label>}
            </div>
            <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || plan.counts.ready === 0} onClick={() => { if (window.confirm(`บันทึกผล ${plan.counts.ready} แถว?`)) send("commit"); }}>บันทึกที่ผ่านการตรวจ ({plan.counts.ready} แถว)</button>
            <p className="text-xs text-slate-500">แถวที่หยุดไว้จะไม่ถูกบันทึก แก้ไฟล์หรือผูกรหัสแล้วนำเข้าใหม่ได้ การนำเข้าซ้ำไม่ซ้อนข้อมูล</p>
          </div>
        )}
      </section>
    </div>
  );
}
