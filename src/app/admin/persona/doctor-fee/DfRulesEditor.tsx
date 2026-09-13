"use client";

import { useRef, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import type { DfRule } from "@/lib/df-db";

// Rule editor for the Doctor-Fee module — the "หัวข้อรายการค่าตอบแทนแพทย์"
// (code × rate) setup. Extracted from DoctorFeeClient so it can live on the
// dedicated config page (owner 2026-09-13: settings moved off the landing page).

export function RulesEditor({ rules, onChange, onSaved }: {
  rules: DfRule[]; onChange: (r: DfRule[]) => void; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function patch(id: number, body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/doctor-fee/rules/${id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      onChange(j.rules as DfRule[]);
      onSaved();
    } catch { setErr("บันทึกไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function remove(id: number) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/doctor-fee/rules/${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      onChange(j.rules as DfRule[]);
      onSaved();
    } catch { setErr("ลบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function create(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/rules"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "เพิ่มหัวข้อไม่สำเร็จ")); return; }
      onChange(j.rules as DfRule[]);
      setAdding(false);
      onSaved();
    } catch { setErr("เพิ่มหัวข้อไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold text-slate-700">หัวข้อรายการค่าตอบแทนแพทย์ (รหัส × เรท)</h2>
      <ScanPicker onApplied={(r) => { onChange(r); onSaved(); }} />
      <div className="space-y-2">
        {rules.map((r) => (
          <RuleRow key={r.id} rule={r} busy={busy} onSave={(b) => patch(r.id, b)} onDelete={() => remove(r.id)} />
        ))}
        {rules.length === 0 && <div className="text-sm text-slate-400">ยังไม่มีหัวข้อ — กด “+ เพิ่มหัวข้อ” เพื่อสร้าง เช่น HSC 30%</div>}
        {adding && (
          <RuleRow
            rule={{ id: 0, branch_id: 0, name: "", item_tags: [], rate: 0.3, active: true, sort_order: 0 }}
            busy={busy} isNew onSave={(b) => create(b)} onCancel={() => setAdding(false)}
          />
        )}
      </div>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">แต่ละกลุ่มหัตถการ (เช่น ฉีดยา IM, เย็บแผล SUT) เพิ่มเป็นหัวข้อแยก ตั้ง % ของตัวเองได้</p>
        {!adding && <button type="button" className="btn-secondary text-xs" onClick={() => setAdding(true)}>+ เพิ่มหัวข้อ</button>}
      </div>
    </div>
  );
}

// Pick codes straight from an uploaded report (owner 2026-09-13): scan the file,
// tick which service codes count as DF, set a rate — no typing tag strings.
type DetectedTag = { tag: string; lines: number; bills: number; net: number; sample: string; currentRate: number | null };

function ScanPicker({ onApplied }: { onApplied: (rules: DfRule[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [detected, setDetected] = useState<DetectedTag[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ratePct, setRatePct] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function scan(file: File) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/scan"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "สแกนไฟล์ไม่สำเร็จ")); setDetected(null); return; }
      const tags = j.tags as DetectedTag[];
      setDetected(tags);
      // Pre-tick codes that already earn a fee; default others to 30%.
      const preSel = new Set<string>(); const rates: Record<string, string> = {};
      for (const t of tags) {
        rates[t.tag] = t.currentRate != null ? String(Math.round(t.currentRate * 1000) / 10) : "30";
        if (t.currentRate != null) preSel.add(t.tag);
      }
      setSel(preSel); setRatePct(rates);
    } catch { setErr("สแกนไฟล์ไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function apply() {
    const picks = [...sel].map((tag) => ({ tag, rate: Math.max(0, Math.min(1, (Number(ratePct[tag]) || 0) / 100)) }));
    if (picks.length === 0) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/rules/apply"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ picks })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "สร้างกฎไม่สำเร็จ")); return; }
      onApplied(j.rules as DfRule[]);
      setMsg(`ตั้งกฎจากที่เลือกแล้ว ${j.applied} รหัส`);
      setDetected(null); setSel(new Set());
    } catch { setErr("สร้างกฎไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  const toggle = (tag: string) => setSel((p) => { const n = new Set(p); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });

  return (
    <div className="rounded-lg border border-brand/30 bg-brand/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-medium text-slate-700">ตั้งค่าง่าย: เลือกรหัสจากไฟล์</div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) scan(f); e.target.value = ""; }} />
        <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy && !detected ? "กำลังสแกน…" : "สแกนโค้ดจากไฟล์"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500">อัปโหลดไฟล์ Invoice Report → ระบบลิสต์รหัสที่เจอทั้งหมด → ติ๊กรหัสที่จะคิด DF แล้วใส่เรท (ไฟล์นี้ใช้สแกนอย่างเดียว ไม่ได้บันทึกยอด)</p>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      {msg && <div className="text-xs text-emerald-600">{msg}</div>}

      {detected && (
        <div className="space-y-1.5">
          {detected.length === 0 && <div className="text-sm text-slate-400">ไม่พบรหัสในไฟล์</div>}
          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
            {detected.map((t) => (
              <label key={t.tag} className="flex items-center gap-2 py-1.5 text-sm cursor-pointer">
                <input type="checkbox" checked={sel.has(t.tag)} onChange={() => toggle(t.tag)} className="w-4 h-4 accent-brand" />
                <span className="font-medium text-slate-800 w-28 shrink-0">[{t.tag}]</span>
                <span className="text-[11px] text-slate-400 flex-1 min-w-0 truncate">
                  {t.lines} รายการ · {t.bills} บิล · ฿{fmtMoney(t.net)}
                  {t.currentRate != null && <span className="text-emerald-600"> · มีกฎแล้ว</span>}
                  <span className="block truncate text-slate-300">{t.sample}</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <input type="number" min={0} max={100} step="0.1" disabled={!sel.has(t.tag)}
                    className="input !py-1 !w-16 text-sm text-right disabled:opacity-40"
                    value={ratePct[t.tag] ?? "30"} onChange={(e) => setRatePct((p) => ({ ...p, [t.tag]: e.target.value }))} />
                  <span className="text-[11px] text-slate-400">%</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setDetected(null)}>ยกเลิก</button>
            <button type="button" className="btn btn-primary text-xs !py-1.5 disabled:opacity-40" disabled={busy || sel.size === 0} onClick={apply}>
              ตั้งกฎจากที่เลือก ({sel.size})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleRow({ rule, busy, isNew, onSave, onDelete, onCancel }: {
  rule: DfRule; busy: boolean; isNew?: boolean;
  onSave: (b: Record<string, unknown>) => void; onDelete?: () => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [tags, setTags] = useState(rule.item_tags.join(", "));
  const [ratePct, setRatePct] = useState(String(Math.round(rule.rate * 1000) / 10));
  const [active, setActive] = useState(rule.active);
  const parsedTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const dirty = name !== rule.name || tags !== rule.item_tags.join(", ")
    || Number(ratePct) !== Math.round(rule.rate * 1000) / 10 || active !== rule.active;
  const rateNum = Number(ratePct);
  const rateOk = ratePct.trim() !== "" && Number.isFinite(rateNum) && rateNum >= 0 && rateNum <= 100;
  const nameOk = name.trim().length > 0 && name.trim().length <= 160;
  const valid = nameOk && parsedTags.length > 0 && rateOk;
  const hint = !nameOk ? (name.trim() ? "ชื่อหัวข้อยาวเกิน 160 ตัวอักษร — ลองย่อให้สั้นลง" : "กรุณากรอกชื่อหัวข้อ")
    : parsedTags.length === 0 ? "กรุณากรอกรหัสอย่างน้อย 1 รหัส"
    : !rateOk ? "เรทต้องเป็นตัวเลข 0–100" : null;

  // A tidy responsive layout (owner 2026-09-13: the fixed narrow boxes looked
  // cramped). Fields on their own row — the ชื่อหัวข้อ box grows to fill; actions
  // on a second row so nothing wraps awkwardly.
  return (
    <div className={`border rounded-lg p-3 space-y-2.5 ${isNew ? "border-brand/40 bg-brand/5" : "border-slate-100"}`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[12rem]">
          <span className="text-[11px] text-slate-500">ชื่อหัวข้อ</span>
          <input className="input !py-1.5 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ฉีดยา (IM)" />
        </label>
        <label className="flex flex-col gap-1 w-40">
          <span className="text-[11px] text-slate-500">รหัส (คั่นด้วย ,)</span>
          <input className="input !py-1.5 text-sm" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="HSC, HSC-GRP" />
        </label>
        <label className="flex flex-col gap-1 w-24">
          <span className="text-[11px] text-slate-500">เรท %</span>
          <input type="number" min={0} max={100} step="0.1" className="input !py-1.5 text-sm text-right"
            value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4" />
          ใช้งาน
        </label>
        {dirty && hint && <span className="text-[11px] text-amber-600">{hint}</span>}
        <span className="flex-1" />
        {isNew
          ? <button type="button" className="btn-secondary text-xs !py-1.5" onClick={onCancel}>ยกเลิก</button>
          : onDelete && <button type="button" disabled={busy} className="text-xs text-rose-500 hover:text-rose-700" onClick={onDelete}>ลบ</button>}
        <button type="button" disabled={busy || !valid || (!isNew && !dirty)}
          className="btn btn-primary text-xs !py-1.5 disabled:opacity-40"
          onClick={() => onSave({
            name: name.trim(),
            item_tags: parsedTags,
            rate: Math.max(0, Math.min(1, Number(ratePct) / 100)),
            active
          })}>
          {isNew ? "เพิ่ม" : "บันทึก"}
        </button>
      </div>
    </div>
  );
}
