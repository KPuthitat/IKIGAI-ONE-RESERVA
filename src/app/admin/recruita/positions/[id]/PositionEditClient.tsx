"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import {
  parseCustomQuestions, type CustomQuestion, type CustomQuestionType
} from "@/lib/recruita";

type Position = {
  id: number;
  branch_id: number | null;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  jd_full: string | null;
  requirements: string | null;
  benefits: string | null;
  salary_min: number | null;
  salary_max: number | null;
  vacancies: number;
  custom_questions: string;
  status: "open" | "closed" | "draft";
};

type Branch = { id: number; name: string };
type PersonaTitle = { title: string; description: string | null };

/** Case-insensitive lookup against the PERSONA roster_positions
 *  catalogue — drives the "ใหม่ — ไม่มีใน PERSONA" badge so admin
 *  spots when they're introducing a brand-new title. */
function isExistingPersonaTitle(
  candidate: string,
  catalogue: PersonaTitle[]
): boolean {
  const needle = candidate.trim().toLowerCase();
  if (!needle) return false;
  return catalogue.some((p) => p.title.trim().toLowerCase() === needle);
}

/** Mint a stable 16-hex-char ID on the client. Using
 *  crypto.getRandomValues so it works in modern browsers without
 *  pulling Node crypto into the bundle. */
function newQuestionId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TYPE_LABEL: Record<CustomQuestionType, string> = {
  text: "ตอบสั้น (พิมพ์เอง)",
  single: "เลือก 1 ข้อ (radio)",
  multi: "เลือกได้หลายข้อ (checkbox)",
  rating: "ให้คะแนน (ดาว / ตัวเลข)",
  grid: "ตารางคำตอบ (แถว × คอลัมน์)"
};

export default function PositionEditClient({
  position, branches, personaTitles
}: {
  position: Position;
  branches: Branch[];
  personaTitles: PersonaTitle[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Basic fields
  const [title, setTitle] = useState(position.title);
  const [code, setCode] = useState(position.code ?? "");
  const [department, setDepartment] = useState(position.department ?? "");
  const [branchId, setBranchId] = useState(
    position.branch_id != null ? String(position.branch_id) : ""
  );
  const [employmentType, setEmploymentType] = useState(position.employment_type ?? "");
  const [salaryMin, setSalaryMin] = useState(
    position.salary_min != null ? String(position.salary_min) : ""
  );
  const [salaryMax, setSalaryMax] = useState(
    position.salary_max != null ? String(position.salary_max) : ""
  );
  const [vacancies, setVacancies] = useState(String(position.vacancies));
  const [jdSummary, setJdSummary] = useState(position.jd_summary ?? "");
  const [jdFull, setJdFull] = useState(position.jd_full ?? "");
  const [requirements, setRequirements] = useState(position.requirements ?? "");
  const [benefits, setBenefits] = useState(position.benefits ?? "");
  const [status, setStatus] = useState(position.status);

  // Custom questions
  const [questions, setQuestions] = useState<CustomQuestion[]>(
    parseCustomQuestions(position.custom_questions)
  );

  function addQuestion(type: CustomQuestionType) {
    const q: CustomQuestion = {
      id: newQuestionId(),
      order: questions.length * 10 + 10,
      required: false,
      type,
      label: "",
      hint: "",
      config: type === "single" || type === "multi"
        ? { options: [{ value: "opt1", label: "ตัวเลือก 1" }] }
        : type === "rating"
        ? { scale: 5, icon: "star" }
        : type === "grid"
        ? {
            rows: [{ value: "row1", label: "แถว 1" }],
            cols: [
              { value: "good", label: "ดี" },
              { value: "ok", label: "พอใช้" },
              { value: "bad", label: "ไม่ได้" }
            ]
          }
        : {}
    };
    setQuestions((prev) => [...prev, q]);
  }

  function updateQuestion(id: string, patch: Partial<CustomQuestion>) {
    setQuestions((prev) =>
      prev.map((q) => q.id === id ? { ...q, ...patch } : q)
    );
  }

  function deleteQuestion(id: string) {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  function moveQuestion(id: string, dir: "up" | "down") {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx < 0) return prev;
      const swapWith = dir === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next.map((q, i) => ({ ...q, order: (i + 1) * 10 }));
    });
  }

  async function save() {
    setErr(null); setMsg(null);
    if (!title.trim()) { setErr("กรุณาใส่ชื่อตำแหน่ง"); return; }
    const sMin = salaryMin ? Number(salaryMin) : null;
    const sMax = salaryMax ? Number(salaryMax) : null;
    if (sMin != null && sMax != null && sMax < sMin) {
      setErr("เงินเดือนสูงสุดต้องไม่น้อยกว่าต่ำสุด");
      return;
    }
    // Light validation of questions before sending
    for (const q of questions) {
      if (!q.label.trim()) {
        setErr(`คำถาม ID ${q.id.slice(0,6)} ยังไม่ได้ใส่ข้อความ`);
        return;
      }
      if ((q.type === "single" || q.type === "multi")
          && (!q.config?.options || q.config.options.length === 0)) {
        setErr(`คำถาม "${q.label}" ต้องมีตัวเลือกอย่างน้อย 1 ข้อ`);
        return;
      }
      if (q.type === "grid"
          && (!q.config?.rows?.length || !q.config?.cols?.length)) {
        setErr(`คำถาม "${q.label}" (ตาราง) ต้องมีอย่างน้อย 1 แถว 1 คอลัมน์`);
        return;
      }
    }

    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/positions/${position.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          code: code.trim() || null,
          department: department.trim() || null,
          branch_id: branchId ? Number(branchId) : null,
          employment_type: employmentType || null,
          salary_min: sMin,
          salary_max: sMax,
          vacancies: Number(vacancies) || 1,
          jd_summary: jdSummary.trim() || null,
          jd_full: jdFull.trim() || null,
          requirements: requirements.trim() || null,
          benefits: benefits.trim() || null,
          custom_questions: questions,
          status
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "บันทึกไม่สำเร็จ");
        return;
      }
      setMsg("✓ บันทึกแล้ว");
      startTransition(() => router.refresh());
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {/* Basic info */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">ข้อมูลพื้นฐาน</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label flex items-center justify-between">
              <span>ชื่อตำแหน่ง *</span>
              {title.trim() && (
                isExistingPersonaTitle(title, personaTitles) ? (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                    ✓ มีใน PERSONA
                  </span>
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                    ใหม่ — ไม่มีใน PERSONA
                  </span>
                )
              )}
            </label>
            <input className="input" value={title}
              list="recruita-edit-persona-titles"
              onChange={(e) => setTitle(e.target.value)} />
            {personaTitles.length > 0 && (
              <datalist id="recruita-edit-persona-titles">
                {personaTitles.map((p) => (
                  <option key={p.title} value={p.title}>
                    {p.description ? `— ${p.description}` : ""}
                  </option>
                ))}
              </datalist>
            )}
          </div>
          <div>
            <label className="label">รหัส</label>
            <input className="input uppercase tracking-wide font-bold"
              value={code} maxLength={20}
              onChange={(e) => setCode(e.target.value)}
              placeholder="เช่น RN-PT" />
          </div>
          <div>
            <label className="label">แผนก</label>
            <input className="input" value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="เช่น พยาบาล / ครัวร้อน / การตลาด" />
          </div>
          <div>
            <label className="label">สาขา</label>
            <select className="input" value={branchId}
              onChange={(e) => setBranchId(e.target.value)}>
              <option value="">— ทุกสาขา —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">รูปแบบงาน</label>
            <select className="input" value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value)}>
              <option value="">— ไม่ระบุ —</option>
              <option value="ft">Full-time</option>
              <option value="pt">Part-time</option>
              <option value="contract">Contract</option>
            </select>
          </div>
          <div>
            <label className="label">จำนวนที่เปิดรับ</label>
            <input className="input" type="number" min="0" value={vacancies}
              onChange={(e) => setVacancies(e.target.value)} />
          </div>
          <div>
            <label className="label">เงินเดือนต่ำสุด (฿)</label>
            <input className="input" type="number" min="0" value={salaryMin}
              onChange={(e) => setSalaryMin(e.target.value)} />
          </div>
          <div>
            <label className="label">เงินเดือนสูงสุด (฿)</label>
            <input className="input" type="number" min="0" value={salaryMax}
              onChange={(e) => setSalaryMax(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">สถานะ</label>
            <div className="flex gap-2">
              {(["draft", "open", "closed"] as const).map((s) => (
                <button key={s} type="button"
                  onClick={() => setStatus(s)}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold border ${
                    status === s
                      ? s === "open"
                        ? "bg-emerald-100 border-emerald-300 text-emerald-800"
                        : s === "draft"
                          ? "bg-slate-200 border-slate-300 text-slate-700"
                          : "bg-rose-100 border-rose-300 text-rose-700"
                      : "border-slate-200 text-slate-500"
                  }`}>
                  {s === "open" ? "เปิดรับ" : s === "draft" ? "ร่าง" : "ปิดแล้ว"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* JD content */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">รายละเอียดตำแหน่ง</h2>
        <div>
          <label className="label">สรุปสั้น (1 บรรทัด — แสดงในลิสต์)</label>
          <input className="input" value={jdSummary}
            onChange={(e) => setJdSummary(e.target.value)}
            placeholder="เช่น พยาบาลวิชาชีพประจำคลินิก @home Sriracha กะกลางวัน" />
        </div>
        <div>
          <label className="label">รายละเอียดเต็ม (Markdown ได้)</label>
          <textarea className="input" rows={6} value={jdFull}
            onChange={(e) => setJdFull(e.target.value)}
            placeholder="รายละเอียดงาน / หน้าที่ / สถานที่ทำงาน ฯลฯ" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">คุณสมบัติที่ต้องการ</label>
            <textarea className="input" rows={5} value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="- ปริญญาตรี พยาบาลศาสตร์&#10;- มีใบประกอบวิชาชีพ&#10;- อายุไม่เกิน 35" />
          </div>
          <div>
            <label className="label">สิทธิประโยชน์</label>
            <textarea className="input" rows={5} value={benefits}
              onChange={(e) => setBenefits(e.target.value)}
              placeholder="- ประกันสังคม&#10;- โบนัสปีละครั้ง&#10;- ชุดยูนิฟอร์ม" />
          </div>
        </div>
      </div>

      {/* Custom questions editor */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-bold text-slate-800 text-sm">
            คำถามเฉพาะตำแหน่ง
            <span className="ml-2 text-xs font-normal text-slate-400">
              ({questions.length} ข้อ)
            </span>
          </h2>
          <div className="flex flex-wrap gap-1">
            {(["text", "single", "multi", "rating", "grid"] as const).map((t) => (
              <button key={t} type="button"
                onClick={() => addQuestion(t)}
                className="text-[11px] px-2.5 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50">
                + {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          คำถามที่ผู้สมัครจะเห็นเพิ่มจากฟอร์มมาตรฐาน — ใช้ถามอะไรที่เฉพาะตำแหน่งนี้
          เช่น "หัตถการที่ทำได้" (สำหรับพยาบาล) หรือ "ประสบการณ์ครัว" (ครัวร้อน)
        </p>
        {questions.length === 0 && (
          <div className="text-xs text-slate-400 text-center py-6 border-2 border-dashed border-slate-200 rounded-lg">
            ยังไม่มีคำถามเพิ่มเติม — กดปุ่ม "+ ตอบสั้น" หรือประเภทอื่นด้านบนเพื่อเริ่ม
          </div>
        )}
        {questions.map((q, idx) => (
          <QuestionEditor key={q.id} q={q} idx={idx} total={questions.length}
            onChange={(patch) => updateQuestion(q.id, patch)}
            onDelete={() => deleteQuestion(q.id)}
            onMove={(dir) => moveQuestion(q.id, dir)} />
        ))}
      </div>

      {/* Save bar */}
      <div className="card flex items-center justify-between gap-3 sticky bottom-2 shadow-lg z-10">
        <div className="text-xs">
          {err && <span className="text-rose-600 font-bold">✗ {err}</span>}
          {msg && <span className="text-emerald-700 font-bold">{msg}</span>}
        </div>
        <button type="button" onClick={save} disabled={busy || !title.trim()}
          className="btn-primary disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "บันทึกการเปลี่ยนแปลง"}
        </button>
      </div>
    </div>
  );
}

// ── Question editor (one row) ──────────────────────────────────────
function QuestionEditor({
  q, idx, total, onChange, onDelete, onMove
}: {
  q: CustomQuestion;
  idx: number;
  total: number;
  onChange: (patch: Partial<CustomQuestion>) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const isFirst = idx === 0;
  const isLast = idx === total - 1;

  function updateConfig(patch: Partial<NonNullable<CustomQuestion["config"]>>) {
    onChange({ config: { ...(q.config ?? {}), ...patch } });
  }
  function updateOptions(options: NonNullable<NonNullable<CustomQuestion["config"]>["options"]>) {
    updateConfig({ options });
  }
  function updateRows(rows: NonNullable<NonNullable<CustomQuestion["config"]>["rows"]>) {
    updateConfig({ rows });
  }
  function updateCols(cols: NonNullable<NonNullable<CustomQuestion["config"]>["cols"]>) {
    updateConfig({ cols });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-0.5 flex-shrink-0 pt-1">
          <button type="button" onClick={() => onMove("up")} disabled={isFirst}
            className="w-7 h-6 rounded text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-30">▲</button>
          <button type="button" onClick={() => onMove("down")} disabled={isLast}
            className="w-7 h-6 rounded text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-30">▼</button>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-200 text-slate-700 px-2 py-0.5 rounded">
              {TYPE_LABEL[q.type]}
            </span>
            <label className="text-xs text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={q.required}
                onChange={(e) => onChange({ required: e.target.checked })} />
              บังคับตอบ
            </label>
          </div>
          <input className="input" value={q.label}
            placeholder="ข้อความคำถาม"
            onChange={(e) => onChange({ label: e.target.value })} />
          <input className="input text-sm" value={q.hint ?? ""}
            placeholder="คำอธิบาย (ไม่บังคับ)"
            onChange={(e) => onChange({ hint: e.target.value })} />

          {/* Type-specific config */}
          {q.type === "text" && (
            <label className="text-xs text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={!!q.config?.multiline}
                onChange={(e) => updateConfig({ multiline: e.target.checked })} />
              ตอบยาวหลายบรรทัด
            </label>
          )}

          {(q.type === "single" || q.type === "multi") && (
            <OptionsEditor options={q.config?.options ?? []}
              onChange={updateOptions} />
          )}
          {q.type === "multi" && (
            <label className="text-xs text-slate-600 flex items-center gap-1">
              <input type="checkbox" checked={!!q.config?.allow_other}
                onChange={(e) => updateConfig({ allow_other: e.target.checked })} />
              ให้เลือก "อื่นๆ" + พิมพ์เอง
            </label>
          )}

          {q.type === "rating" && (
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                ระดับ:
                <select className="input !w-20 !py-1 !px-2 text-xs"
                  value={String(q.config?.scale ?? 5)}
                  onChange={(e) => updateConfig({ scale: Number(e.target.value) })}>
                  {[3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
                    <option key={n} value={n}>{n} ระดับ</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                สัญลักษณ์:
                <select className="input !w-24 !py-1 !px-2 text-xs"
                  value={q.config?.icon ?? "star"}
                  onChange={(e) => updateConfig({ icon: e.target.value as "star" | "number" })}>
                  <option value="star">⭐ ดาว</option>
                  <option value="number">1 2 3 ตัวเลข</option>
                </select>
              </label>
            </div>
          )}

          {q.type === "grid" && (
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-600">แถว (สิ่งที่ถาม)</div>
              <OptionsEditor options={q.config?.rows ?? []}
                onChange={updateRows} placeholderHint="เช่น ภาษาไทย / ภาษาอังกฤษ" />
              <div className="text-xs font-bold text-slate-600 mt-2">คอลัมน์ (ระดับคำตอบ)</div>
              <OptionsEditor options={q.config?.cols ?? []}
                onChange={updateCols} placeholderHint="เช่น ดีมาก / ดี / พอใช้" />
            </div>
          )}
        </div>
        <button type="button" onClick={onDelete}
          className="text-xs text-rose-600 hover:underline flex-shrink-0 pt-1">
          ลบ
        </button>
      </div>
    </div>
  );
}

// ── Options editor (used by single/multi + grid rows/cols) ─────────
function OptionsEditor({
  options, onChange, placeholderHint
}: {
  options: Array<{ value: string; label: string }>;
  onChange: (next: Array<{ value: string; label: string }>) => void;
  placeholderHint?: string;
}) {
  function update(idx: number, label: string) {
    // Keep value stable — derive from label only when adding new
    const next = [...options];
    next[idx] = { ...next[idx], label };
    onChange(next);
  }
  function remove(idx: number) {
    onChange(options.filter((_, i) => i !== idx));
  }
  function add() {
    const n = options.length + 1;
    onChange([...options, { value: `opt${n}_${Date.now().toString(36).slice(-4)}`, label: `ตัวเลือก ${n}` }]);
  }
  return (
    <div className="space-y-1">
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-400 w-5 text-right">{i + 1}.</span>
          <input className="input flex-1 !py-1.5 text-sm" value={o.label}
            placeholder={placeholderHint}
            onChange={(e) => update(i, e.target.value)} />
          <button type="button" onClick={() => remove(i)}
            disabled={options.length <= 1}
            className="text-[10px] text-rose-500 hover:underline disabled:opacity-30 px-1">
            ลบ
          </button>
        </div>
      ))}
      <button type="button" onClick={add}
        className="text-[11px] text-brand hover:underline ml-7">
        + เพิ่มตัวเลือก
      </button>
    </div>
  );
}
