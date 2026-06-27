"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { useConfirm } from "@/app/components/useConfirm";
import type { Lang } from "@/lib/i18n";
import type { FormTemplate, FormSection, FormField } from "@/lib/recruita-form-template";

// /admin/recruita/form-template — editor for the standard application
// form. Mirrors the data model in lib/recruita-form-template.ts:
//   sections[] → each has fields[]
// Admin can:
//   - toggle a whole section on/off (collapses the field rows)
//   - toggle each field on/off
//   - rename labels (TH + EN)
//   - mark required
//   - reorder fields within a section (↑↓ buttons)
//   - reorder sections themselves
// "Reset to default" wipes overrides and falls back to DEFAULT_TEMPLATE
// — useful when admin messes up an experimental edit. Doesn't ALSO
// wipe per-position custom_questions (those live on positions rows
// and are unrelated).

export default function FormTemplateClient({
  template: initialTemplate,
  lang
}: {
  template: FormTemplate;
  lang: Lang;
}) {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const [, startTransition] = useTransition();
  const [tpl, setTpl] = useState<FormTemplate>(initialTemplate);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function updateSection(idx: number, patch: Partial<FormSection>) {
    setTpl((t) => ({
      ...t,
      sections: t.sections.map((s, i) => i === idx ? { ...s, ...patch } : s)
    }));
  }

  function updateField(secIdx: number, fldIdx: number, patch: Partial<FormField>) {
    setTpl((t) => ({
      ...t,
      sections: t.sections.map((s, i) =>
        i !== secIdx ? s : {
          ...s,
          fields: s.fields.map((f, j) => j === fldIdx ? { ...f, ...patch } : f)
        }
      )
    }));
  }

  function moveField(secIdx: number, fldIdx: number, dir: -1 | 1) {
    setTpl((t) => {
      const sec = t.sections[secIdx];
      if (!sec) return t;
      const newIdx = fldIdx + dir;
      if (newIdx < 0 || newIdx >= sec.fields.length) return t;
      const fields = [...sec.fields];
      [fields[fldIdx], fields[newIdx]] = [fields[newIdx], fields[fldIdx]];
      // Renormalise display_order so it matches array index
      const renumbered = fields.map((f, i) => ({ ...f, display_order: (i + 1) * 10 }));
      return {
        ...t,
        sections: t.sections.map((s, i) => i === secIdx ? { ...s, fields: renumbered } : s)
      };
    });
  }

  function moveSection(secIdx: number, dir: -1 | 1) {
    setTpl((t) => {
      const newIdx = secIdx + dir;
      if (newIdx < 0 || newIdx >= t.sections.length) return t;
      const sections = [...t.sections];
      [sections[secIdx], sections[newIdx]] = [sections[newIdx], sections[secIdx]];
      const renumbered = sections.map((s, i) => ({ ...s, display_order: (i + 1) * 10 }));
      return { ...t, sections: renumbered };
    });
  }

  async function save() {
    setBusy(true);
    setErr(null); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/recruita/form-template"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template: tpl })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ"));
        return;
      }
      setMsg("✓ บันทึกเรียบร้อย");
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  async function resetToInitial() {
    const ok = await confirm({ title: "ยกเลิกการแก้ไขทั้งหมดที่ยังไม่ได้บันทึก?", confirmLabel: "ยกเลิกการแก้ไข", cancelLabel: "ปิด", variant: "warning" });
    if (ok === null) return;
    setTpl(initialTemplate);
    setMsg(null); setErr(null);
  }

  const isEN = lang === "en";
  const totalFields = tpl.sections.reduce((sum, s) => sum + s.fields.length, 0);
  const enabledFields = tpl.sections
    .filter((s) => s.enabled)
    .reduce((sum, s) => sum + s.fields.filter((f) => f.enabled).length, 0);

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">
            {isEN ? "Application form" : "ฟอร์มใบสมัครมาตรฐาน"}
          </span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {isEN
            ? "Edit the standard application form used at /recruita/apply/[positionId]. Changes apply to every position."
            : "แก้ไขฟอร์มใบสมัครมาตรฐานที่ใช้ที่ /recruita/apply/[ตำแหน่ง] — การแก้ไขมีผลกับทุกตำแหน่ง"}
        </p>
      </div>

      {/* Stats + Save bar */}
      <div className="card flex items-center justify-between gap-3 flex-wrap sticky top-2 z-10 bg-white shadow-md">
        <div className="text-xs text-slate-600">
          <span className="font-bold text-slate-800">{enabledFields}</span> / {totalFields}
          {" "}ฟิลด์เปิดใช้งาน · {tpl.sections.filter((s) => s.enabled).length}
          {" "}/ {tpl.sections.length} ส่วน
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-emerald-700 text-sm font-bold">{msg}</span>}
          {err && <span className="text-rose-700 text-sm font-bold">✗ {err}</span>}
          <button type="button" onClick={resetToInitial}
            className="text-xs text-slate-500 hover:text-slate-800 underline">
            ยกเลิกการแก้ไข
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="btn-primary text-sm disabled:opacity-50">
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </div>

      {/* Sections */}
      {tpl.sections.map((sec, sIdx) => (
        <SectionCard
          key={sec.key}
          section={sec}
          isFirst={sIdx === 0}
          isLast={sIdx === tpl.sections.length - 1}
          onChange={(patch) => updateSection(sIdx, patch)}
          onChangeField={(fIdx, patch) => updateField(sIdx, fIdx, patch)}
          onMoveField={(fIdx, dir) => moveField(sIdx, fIdx, dir)}
          onMoveSection={(dir) => moveSection(sIdx, dir)} />
      ))}

      <div className="card bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
        <p className="font-bold">หมายเหตุ</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>ส่วน <b>การศึกษา</b> และ <b>ประสบการณ์ทำงาน</b> เป็นแบบหลายแถว — เปิด/ปิดทั้งส่วน (ยังไม่เลือก sub-field รายตัว)</li>
          <li>ฟิลด์มาตรฐาน (key) ไม่สามารถเปลี่ยนได้ — เพราะ map กับคอลัมน์ DB. เปลี่ยนได้แค่ label, required, ลำดับ</li>
          <li>ใบสมัครยังไม่ render dynamic ตาม template ในรอบนี้ — อยู่ใน Phase 1g.2 (รอบหน้า)</li>
        </ul>
      </div>
    </div>
  );
}

function SectionCard({
  section, isFirst, isLast,
  onChange, onChangeField, onMoveField, onMoveSection
}: {
  section: FormSection;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<FormSection>) => void;
  onChangeField: (fIdx: number, patch: Partial<FormField>) => void;
  onMoveField: (fIdx: number, dir: -1 | 1) => void;
  onMoveSection: (dir: -1 | 1) => void;
}) {
  return (
    <section className={`card space-y-3 ${section.enabled ? "" : "opacity-50"}`}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={section.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="mt-1.5 h-4 w-4" />
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500">หัวข้อ (ไทย)</label>
            <input className="input text-sm font-bold" value={section.label_th}
              onChange={(e) => onChange({ label_th: e.target.value })} />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500">หัวข้อ (English)</label>
            <input className="input text-sm" value={section.label_en}
              onChange={(e) => onChange({ label_en: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button type="button" onClick={() => onMoveSection(-1)} disabled={isFirst}
            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30">↑</button>
          <button type="button" onClick={() => onMoveSection(1)} disabled={isLast}
            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30">↓</button>
        </div>
      </div>

      {section.enabled && section.fields.length > 0 && (
        <div className="border-t border-slate-200 pt-3 space-y-2">
          {section.fields.map((f, i) => (
            <FieldRow
              key={f.key}
              field={f}
              isFirst={i === 0}
              isLast={i === section.fields.length - 1}
              onChange={(patch) => onChangeField(i, patch)}
              onMove={(dir) => onMoveField(i, dir)} />
          ))}
        </div>
      )}

      {section.enabled && section.fields.length === 0 && (
        <p className="text-[11px] text-slate-400 italic border-t border-slate-200 pt-2">
          ส่วนนี้เป็นแบบหลายแถว — ตัวฟิลด์ภายในจัดการในโค้ด (ปิดทั้งส่วนได้ผ่านการ uncheck ด้านบน)
        </p>
      )}
    </section>
  );
}

function FieldRow({
  field, isFirst, isLast, onChange, onMove
}: {
  field: FormField;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<FormField>) => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className={`flex items-center gap-2 p-2 rounded ${field.enabled ? "bg-slate-50" : "bg-slate-100/50 opacity-60"}`}>
      <input
        type="checkbox"
        checked={field.enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
        className="h-4 w-4" />
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2">
        <input className="input text-xs" value={field.label_th}
          onChange={(e) => onChange({ label_th: e.target.value })}
          placeholder="ป้ายภาษาไทย" />
        <input className="input text-xs" value={field.label_en}
          onChange={(e) => onChange({ label_en: e.target.value })}
          placeholder="English label" />
      </div>
      <label className="flex items-center gap-1 text-[11px] text-slate-600 whitespace-nowrap">
        <input
          type="checkbox"
          checked={field.required}
          onChange={(e) => onChange({ required: e.target.checked })}
          className="h-3.5 w-3.5" />
        บังคับ
      </label>
      <span className="text-[10px] font-mono text-slate-400 px-1.5 py-0.5 bg-slate-200 rounded whitespace-nowrap">
        {field.key}
      </span>
      <div className="flex flex-col gap-0.5">
        <button type="button" onClick={() => onMove(-1)} disabled={isFirst}
          className="text-[10px] px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded disabled:opacity-30">↑</button>
        <button type="button" onClick={() => onMove(1)} disabled={isLast}
          className="text-[10px] px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded disabled:opacity-30">↓</button>
      </div>
    </div>
  );
}
