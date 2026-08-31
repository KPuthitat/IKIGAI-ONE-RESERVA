"use client";

import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import type { DfComputeResult, DfRule, DfDoctor } from "@/lib/df-db";

type Span = { min: string | null; max: string | null; count: number };

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00+07:00`);
  return d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
}
function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    start: `${y}-${String(m).padStart(2, "0")}-01`,
    end: `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`
  };
}
// Monday–Sunday week containing `date`.
function weekBounds(date: string): { start: string; end: string } {
  const d = new Date(`${date}T00:00:00+07:00`);
  const dow = (d.getDay() + 6) % 7;                 // 0 = Monday
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { start: iso(mon), end: iso(sun) };
}

export default function DoctorFeeClient({
  initialStart, initialEnd, initialResult, initialRules, span, eligibleDoctors
}: {
  initialStart: string;
  initialEnd: string;
  initialResult: DfComputeResult;
  initialRules: DfRule[];
  span: Span;
  eligibleDoctors: DfDoctor[];
}) {
  const router = useRouter();
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [result, setResult] = useState<DfComputeResult>(initialResult);
  const [rules, setRules] = useState<DfRule[]>(initialRules);
  const [mode, setMode] = useState<"month" | "week" | "custom">("month");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadCompute(s: string, e: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/doctor-fee?start=${s}&end=${e}`));
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "คำนวณไม่สำเร็จ")); return; }
      setResult(j.result as DfComputeResult);
      setRules(j.rules as DfRule[]);
    } catch { setErr("คำนวณไม่สำเร็จ ลองใหม่อีกครั้ง"); }
    finally { setBusy(false); }
  }

  function applyRange(s: string, e: string) {
    setStart(s); setEnd(e); loadCompute(s, e);
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr("เลือกไฟล์ Invoice Report (.xlsx) ก่อน"); return; }
    setBusy(true); setErr(null); setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "นำเข้าไฟล์ไม่สำเร็จ")); return; }
      setUploadMsg(`นำเข้าสำเร็จ: ใหม่ ${j.inserted} · อัปเดต ${j.updated} · รวม ${j.total} บรรทัด (${j.periodStart} – ${j.periodEnd})`);
      if (fileRef.current) fileRef.current.value = "";
      // Jump the period to the imported month and recompute.
      if (j.periodStart && j.periodEnd) {
        const mb = monthBounds(j.periodStart.slice(0, 7));
        setMode("month"); setStart(mb.start); setEnd(mb.end);
        await loadCompute(mb.start, mb.end);
      } else {
        await loadCompute(start, end);
      }
      router.refresh();
    } catch { setErr("นำเข้าไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง"); }
    finally { setBusy(false); }
  }

  function toggleDoctor(uid: number) {
    setOpen((p) => { const n = new Set(p); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  }

  const tiles = [
    { label: "ยอด HSC รวม (ฐาน)", value: result.totalPool, tone: "text-slate-800" },
    { label: "ค่าตอบแทนรวม", value: result.totalFee, tone: "text-violet-700" },
    { label: "จ่ายให้แพทย์", value: result.assignedFee, tone: "text-emerald-700" },
    { label: "ยังไม่ระบุแพทย์", value: result.unassignedFee, tone: result.unassignedFee > 0 ? "text-amber-700" : "text-slate-400" }
  ];

  return (
    <div className="space-y-4">
      {/* Import */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-700">1) นำเข้าไฟล์ยอดขายคลินิก (Invoice Report .xlsx)</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            className="text-sm file:mr-3 file:rounded-full file:border-0 file:bg-brand file:text-white file:px-4 file:py-2 file:text-sm" />
          <button type="button" className="btn btn-primary text-sm" onClick={upload} disabled={busy}>
            {busy ? "กำลังนำเข้า…" : "นำเข้า"}
          </button>
          {span.count > 0 && (
            <span className="text-[11px] text-slate-400">
              มีข้อมูลแล้ว {span.count} บรรทัด ({span.min} – {span.max})
            </span>
          )}
        </div>
        {uploadMsg && <div className="text-xs text-emerald-700">{uploadMsg}</div>}
        <p className="text-[11px] text-slate-400">
          ระบบดึงเฉพาะบรรทัดที่ตรงรหัสในกฎด้านล่าง (เช่น HSC, HSC-GRP) · นำเข้าไฟล์เดิมซ้ำได้ ระบบจะอัปเดตทับให้เอง
        </p>
      </div>

      {/* Rules */}
      <RulesEditor rules={rules} onChange={setRules} onSaved={() => loadCompute(start, end)} />

      {/* Period */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-700">3) เลือกงวด</h2>
        <div className="flex flex-wrap items-center gap-2">
          {(["month", "week", "custom"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                mode === m ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
              {m === "month" ? "รายเดือน" : m === "week" ? "รายสัปดาห์" : "กำหนดเอง"}
            </button>
          ))}
          {mode === "month" && (
            <input type="month" className="input !py-1.5 !w-auto text-sm" value={start.slice(0, 7)}
              onChange={(e) => { const mb = monthBounds(e.target.value); applyRange(mb.start, mb.end); }} />
          )}
          {mode === "week" && (
            <input type="date" className="input !py-1.5 !w-auto text-sm" value={start}
              onChange={(e) => { const wb = weekBounds(e.target.value); applyRange(wb.start, wb.end); }} />
          )}
          {mode === "custom" && (
            <span className="flex items-center gap-1.5 text-sm">
              <input type="date" className="input !py-1.5 !w-auto text-sm" value={start} onChange={(e) => setStart(e.target.value)} />
              <span className="text-slate-400">–</span>
              <input type="date" className="input !py-1.5 !w-auto text-sm" value={end} onChange={(e) => setEnd(e.target.value)} />
              <button type="button" className="btn-secondary text-xs" onClick={() => loadCompute(start, end)}>คำนวณ</button>
            </span>
          )}
          <span className="text-[11px] text-slate-400">{start} – {end}</span>
        </div>
      </div>

      {err && <div className="card !py-3 text-sm text-rose-600">{err}</div>}

      {/* Result tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="card !p-4">
            <div className="text-xs text-slate-500">{t.label}</div>
            <div className={`text-2xl font-bold tabular-nums mt-1 ${t.tone}`}>฿{fmtMoney(t.value)}</div>
          </div>
        ))}
      </div>

      {/* Rule breakdown */}
      {result.rules.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-2 text-sm">ที่มาของยอด</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-1.5 pr-3">กฎ</th>
                <th className="py-1.5 pr-3">รหัส</th>
                <th className="py-1.5 pr-3 text-right">เรท</th>
                <th className="py-1.5 pr-3 text-right">ฐานยอด</th>
                <th className="py-1.5 pr-3 text-right">ค่าตอบแทน</th>
              </tr>
            </thead>
            <tbody>
              {result.rules.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3">{r.name}</td>
                  <td className="py-1.5 pr-3 text-slate-500">{r.tags.join(", ")}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{pct(r.rate)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">฿{fmtMoney(r.pool)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-violet-700">฿{fmtMoney(r.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-doctor */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-1">ค่าตอบแทนรายแพทย์</h2>
        <p className="text-[11px] text-slate-400 mb-3">แบ่งตามวันที่แพทย์อยู่เวร · วันที่มีหมอหลายคน หารเท่ากัน · กดชื่อเพื่อดูรายวัน</p>
        {result.doctors.length === 0 ? (
          <div className="text-sm text-slate-400 py-2">
            {result.totalFee === 0
              ? "ไม่มียอด HSC ในงวดนี้ — นำเข้าไฟล์ก่อน หรือเลือกงวดที่มีข้อมูล"
              : !result.hasRoster
                ? "มียอด HSC แต่ยังไม่มีแพทย์ในตารางเวรของงวดนี้ — จัดเวรแพทย์ก่อน แล้วคำนวณใหม่"
                : "ยอดทั้งหมดตกอยู่ในวันที่ไม่มีแพทย์อยู่เวร (ดูด้านล่าง)"}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">แพทย์</th>
                <th className="py-2 pr-3 text-right">วันเวร (มียอด)</th>
                <th className="py-2 pr-3 text-right">ค่าตอบแทน</th>
              </tr>
            </thead>
            <tbody>
              {result.doctors.map((doc) => {
                const isOpen = open.has(doc.user_id);
                return (
                  <Fragment key={doc.user_id}>
                    <tr className="border-b border-slate-100 hover:bg-slate-50/60">
                      <td className="py-2 pr-3">
                        <button type="button" onClick={() => toggleDoctor(doc.user_id)} className="flex items-center gap-1.5 text-left group">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                            className={`text-slate-400 group-hover:text-brand transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                            <path d="M9 6l6 6-6 6" />
                          </svg>
                          <span className="font-medium text-slate-800 group-hover:text-brand">{nameWithPrefix(doc.title_prefix, doc.display_name)}</span>
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{doc.workedDays}</td>
                      <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">฿{fmtMoney(doc.totalFee)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-violet-50/30">
                        <td colSpan={3} className="px-3 py-2">
                          <table className="w-full text-[12.5px]">
                            <thead>
                              <tr className="text-[11px] text-slate-400 border-b border-slate-100">
                                <th className="py-1 pr-3 text-left">วันที่</th>
                                <th className="py-1 pr-3 text-right">ยอด HSC วันนั้น</th>
                                <th className="py-1 pr-3 text-right">หมอในวัน</th>
                                <th className="py-1 pr-3 text-right">ส่วนของหมอคนนี้</th>
                              </tr>
                            </thead>
                            <tbody>
                              {doc.days.map((d) => (
                                <tr key={d.date} className="border-b border-slate-50 last:border-0">
                                  <td className="py-1 pr-3 whitespace-nowrap text-slate-700">{fmtDay(d.date)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-slate-500">฿{fmtMoney(d.dayPool)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-slate-500">{d.doctorCount > 1 ? `หาร ${d.doctorCount}` : "1"}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums font-medium text-emerald-700">฿{fmtMoney(d.share)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium">
                <td className="py-2 pr-3">รวมจ่ายให้แพทย์</td>
                <td></td>
                <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">฿{fmtMoney(result.assignedFee)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Unassigned days */}
      {result.unassignedDays.length > 0 && (
        <div className="card border-amber-200">
          <h2 className="font-semibold text-amber-800 mb-1 text-sm">⚠︎ วันที่มียอดแต่ไม่มีแพทย์อยู่เวร ({result.unassignedDays.length} วัน)</h2>
          <p className="text-[11px] text-amber-700/80 mb-2">ยอดรวม ฿{fmtMoney(result.unassignedFee)} ยังไม่ถูกจ่ายให้ใคร — ถ้าควรจ่าย ให้จัดเวรแพทย์ในวันเหล่านี้แล้วคำนวณใหม่</p>
          <div className="flex flex-wrap gap-1.5">
            {result.unassignedDays.map((u) => (
              <span key={u.date} className="text-[11px] px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800">
                {fmtDay(u.date)} · ฿{fmtMoney(u.fee)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Rules editor ──────────────────────────────────────────────────

function RulesEditor({ rules, onChange, onSaved }: {
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
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "เพิ่มกฎไม่สำเร็จ")); return; }
      onChange(j.rules as DfRule[]);
      setAdding(false);
      onSaved();
    } catch { setErr("เพิ่มกฎไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold text-slate-700">2) กฎค่าตอบแทน (รหัส × เรท)</h2>
      <div className="space-y-2">
        {rules.map((r) => (
          <RuleRow key={r.id} rule={r} busy={busy} onSave={(b) => patch(r.id, b)} onDelete={() => remove(r.id)} />
        ))}
        {rules.length === 0 && <div className="text-sm text-slate-400">ยังไม่มีกฎ — กด “+ เพิ่มกฎ” เพื่อสร้าง เช่น HSC 30%</div>}
        {adding && (
          <RuleRow
            rule={{ id: 0, branch_id: 0, name: "", item_tags: [], rate: 0.3, active: true, sort_order: 0 }}
            busy={busy} isNew onSave={(b) => create(b)} onCancel={() => setAdding(false)}
          />
        )}
      </div>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">แต่ละกลุ่มหัตถการ (เช่น ฉีดยา IM, เย็บแผล SUT) ใส่เป็นกฎแยก ตั้ง % ของตัวเองได้</p>
        {!adding && <button type="button" className="btn-secondary text-xs" onClick={() => setAdding(true)}>+ เพิ่มกฎ</button>}
      </div>
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
  const valid = name.trim().length > 0 && parsedTags.length > 0 && ratePct !== "";

  return (
    <div className={`flex flex-wrap items-end gap-2 border rounded-lg p-2.5 ${isNew ? "border-brand/40 bg-brand/5" : "border-slate-100"}`}>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-slate-500">ชื่อกฎ</span>
        <input className="input !py-1.5 !w-40 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ฉีดยา (IM)" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-slate-500">รหัส (คั่นด้วย ,)</span>
        <input className="input !py-1.5 !w-44 text-sm" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="HSC, HSC-GRP" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-slate-500">เรท %</span>
        <input type="number" min={0} max={100} step="0.1" className="input !py-1.5 !w-20 text-sm text-right"
          value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
      </label>
      <label className="flex items-center gap-1.5 text-sm pb-1.5">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4" />
        ใช้งาน
      </label>
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
      {isNew
        ? <button type="button" className="btn-secondary text-xs !py-1.5" onClick={onCancel}>ยกเลิก</button>
        : onDelete && <button type="button" disabled={busy} className="text-xs text-rose-500 hover:text-rose-700 pb-1.5" onClick={onDelete}>ลบ</button>}
    </div>
  );
}
