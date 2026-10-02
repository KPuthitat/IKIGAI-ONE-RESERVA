"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import { FormSection, Field } from "@/app/components/FormKit";
import {
  IR_SEVERITIES, IR_INCIDENT_TYPES, IR_CATEGORY_GROUPS, IR_CONTRIBUTING_FACTORS, IR_PERSON_ROLES,
  IR_MAX_WHYS, IR_MAX_RECOMMENDATIONS, IR_MAX_PEOPLE, severityMeta,
  type IrSeverity, type IrIncidentType, type IrPersonRole
} from "@/lib/ir-vocab";
import type { IrReportDetail } from "@/lib/ir-db";

// The ONE detailed incident-report form (owner 2026-10-01): the person involved
// signs in and writes it themselves — facts, impact, 5 Whys, contributing
// factors, root cause, recommendations — and can name other people. The staff
// self-service page and the admin console both render this component, so the
// two can never drift. Create (POST apiBase) or edit (PATCH apiBase/:id).

export type ColleagueOption = { id: number; display_name: string; title_prefix: string | null };

type PersonRow = { key: number; userId: number | null; name: string; role: IrPersonRole; note: string };

const WHY_PROMPTS = [
  "ทำไมถึงเกิดเหตุการณ์นี้?",
  "แล้วทำไมถึงเป็นแบบนั้น?",
  "ทำไมถึงเป็นแบบนั้นอีก?",
  "ลึกลงไปอีก — ทำไม?",
  "ถึงต้นตอหรือยัง — ทำไม?"
];

function nowLocalInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// occurred_at is stored as the datetime-local string; older rows may be ISO.
function toLocalInput(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  const d = new Date(s);
  if (isNaN(d.getTime())) return nowLocalInput();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function IrReportForm({
  apiBase, colleagues, selfUserId, initial, allowAnonymous = true, guideHref = "/staff/ir/guide",
  onDone, onCancel
}: {
  apiBase: string;                      // "/api/staff/ir" | "/api/admin/ir"
  colleagues: ColleagueOption[];
  selfUserId: number;
  initial?: IrReportDetail | null;      // edit mode when set
  allowAnonymous?: boolean;
  guideHref?: string;
  onDone: (report: { id: number }) => void;
  onCancel?: () => void;
}) {
  const editing = !!initial;
  const [occurredAt, setOccurredAt] = useState(initial ? toLocalInput(initial.occurred_at) : nowLocalInput());
  const [location, setLocation] = useState(initial?.location_detail ?? "");
  const [category, setCategory] = useState(initial?.category ?? IR_CATEGORY_GROUPS[0].items[0].key);
  const [incidentType, setIncidentType] = useState<IrIncidentType>(initial?.incident_type ?? "actual");
  const [severity, setSeverity] = useState<IrSeverity>((initial?.severity as IrSeverity | undefined) ?? 2);
  const [selfInvolved, setSelfInvolved] = useState(initial ? initial.self_involved === 1 : true);
  const [people, setPeople] = useState<PersonRow[]>(
    (initial?.people ?? []).map((p, i) => ({ key: i + 1, userId: p.user_id, name: p.user_id ? "" : p.name, role: p.role, note: p.note ?? "" }))
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [timeline, setTimeline] = useState(initial?.timeline ?? "");
  const [impact, setImpact] = useState(initial?.impact ?? "");
  const [immediate, setImmediate] = useState(initial?.immediate_action ?? "");
  const [whys, setWhys] = useState<string[]>(() => {
    const w = initial?.rca.whyChain ?? [];
    return w.length ? w : [""];
  });
  const [factors, setFactors] = useState<string[]>(initial?.rca.contributing ?? []);
  const [rootCause, setRootCause] = useState(initial?.reporter_root_cause ?? "");
  const [recs, setRecs] = useState<string[]>(() => {
    const r = initial?.rca.recommendations ?? [];
    return r.length ? r : [""];
  });
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pickable people = active colleagues (not me) + anyone already named on this
  // report who has since left the active list, so an edit never silently
  // re-points a stored person at the first option.
  const others = useMemo(() => {
    const base = colleagues.filter((c) => c.id !== selfUserId);
    const known = new Set(base.map((c) => c.id));
    for (const p of initial?.people ?? []) {
      if (p.user_id != null && !known.has(p.user_id)) { base.push({ id: p.user_id, display_name: p.name, title_prefix: null }); known.add(p.user_id); }
    }
    return base;
  }, [colleagues, selfUserId, initial]);
  const sevMeta = severityMeta(severity);

  // ── people rows ──
  const addPerson = () => {
    if (people.length >= IR_MAX_PEOPLE) return;
    setPeople((ps) => [...ps, { key: Date.now(), userId: others[0]?.id ?? null, name: "", role: "involved", note: "" }]);
  };
  const patchPerson = (key: number, patch: Partial<PersonRow>) =>
    setPeople((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const removePerson = (key: number) => setPeople((ps) => ps.filter((p) => p.key !== key));

  // ── list helpers (whys / recommendations) ──
  const setAt = (arr: string[], i: number, v: string) => arr.map((x, j) => (j === i ? v : x));
  const whysShown = Math.min(IR_MAX_WHYS, Math.max(whys.length, whys.findIndex((w) => !w.trim()) === -1 ? whys.length + 1 : whys.length));
  const whyList = [...whys, ...Array(Math.max(0, whysShown - whys.length)).fill("")].slice(0, IR_MAX_WHYS);

  function validate(): string | null {
    if (!description.trim()) return "กรุณาเล่าว่าเกิดอะไรขึ้น";
    if (!whys[0]?.trim()) return "กรุณาตอบ \"ทำไม\" อย่างน้อย 1 ครั้งในส่วนวิเคราะห์สาเหตุ";
    if (!rootCause.trim()) return "กรุณาสรุปสาเหตุรากที่เห็นว่าเป็นต้นตอ";
    if (!recs.some((r) => r.trim())) return "กรุณาเสนอแนวทางป้องกันอย่างน้อย 1 ข้อ";
    for (const p of people) {
      if (p.userId == null && !p.name.trim()) return "ผู้เกี่ยวข้องที่เป็นบุคคลภายนอก กรุณาระบุชื่อ";
    }
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setErr(v); return; }
    setBusy(true); setErr(null);
    const body = {
      occurred_at: occurredAt,
      location_detail: location.trim() || null,
      category, incident_type: incidentType, severity,
      description: description.trim(),
      immediate_action: immediate.trim() || null,
      timeline: timeline.trim() || null,
      impact: impact.trim() || null,
      why_chain: whys.map((w) => w.trim()).filter(Boolean),
      contributing: factors,
      reporter_root_cause: rootCause.trim() || null,
      recommendations: recs.map((r) => r.trim()).filter(Boolean),
      self_involved: anonymous ? false : selfInvolved,
      people: people.map((p) => ({ user_id: p.userId, name: p.userId ? null : p.name.trim(), role: p.role, note: p.note.trim() || null })),
      ...(editing ? {} : { anonymous })
    };
    try {
      const res = await fetch(apiUrl(editing ? `${apiBase}/${initial!.id}` : apiBase), {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      onDone(j.report as { id: number });
    } catch {
      setErr("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">{editing ? `แก้ไขรายงาน ${initial!.code ?? `#${initial!.id}`}` : "แจ้งเหตุการณ์ / ความเสี่ยง (IR)"}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            เขียนตามความเป็นจริง เพื่อค้นหาสาเหตุและป้องกันไม่ให้เกิดซ้ำ ไม่ใช่เพื่อค้นหาผู้กระทำผิด ·{" "}
            <Link href={guideHref} className="text-brand hover:underline" target="_blank">อ่านคู่มือการเขียนรายงาน →</Link>
          </p>
        </div>
      </div>

      {/* 1) เหตุการณ์ */}
      <FormSection title="1. เหตุการณ์">
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="เกิดขึ้นเมื่อ">
            <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </Field>
          <Field label="จุดเกิดเหตุ" hint="ถ้ามี">
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="เช่น ครัว / ห้องหัตถการ / หน้าร้าน / โต๊ะ 5" />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="หมวดเหตุการณ์">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {IR_CATEGORY_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((it) => <option key={it.key} value={it.key}>{it.labelTh}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="ชนิด">
            <select value={incidentType} onChange={(e) => setIncidentType(e.target.value as IrIncidentType)}>
              {IR_INCIDENT_TYPES.map((it) => <option key={it.value} value={it.value}>{it.labelTh}</option>)}
            </select>
          </Field>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">ระดับความรุนแรง</div>
          <div className="flex flex-wrap gap-1.5">
            {IR_SEVERITIES.map((s) => (
              <button type="button" key={s.value} onClick={() => setSeverity(s.value)}
                className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
                  severity === s.value ? s.tone + " ring-1 ring-current font-semibold" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
                {s.value} · {s.labelTh}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">{sevMeta.descTh}</p>
        </div>
      </FormSection>

      {/* 2) ผู้เกี่ยวข้อง */}
      <FormSection title="2. ผู้เกี่ยวข้อง" action={
        <button type="button" onClick={addPerson} disabled={people.length >= IR_MAX_PEOPLE}
          className="text-xs text-brand hover:underline disabled:text-slate-300">+ เพิ่มชื่อผู้อื่น</button>
      }>
        {!anonymous && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={selfInvolved} onChange={(e) => setSelfInvolved(e.target.checked)} className="w-4 h-4" />
            ฉันเป็นผู้เกี่ยวข้องโดยตรงกับเหตุการณ์นี้ (ผู้กระทำ หรือผู้อยู่ในเหตุการณ์)
          </label>
        )}
        {people.length === 0 && (
          <p className="text-xs text-slate-400">หากมีเพื่อนร่วมงานหรือบุคคลอื่นเกี่ยวข้อง เลือก “+ เพิ่มชื่อผู้อื่น” และระบุทุกคนที่อยู่ในเหตุการณ์ เพื่อให้ทีมบริหารความเสี่ยงสอบถามข้อมูลเพิ่มเติมได้ ไม่ใช่เพื่อกล่าวโทษผู้ใด</p>
        )}
        {people.map((p) => (
          <div key={p.key} className="rounded-lg border border-slate-200 p-2.5 space-y-2 bg-slate-50/60">
            <div className="grid sm:grid-cols-[1fr_auto] gap-2">
              <div className="grid sm:grid-cols-2 gap-2">
                <select value={p.userId ?? "ext"} onChange={(e) => patchPerson(p.key, { userId: e.target.value === "ext" ? null : Number(e.target.value) })} className="input !py-1.5 text-sm">
                  {others.map((c) => <option key={c.id} value={c.id}>{nameWithPrefix(c.title_prefix, c.display_name)}</option>)}
                  <option value="ext">บุคคลภายนอก (พิมพ์ชื่อ)</option>
                </select>
                {p.userId == null
                  ? <input type="text" value={p.name} onChange={(e) => patchPerson(p.key, { name: e.target.value })} placeholder="ชื่อ เช่น ลูกค้าโต๊ะ 5 / ไรเดอร์" className="input !py-1.5 text-sm" />
                  : <select value={p.role} onChange={(e) => patchPerson(p.key, { role: e.target.value as IrPersonRole })} className="input !py-1.5 text-sm">
                      {IR_PERSON_ROLES.map((r) => <option key={r.value} value={r.value}>{r.labelTh}</option>)}
                    </select>}
              </div>
              <button type="button" onClick={() => removePerson(p.key)} className="text-xs text-rose-500 hover:underline self-center">ลบ</button>
            </div>
            {p.userId == null && (
              <select value={p.role} onChange={(e) => patchPerson(p.key, { role: e.target.value as IrPersonRole })} className="input !py-1.5 text-sm sm:w-1/2">
                {IR_PERSON_ROLES.map((r) => <option key={r.value} value={r.value}>{r.labelTh}</option>)}
              </select>
            )}
            <input type="text" value={p.note} onChange={(e) => patchPerson(p.key, { note: e.target.value })} placeholder="บทบาทในเหตุการณ์ (ถ้ามี) เช่น เป็นคนเสิร์ฟ / เห็นตอนเกิดเหตุ" className="input !py-1.5 text-sm" />
          </div>
        ))}
      </FormSection>

      {/* 3) ข้อเท็จจริง */}
      <FormSection title="3. เกิดอะไรขึ้น (ข้อเท็จจริง)">
        <Field label="เล่าเหตุการณ์" hint="ใคร ทำอะไร ที่ไหน เมื่อใด อย่างไร เขียนเฉพาะสิ่งที่เห็นจริง ไม่ใส่ความเห็น">
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="เช่น เวลา 12:40 ขณะเสิร์ฟน้ำซุปร้อนให้โต๊ะ 5 ถาดเอียง ซุปหกใส่แขนลูกค้า ลูกค้าถูกน้ำร้อนบริเวณข้อมือซ้าย" />
        </Field>
        <Field label="ลำดับเหตุการณ์" hint="ก่อนเกิดเหตุ ขณะเกิดเหตุ หลังเกิดเหตุ (ถ้ามี)">
          <textarea rows={3} value={timeline} onChange={(e) => setTimeline(e.target.value)}
            placeholder={"12:30 รับออเดอร์ 4 โต๊ะพร้อมกัน\n12:38 ยกถาด 3 ถ้วยคนเดียว\n12:40 ซุปหก\n12:41 ล้างน้ำเย็น แจ้งหัวหน้า"} />
        </Field>
        <Field label="ผลกระทบ" hint="ต่อลูกค้า / พนักงาน / ทรัพย์สิน / ชื่อเสียง">
          <textarea rows={2} value={impact} onChange={(e) => setImpact(e.target.value)}
            placeholder="เช่น ลูกค้าแดงที่ข้อมือ ไม่พอง · ลูกค้าไม่พอใจ ขอไม่คิดเงินมื้อนั้น · เสื้อลูกค้าเปื้อน" />
        </Field>
        <Field label="แก้ไขเฉพาะหน้าไปแล้วอย่างไร" hint="ถ้ามี">
          <textarea rows={2} value={immediate} onChange={(e) => setImmediate(e.target.value)}
            placeholder="เช่น ปฐมพยาบาล / เปลี่ยนสินค้า / กล่าวขอโทษลูกค้า / แจ้งหัวหน้างาน" />
        </Field>
      </FormSection>

      {/* 4) RCA */}
      <FormSection title="4. วิเคราะห์สาเหตุราก (Root Cause Analysis)">
        <p className="text-xs text-slate-500 -mt-1">ถาม “ทำไม” ซ้ำจากคำตอบก่อนหน้า จนถึงสาเหตุที่แก้ไขได้จริง (ไม่จำเป็นต้องครบ 5 ครั้ง หากถึงต้นตอแล้ว)</p>
        <div className="space-y-2">
          {whyList.map((w, i) => (
            <Field key={i} label={`ทำไม ครั้งที่ ${i + 1}`} hint={WHY_PROMPTS[i]}>
              <input type="text" value={w} onChange={(e) => setWhys((arr) => setAt([...arr, ...Array(Math.max(0, i + 1 - arr.length)).fill("")], i, e.target.value))}
                placeholder={i === 0 ? "เช่น เพราะยกถาด 3 ถ้วยคนเดียว" : i === 1 ? "เช่น เพราะมีรายการสั่งอาหาร 4 โต๊ะพร้อมกัน และมีพนักงานเสิร์ฟคนเดียว" : "…"} />
            </Field>
          ))}
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">ปัจจัยร่วม (เลือกได้หลายข้อ)</div>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {IR_CONTRIBUTING_FACTORS.map((f) => {
              const on = factors.includes(f.key);
              return (
                <label key={f.key} className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-sm cursor-pointer ${on ? "border-brand bg-brand/5" : "border-slate-200 bg-white"}`}>
                  <input type="checkbox" checked={on} onChange={(e) => setFactors((arr) => (e.target.checked ? [...arr, f.key] : arr.filter((k) => k !== f.key)))} className="w-4 h-4 mt-0.5" />
                  <span>
                    <span className="font-medium text-slate-700">{f.labelTh}</span>
                    <span className="block text-[11px] text-slate-400">{f.hintTh}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <Field label="สรุปสาเหตุราก" hint="1–2 ประโยค สิ่งที่หากแก้ไขแล้วจะไม่เกิดซ้ำ">
          <textarea rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)}
            placeholder="เช่น ช่วงลูกค้าหนาแน่นไม่มีการจัดพนักงานเสิร์ฟสำรอง และไม่มีข้อกำหนดว่าอาหารร้อนห้ามยกเกิน 2 ถ้วยต่อถาด" />
        </Field>
      </FormSection>

      {/* 5) Recommendations */}
      <FormSection title="5. ข้อเสนอแนะ / แนวทางป้องกัน" action={
        <button type="button" onClick={() => setRecs((r) => (r.length < IR_MAX_RECOMMENDATIONS ? [...r, ""] : r))}
          className="text-xs text-brand hover:underline">+ เพิ่มข้อ</button>
      }>
        <p className="text-xs text-slate-500 -mt-1">เสนอสิ่งที่แก้ไขที่ระบบ ขั้นตอน หรืออุปกรณ์ ไม่ใช่ “จะระมัดระวังมากขึ้น” และระบุว่าทำอะไร ผู้ใดรับผิดชอบ เมื่อใด</p>
        {recs.map((r, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-xs text-slate-400 mt-2.5 w-4 shrink-0">{i + 1}.</span>
            <input type="text" value={r} onChange={(e) => setRecs((arr) => setAt(arr, i, e.target.value))} className="input !py-1.5 text-sm flex-1"
              placeholder={i === 0 ? "เช่น ช่วงลูกค้าหนาแน่นให้ครัวช่วยเสิร์ฟอาหารร้อน และจำกัด 2 ถ้วยต่อถาด (หัวหน้ากะ เริ่มสัปดาห์หน้า)" : "…"} />
            {recs.length > 1 && <button type="button" onClick={() => setRecs((arr) => arr.filter((_, j) => j !== i))} className="text-xs text-rose-500 hover:underline mt-2">ลบ</button>}
          </div>
        ))}
      </FormSection>

      {!editing && allowAnonymous && (
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="w-4 h-4 mt-0.5" />
          <span>แจ้งโดยไม่ระบุตัวตน <span className="text-xs text-slate-400">(ระบบจะไม่บันทึกว่าผู้ใดเป็นผู้แจ้ง และจะไม่สามารถแก้ไขรายงานภายหลังได้)</span></span>
        </label>
      )}

      {err && <div className="text-sm text-rose-600">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>ยกเลิก</button>}
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? "กำลังบันทึก…" : editing ? "บันทึกการแก้ไข" : "ส่งรายงาน"}
        </button>
      </div>
    </div>
  );
}
