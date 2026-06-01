"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import type { CustomQuestion } from "@/lib/recruita";
import "@/lib/liff-types";

// Public application form — owner's existing Google Form ported to
// our own pipeline, plus the per-position custom_questions admin
// defined. Single long page (not multi-step) so the applicant can
// scroll back and forth; localStorage saves a draft on every change
// so a browser refresh doesn't lose progress.

const DRAFT_KEY_PREFIX = "recruita_draft_";

type EducationRow = {
  level: string;
  institution: string;
  faculty: string;
  major: string;
  year_finished: string;
  gpa: string;
};

type ExperienceRow = {
  company: string;
  position: string;
  started: string;
  ended: string;
  salary: string;
  reason_left: string;
};

type LanguageRow = { language: string; level: string };

type ReferenceRow = { name: string; relationship: string; phone: string };

type FormState = {
  // PDPA
  pdpa_consent: boolean;
  // Identity
  title_prefix: string;
  first_name_th: string;
  last_name_th: string;
  first_name_en: string;
  last_name_en: string;
  nickname_th: string;
  dob: string;
  gender: string;
  nationality: string;
  race: string;
  marital_status: string;
  military_status: string;
  religion: string;
  national_id: string;
  // Contact
  personal_email: string;
  mobile_phone: string;
  line_id: string;
  house_address: string;
  housing_type: string;
  // History
  education: EducationRow[];
  professional_license_status: string;
  experience: ExperienceRow[];
  // Skills
  skills_language: LanguageRow[];
  skills_other: string;
  introduction: string;
  // References
  emergency_name: string;
  emergency_relationship: string;
  emergency_phone: string;
  referee_external_text: string;
  // Application-level
  expected_salary: string;
  earliest_start_date: string;
  goals: string;
  why_join: string;
  info_source: string;
  can_travel: string;
  prior_illness: string;
  prior_illness_detail: string;
  prior_application_at: string;
  truth_declaration_accepted: boolean;
  // Custom answers — keyed by question.id
  custom: Record<string, unknown>;
};

const EMPTY_EDU: EducationRow = {
  level: "", institution: "", faculty: "", major: "", year_finished: "", gpa: ""
};
const EMPTY_EXP: ExperienceRow = {
  company: "", position: "", started: "", ended: "", salary: "", reason_left: ""
};
const EMPTY_LANG: LanguageRow = { language: "", level: "" };
const EMPTY_REF: ReferenceRow = { name: "", relationship: "", phone: "" };

function blankState(): FormState {
  return {
    pdpa_consent: false,
    title_prefix: "", first_name_th: "", last_name_th: "",
    first_name_en: "", last_name_en: "", nickname_th: "",
    dob: "", gender: "", nationality: "ไทย", race: "",
    marital_status: "", military_status: "", religion: "",
    national_id: "",
    personal_email: "", mobile_phone: "", line_id: "",
    house_address: "", housing_type: "",
    education: [{ ...EMPTY_EDU }],
    professional_license_status: "",
    experience: [{ ...EMPTY_EXP }],
    skills_language: [{ ...EMPTY_LANG, language: "ไทย", level: "native" }],
    skills_other: "",
    introduction: "",
    emergency_name: "", emergency_relationship: "", emergency_phone: "",
    referee_external_text: "",
    expected_salary: "", earliest_start_date: "",
    goals: "", why_join: "",
    info_source: "",
    can_travel: "",
    prior_illness: "",
    prior_illness_detail: "",
    prior_application_at: "",
    truth_declaration_accepted: false,
    custom: {}
  };
}

export default function ApplyClient({
  positionId, positionTitle, positionCode, branchName, department,
  customQuestions, liffId
}: {
  positionId: number;
  positionTitle: string;
  positionCode: string | null;
  branchName: string | null;
  department: string | null;
  customQuestions: CustomQuestion[];
  liffId: string | null;
}) {
  const router = useRouter();
  const draftKey = `${DRAFT_KEY_PREFIX}${positionId}`;
  const [f, setF] = useState<FormState>(blankState);
  const [photo, setPhoto] = useState<File | null>(null);
  const [resume, setResume] = useState<File | null>(null);
  const [idCopy, setIdCopy] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const draftLoaded = useRef(false);
  // LINE userId captured by the LIFF SDK on mount. Sent with the
  // submission so the candidate row links to their LINE account
  // and the stage-change push reaches them. Null on web-form
  // applicants and when LIFF init fails (gracefully degrades).
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const liffReady = useRef(false);

  async function initLiff() {
    if (!liffId || liffReady.current) return;
    liffReady.current = true;

    // ── Safety guards — don't trigger LIFF OAuth unless we're SURE
    //    we entered through a LIFF URL. The old version called
    //    liff.init() unconditionally, which on internal Next.js
    //    navigation (e.g. user clicked a position link from
    //    /recruita/positions, landing here without liff.state) made
    //    the SDK redirect to access.line.me to re-establish auth
    //    context — and that redirect returned 400 because there was
    //    no fresh OAuth grant to consume. Net result: "page loads
    //    briefly then 400" reported by the owner 2026-06-01.
    //
    //    Two guards, both must pass:
    //      a) UA contains "Line/" — page is open inside LINE's
    //         in-app browser (not Safari/Chrome).
    //      b) URL still carries liff.state — we are the FIRST page
    //         after the liff.line.me hop, not a soft-nav target.
    //
    //    Failing either guard means it's safer to render the form
    //    as a plain web form. The candidate still gets bound to
    //    their LINE userId later via the recency-link path in the
    //    webhook (matching applications submitted within 24h of
    //    them adding the OA as a friend).
    const inLineApp = /Line\/[\d.]+/i.test(navigator.userAgent);
    if (!inLineApp) return;
    if (!window.location.search.includes("liff.state")) return;

    try {
      const w = window as unknown as { liff?: { init: (a: { liffId: string }) => Promise<void>; isLoggedIn: () => boolean; login: () => void; getProfile: () => Promise<{ userId: string }>; getContext?: () => { type?: string } | null } };
      if (!w.liff) return;
      await w.liff.init({ liffId });
      if (!w.liff.isLoggedIn()) return;
      const profile = await w.liff.getProfile();
      if (profile?.userId) setLineUserId(profile.userId);
    } catch (e) {
      console.warn("[recruita] LIFF init failed:", e);
    }
  }

  // Load draft on mount
  useEffect(() => {
    if (draftLoaded.current) return;
    draftLoaded.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        setF((prev) => ({ ...prev, ...parsed }));
      }
    } catch { /* ignore corrupt draft */ }
  }, [draftKey]);

  // Save draft on every change (debounced via animation frame)
  useEffect(() => {
    if (!draftLoaded.current) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify(f)); }
      catch { /* quota exceeded — ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [f, draftKey]);

  function up<K extends keyof FormState>(k: K, v: FormState[K]) {
    setF((p) => ({ ...p, [k]: v }));
  }
  function upCustom(qid: string, v: unknown) {
    setF((p) => ({ ...p, custom: { ...p.custom, [qid]: v } }));
  }

  // Row helpers
  function addEdu()   { up("education",      [...f.education,      { ...EMPTY_EDU }]); }
  function delEdu(i: number)   { up("education",      f.education.filter((_, idx) => idx !== i)); }
  function setEdu(i: number, patch: Partial<EducationRow>) {
    up("education", f.education.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function addExp()   { up("experience",     [...f.experience,     { ...EMPTY_EXP }]); }
  function delExp(i: number)   { up("experience",     f.experience.filter((_, idx) => idx !== i)); }
  function setExp(i: number, patch: Partial<ExperienceRow>) {
    up("experience", f.experience.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function addLang()  { up("skills_language", [...f.skills_language, { ...EMPTY_LANG }]); }
  function delLang(i: number)  { up("skills_language", f.skills_language.filter((_, idx) => idx !== i)); }
  function setLang(i: number, patch: Partial<LanguageRow>) {
    up("skills_language", f.skills_language.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }

  // Submit
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    // Quick gating — PDPA + truth declaration + key identity
    if (!f.pdpa_consent) { setErr("กรุณายินยอมนโยบายคุ้มครองข้อมูลส่วนบุคคลก่อนส่งใบสมัคร"); return; }
    if (!f.truth_declaration_accepted) { setErr("กรุณายืนยันรับรองความถูกต้องของข้อมูล"); return; }
    if (!f.first_name_th.trim() || !f.last_name_th.trim()) { setErr("กรุณากรอกชื่อ-นามสกุล (ภาษาไทย)"); return; }
    if (!f.mobile_phone.trim()) { setErr("กรุณากรอกเบอร์โทรศัพท์มือถือ"); return; }
    // Required custom questions
    for (const q of customQuestions) {
      if (!q.required) continue;
      const ans = f.custom[q.id];
      const empty = ans == null
        || (typeof ans === "string" && !ans.trim())
        || (Array.isArray(ans) && ans.length === 0)
        || (typeof ans === "object" && ans !== null && Object.keys(ans).length === 0);
      if (empty) { setErr(`กรุณาตอบ: ${q.label}`); return; }
    }

    setBusy(true);
    try {
      // Build multipart form data so we can carry files + JSON in
      // one round-trip. Server reads via request.formData().
      const fd = new FormData();
      fd.append("payload", JSON.stringify({
        position_id: positionId,
        ...f,
        // LIFF-detected LINE userId (null on plain web form). Server
        // links the candidate row when present.
        line_user_id: lineUserId,
      }));
      if (photo)  fd.append("photo", photo);
      if (resume) fd.append("resume", resume);
      if (idCopy) fd.append("id_copy", idCopy);

      const res = await fetch(apiUrl("/api/recruita/applications"), {
        method: "POST",
        body: fd
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "ส่งใบสมัครไม่สำเร็จ");
        return;
      }
      // Clear draft on success
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      router.push(`/recruita/apply/${positionId}/thanks?aid=${j.application_id}`);
    } catch {
      setErr("เกิดข้อผิดพลาดในการส่งใบสมัคร กรุณาลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* LIFF SDK — loads only when liffId is set. onLoad fires
          initLiff which captures profile.userId silently. */}
      {liffId && (
        <Script src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={initLiff} />
      )}

      {/* Tiny info badge when LIFF binding is active */}
      {lineUserId && (
        <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 text-center">
          🔗 ผูก LINE สำเร็จ — เราจะแจ้งสถานะใบสมัครให้คุณผ่าน LINE
        </div>
      )}

      {/* Header */}
      <div className="card text-center space-y-2">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-[2px]">
          ใบสมัครงาน
        </div>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {positionCode && (
            <span className="text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
              {positionCode}
            </span>
          )}
          <h1 className="text-xl font-bold text-slate-800">{positionTitle}</h1>
        </div>
        <div className="text-xs text-slate-500">
          {[branchName, department].filter(Boolean).join(" · ")}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          ระบบบันทึกร่างอัตโนมัติ — รีเฟรชหน้าได้ ข้อมูลจะไม่หาย
        </p>
      </div>

      {/* Section 1 — PDPA */}
      <Section title="1. นโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA)">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-slate-700 leading-relaxed">
          ข้อมูลของท่านจะถูกเก็บรักษาเป็นความลับ ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562
          โดยกลุ่มบริษัท อิคิไก ฟอร์ออล จะไม่เก็บ/ใช้/เปิดเผยข้อมูลใดๆ ก่อนได้รับความยินยอม
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1 flex-shrink-0"
            checked={f.pdpa_consent}
            onChange={(e) => up("pdpa_consent", e.target.checked)} />
          <span>
            <b>ยินยอม</b> ให้บริษัทเก็บรวบรวม ใช้ และเปิดเผยข้อมูลส่วนบุคคลตามวัตถุประสงค์ที่ระบุ
          </span>
        </label>
      </Section>

      {/* Section 2 — Personal */}
      <Section title="2. ข้อมูลส่วนตัว">
        <Grid2>
          <Field label="คำนำหน้า *">
            <select className="input" value={f.title_prefix}
              onChange={(e) => up("title_prefix", e.target.value)}>
              <option value="">—</option>
              <option value="นาย">นาย</option>
              <option value="นางสาว">นางสาว</option>
              <option value="นาง">นาง</option>
            </select>
          </Field>
          <Field label="เพศ *">
            <select className="input" value={f.gender}
              onChange={(e) => up("gender", e.target.value)}>
              <option value="">—</option>
              <option value="male">ชาย</option>
              <option value="female">หญิง</option>
              <option value="other">อื่นๆ</option>
            </select>
          </Field>
          <Field label="ชื่อจริง (ไทย) *">
            <input className="input" value={f.first_name_th}
              onChange={(e) => up("first_name_th", e.target.value)} />
          </Field>
          <Field label="นามสกุล (ไทย) *">
            <input className="input" value={f.last_name_th}
              onChange={(e) => up("last_name_th", e.target.value)} />
          </Field>
          <Field label="First name (EN)">
            <input className="input" value={f.first_name_en}
              onChange={(e) => up("first_name_en", e.target.value)} />
          </Field>
          <Field label="Last name (EN)">
            <input className="input" value={f.last_name_en}
              onChange={(e) => up("last_name_en", e.target.value)} />
          </Field>
          <Field label="ชื่อเล่น">
            <input className="input" value={f.nickname_th}
              onChange={(e) => up("nickname_th", e.target.value)} />
          </Field>
          <Field label="วัน/เดือน/ปี เกิด *">
            <input className="input" type="date" value={f.dob}
              onChange={(e) => up("dob", e.target.value)} />
          </Field>
          <Field label="สัญชาติ *">
            <input className="input" value={f.nationality}
              onChange={(e) => up("nationality", e.target.value)} />
          </Field>
          <Field label="เชื้อชาติ">
            <input className="input" value={f.race}
              onChange={(e) => up("race", e.target.value)} />
          </Field>
          <Field label="ศาสนา">
            <input className="input" value={f.religion}
              onChange={(e) => up("religion", e.target.value)} />
          </Field>
          <Field label="สถานภาพ">
            <select className="input" value={f.marital_status}
              onChange={(e) => up("marital_status", e.target.value)}>
              <option value="">—</option>
              <option value="single">โสด</option>
              <option value="married">สมรส</option>
              <option value="divorced">หย่าร้าง</option>
              <option value="widowed">หม้าย</option>
            </select>
          </Field>
          {f.gender === "male" && (
            <Field label="ภาวะทางทหาร">
              <select className="input" value={f.military_status}
                onChange={(e) => up("military_status", e.target.value)}>
                <option value="">—</option>
                <option value="exempt">ได้รับการยกเว้น</option>
                <option value="reservist">ปลดเป็นทหารกองหนุน</option>
                <option value="pending">ยังไม่ได้รับการเกณฑ์</option>
              </select>
            </Field>
          )}
          <Field label="เลขบัตรประจำตัวประชาชน *"
            hint="เข้ารหัสในระบบ (PDPA)">
            <input className="input" inputMode="numeric"
              maxLength={13} value={f.national_id}
              onChange={(e) => up("national_id", e.target.value.replace(/\D/g, ""))} />
          </Field>
        </Grid2>
      </Section>

      {/* Section 3 — Contact */}
      <Section title="3. ติดต่อ">
        <Grid2>
          <Field label="เบอร์โทรศัพท์มือถือ *">
            <input className="input" type="tel" value={f.mobile_phone}
              onChange={(e) => up("mobile_phone", e.target.value)} />
          </Field>
          <Field label="อีเมล">
            <input className="input" type="email" value={f.personal_email}
              onChange={(e) => up("personal_email", e.target.value)} />
          </Field>
          <Field label="LINE ID">
            <input className="input" value={f.line_id}
              onChange={(e) => up("line_id", e.target.value)} />
          </Field>
          <Field label="ลักษณะที่อยู่">
            <select className="input" value={f.housing_type}
              onChange={(e) => up("housing_type", e.target.value)}>
              <option value="">—</option>
              <option value="family">อาศัยกับครอบครัว</option>
              <option value="own_home">บ้านตัวเอง</option>
              <option value="rental">บ้านเช่า</option>
              <option value="dormitory">หอพัก</option>
              <option value="other">อื่นๆ</option>
            </select>
          </Field>
        </Grid2>
        <Field label="ที่อยู่ปัจจุบัน *">
          <textarea className="input" rows={2} value={f.house_address}
            onChange={(e) => up("house_address", e.target.value)} />
        </Field>
      </Section>

      {/* Section 4 — Education */}
      <Section title="4. ประวัติการศึกษา">
        {f.education.map((row, i) => (
          <div key={i} className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">รายการที่ {i + 1}</span>
              {f.education.length > 1 && (
                <button type="button" onClick={() => delEdu(i)}
                  className="text-xs text-rose-600 hover:underline">ลบ</button>
              )}
            </div>
            <Grid2>
              <Field label="ระดับ">
                <select className="input" value={row.level}
                  onChange={(e) => setEdu(i, { level: e.target.value })}>
                  <option value="">—</option>
                  <option value="high_school">มัธยมศึกษาตอนปลาย</option>
                  <option value="vocational">ปวช.</option>
                  <option value="diploma">ปวส.</option>
                  <option value="bachelor">ปริญญาตรี</option>
                  <option value="master">ปริญญาโท</option>
                  <option value="phd">ปริญญาเอก</option>
                </select>
              </Field>
              <Field label="ปีที่จบ">
                <input className="input" value={row.year_finished}
                  onChange={(e) => setEdu(i, { year_finished: e.target.value })}
                  placeholder="เช่น 2566" />
              </Field>
              <Field label="สถาบัน">
                <input className="input" value={row.institution}
                  onChange={(e) => setEdu(i, { institution: e.target.value })} />
              </Field>
              <Field label="คณะ">
                <input className="input" value={row.faculty}
                  onChange={(e) => setEdu(i, { faculty: e.target.value })} />
              </Field>
              <Field label="สาขาวิชา">
                <input className="input" value={row.major}
                  onChange={(e) => setEdu(i, { major: e.target.value })} />
              </Field>
              <Field label="เกรดเฉลี่ย">
                <input className="input" value={row.gpa}
                  onChange={(e) => setEdu(i, { gpa: e.target.value })} />
              </Field>
            </Grid2>
          </div>
        ))}
        <button type="button" onClick={addEdu}
          className="text-xs text-brand hover:underline">+ เพิ่มประวัติการศึกษา</button>

        <Field label="มีใบประกอบวิชาชีพหรือไม่ (พยาบาล/เทคนิคการแพทย์/สาธารณสุข)"
          hint="เฉพาะตำแหน่งที่ต้องใช้ใบประกอบ">
          <select className="input" value={f.professional_license_status}
            onChange={(e) => up("professional_license_status", e.target.value)}>
            <option value="">—</option>
            <option value="has_license">มีใบประกอบวิชาชีพ</option>
            <option value="no_license">ไม่มีใบประกอบวิชาชีพ</option>
            <option value="not_applicable">ไม่ได้สมัครตำแหน่งดังกล่าว</option>
          </select>
        </Field>
      </Section>

      {/* Section 5 — Experience */}
      <Section title="5. ประสบการณ์การทำงาน">
        {f.experience.map((row, i) => (
          <div key={i} className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">งานล่าสุดที่ {i + 1}</span>
              {f.experience.length > 1 && (
                <button type="button" onClick={() => delExp(i)}
                  className="text-xs text-rose-600 hover:underline">ลบ</button>
              )}
            </div>
            <Grid2>
              <Field label="ชื่อบริษัท/สถานที่"><input className="input" value={row.company}
                onChange={(e) => setExp(i, { company: e.target.value })} /></Field>
              <Field label="ตำแหน่ง"><input className="input" value={row.position}
                onChange={(e) => setExp(i, { position: e.target.value })} /></Field>
              <Field label="เริ่มงาน (ปี/เดือน)"><input className="input" value={row.started}
                onChange={(e) => setExp(i, { started: e.target.value })}
                placeholder="เช่น 2564/05" /></Field>
              <Field label="ออกจากงาน"><input className="input" value={row.ended}
                onChange={(e) => setExp(i, { ended: e.target.value })}
                placeholder="ปัจจุบัน / 2566/12" /></Field>
              <Field label="เงินเดือน/ค่าจ้าง"><input className="input" value={row.salary}
                onChange={(e) => setExp(i, { salary: e.target.value })} /></Field>
              <Field label="สาเหตุที่ออก"><input className="input" value={row.reason_left}
                onChange={(e) => setExp(i, { reason_left: e.target.value })} /></Field>
            </Grid2>
          </div>
        ))}
        <button type="button" onClick={addExp}
          className="text-xs text-brand hover:underline">+ เพิ่มประวัติการทำงาน</button>
      </Section>

      {/* Section 6 — Skills */}
      <Section title="6. ทักษะ & ภาษา">
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-600">ภาษา</div>
          {f.skills_language.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input className="input text-sm" value={row.language}
                placeholder="ภาษา"
                onChange={(e) => setLang(i, { language: e.target.value })} />
              <select className="input text-sm" value={row.level}
                onChange={(e) => setLang(i, { level: e.target.value })}>
                <option value="">— ระดับ —</option>
                <option value="native">เจ้าของภาษา</option>
                <option value="fluent">ดีมาก</option>
                <option value="good">ดี</option>
                <option value="basic">พอใช้</option>
              </select>
              {f.skills_language.length > 1 && (
                <button type="button" onClick={() => delLang(i)}
                  className="text-xs text-rose-600 px-2">ลบ</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addLang}
            className="text-xs text-brand hover:underline">+ เพิ่มภาษา</button>
        </div>
        <Field label="ทักษะพิเศษอื่นๆ" hint="คอมพิวเตอร์, ขับรถ, ฯลฯ">
          <textarea className="input" rows={2} value={f.skills_other}
            onChange={(e) => up("skills_other", e.target.value)} />
        </Field>
        <Field label="แนะนำตัวเองเพิ่มเติม">
          <textarea className="input" rows={3} value={f.introduction}
            onChange={(e) => up("introduction", e.target.value)} />
        </Field>
      </Section>

      {/* Section 7 — References & emergency */}
      <Section title="7. บุคคลอ้างอิง & ติดต่อฉุกเฉิน">
        <div className="text-xs font-bold text-slate-600">ติดต่อฉุกเฉิน</div>
        <Grid2>
          <Field label="ชื่อ-นามสกุล">
            <input className="input" value={f.emergency_name}
              onChange={(e) => up("emergency_name", e.target.value)} />
          </Field>
          <Field label="ความสัมพันธ์">
            <input className="input" value={f.emergency_relationship}
              onChange={(e) => up("emergency_relationship", e.target.value)} />
          </Field>
          <Field label="เบอร์โทร">
            <input className="input" type="tel" value={f.emergency_phone}
              onChange={(e) => up("emergency_phone", e.target.value)} />
          </Field>
        </Grid2>
        <Field label="บุคคลอ้างอิง (1 คน ที่ไม่ใช่ญาติ/นายจ้างเดิม)"
          hint="ชื่อ + เบอร์ + อาชีพ + ความสัมพันธ์ที่รู้จัก">
          <textarea className="input" rows={3} value={f.referee_external_text}
            onChange={(e) => up("referee_external_text", e.target.value)} />
        </Field>
      </Section>

      {/* Section 8 — Expectations */}
      <Section title="8. ความคาดหวังในการทำงาน">
        <Grid2>
          <Field label="เงินเดือนที่คาดหวัง (บาท)">
            <input className="input" type="number" min="0" value={f.expected_salary}
              onChange={(e) => up("expected_salary", e.target.value)} />
          </Field>
          <Field label="วันที่พร้อมเริ่มงาน">
            <input className="input" type="date" value={f.earliest_start_date}
              onChange={(e) => up("earliest_start_date", e.target.value)} />
          </Field>
          <Field label="ไปต่างจังหวัดได้ไหม">
            <select className="input" value={f.can_travel}
              onChange={(e) => up("can_travel", e.target.value)}>
              <option value="">—</option>
              <option value="yes">ได้</option>
              <option value="no">ไม่ได้</option>
            </select>
          </Field>
          <Field label="ทราบข่าวการรับสมัครจาก">
            <input className="input" value={f.info_source}
              onChange={(e) => up("info_source", e.target.value)}
              placeholder="เช่น LINE / Facebook / เพื่อน / โปสเตอร์" />
          </Field>
        </Grid2>
        <Field label="ทำไมอยากร่วมงานกับเรา">
          <textarea className="input" rows={3} value={f.why_join}
            onChange={(e) => up("why_join", e.target.value)} />
        </Field>
        <Field label="ความคาดหวัง/เป้าหมาย">
          <textarea className="input" rows={3} value={f.goals}
            onChange={(e) => up("goals", e.target.value)} />
        </Field>
      </Section>

      {/* Section 9 — Health & history */}
      <Section title="9. ประวัติสุขภาพ & ประวัติการสมัคร">
        <Grid2>
          <Field label="เคยป่วยหนัก/โรคติดต่อร้ายแรงไหม">
            <select className="input" value={f.prior_illness}
              onChange={(e) => up("prior_illness", e.target.value)}>
              <option value="">—</option>
              <option value="yes">เคย</option>
              <option value="no">ไม่เคย</option>
            </select>
          </Field>
          {f.prior_illness === "yes" && (
            <Field label="ระบุชื่อโรค">
              <input className="input" value={f.prior_illness_detail}
                onChange={(e) => up("prior_illness_detail", e.target.value)} />
            </Field>
          )}
          <Field label="เคยสมัครงานกับเราเมื่อ" hint="ถ้าเคยสมัคร ใส่ปี/เดือน">
            <input className="input" value={f.prior_application_at}
              onChange={(e) => up("prior_application_at", e.target.value)}
              placeholder="เช่น 2566" />
          </Field>
        </Grid2>
      </Section>

      {/* Section 10 — Documents */}
      <Section title="10. อัปโหลดเอกสาร">
        <div className="text-[11px] text-slate-500 mb-2">
          📎 ไฟล์ .pdf .jpg .png ขนาดไม่เกิน 10 MB ต่อไฟล์
        </div>
        <FileField label="รูปถ่าย" file={photo} onChange={setPhoto}
          accept="image/*" />
        <FileField label="Resume / CV" file={resume} onChange={setResume}
          accept=".pdf,image/*" />
        <FileField label="สำเนาบัตรประชาชน" file={idCopy} onChange={setIdCopy}
          accept=".pdf,image/*" />
      </Section>

      {/* Section 11 — Custom questions */}
      {customQuestions.length > 0 && (
        <Section title="11. คำถามเฉพาะตำแหน่ง">
          {customQuestions.map((q) => (
            <CustomQuestionField key={q.id} q={q}
              value={f.custom[q.id]}
              onChange={(v) => upCustom(q.id, v)} />
          ))}
        </Section>
      )}

      {/* Section 12 — Truth declaration */}
      <Section title="12. รับรองความถูกต้อง">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-slate-700 leading-relaxed">
          ข้าพเจ้าขอรับรองว่า ข้อความทั้งหมดในใบสมัครนี้เป็นความจริงทุกประการ
          หากปรากฏภายหลังว่า ข้อความใดไม่เป็นความจริง บริษัทมีสิทธิ์เลิกจ้างข้าพเจ้าได้
          โดยไม่ต้องจ่ายเงินชดเชยหรือค่าเสียหายใดๆ ทั้งสิ้น
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1 flex-shrink-0"
            checked={f.truth_declaration_accepted}
            onChange={(e) => up("truth_declaration_accepted", e.target.checked)} />
          <span><b>ยอมรับ</b> รับรองความถูกต้องของข้อมูลทั้งหมด</span>
        </label>
      </Section>

      {/* Submit */}
      {err && (
        <div className="card bg-rose-50 border border-rose-200 text-rose-700 text-sm">
          ✗ {err}
        </div>
      )}
      <div className="sticky bottom-2 z-10">
        <button type="submit" disabled={busy}
          className="btn-primary w-full text-base py-3 shadow-lg disabled:opacity-50">
          {busy ? "กำลังส่งใบสมัคร…" : "ส่งใบสมัคร"}
        </button>
      </div>
    </form>
  );
}

// ── Layout primitives ─────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card space-y-3">
      <h2 className="font-bold text-slate-800 text-sm border-b border-slate-100 pb-2">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label, hint, children
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function FileField({
  label, file, onChange, accept
}: {
  label: string;
  file: File | null;
  onChange: (f: File | null) => void;
  accept: string;
}) {
  return (
    <div className="mb-2">
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <label className="flex-1 cursor-pointer border-2 border-dashed border-slate-200 rounded-lg px-3 py-3 text-sm text-slate-500 hover:bg-slate-50">
          {file ? (
            <span className="text-emerald-700">✓ {file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
          ) : (
            <span>📤 แตะเพื่อเลือกไฟล์</span>
          )}
          <input type="file" className="hidden" accept={accept}
            onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
        </label>
        {file && (
          <button type="button" onClick={() => onChange(null)}
            className="text-xs text-rose-600 px-2">ลบ</button>
        )}
      </div>
    </div>
  );
}

// ── Custom question renderer (5 types) ────────────────────────────
function CustomQuestionField({
  q, value, onChange
}: {
  q: CustomQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
      <div>
        <div className="text-sm font-semibold text-slate-700">
          {q.label}
          {q.required && <span className="text-rose-500 ml-1">*</span>}
        </div>
        {q.hint && <p className="text-[10px] text-slate-400 mt-0.5">{q.hint}</p>}
      </div>
      {q.type === "text" && (
        q.config?.multiline ? (
          <textarea className="input text-sm" rows={3}
            maxLength={q.config?.max_length}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className="input text-sm"
            maxLength={q.config?.max_length}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)} />
        )
      )}
      {q.type === "single" && (
        <div className="space-y-1">
          {(q.config?.options ?? []).map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name={`q_${q.id}`}
                checked={value === opt.value}
                onChange={() => onChange(opt.value)} />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
      {q.type === "multi" && (() => {
        const arr = Array.isArray(value) ? value as string[] : [];
        const toggle = (v: string) => {
          onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
        };
        return (
          <div className="space-y-1">
            {(q.config?.options ?? []).map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox"
                  checked={arr.includes(opt.value)}
                  onChange={() => toggle(opt.value)} />
                <span>{opt.label}</span>
              </label>
            ))}
            {q.config?.allow_other && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox"
                  checked={arr.includes("__other__")}
                  onChange={() => toggle("__other__")} />
                <span>อื่นๆ:</span>
                <input className="input !py-1 text-sm flex-1" placeholder="ระบุ" />
              </label>
            )}
          </div>
        );
      })()}
      {q.type === "rating" && (() => {
        const scale = q.config?.scale ?? 5;
        const cur = typeof value === "number" ? value : 0;
        return (
          <div className="flex items-center gap-1">
            {Array.from({ length: scale }).map((_, i) => {
              const n = i + 1;
              const active = n <= cur;
              return (
                <button key={n} type="button"
                  onClick={() => onChange(n)}
                  className={`w-8 h-8 rounded-md text-sm font-bold transition ${
                    active ? "bg-amber-300 text-amber-900" : "bg-slate-200 text-slate-400"
                  }`}>
                  {q.config?.icon === "number" ? n : "★"}
                </button>
              );
            })}
            <span className="ml-2 text-xs text-slate-500">{cur}/{scale}</span>
          </div>
        );
      })()}
      {q.type === "grid" && (() => {
        const obj = (value && typeof value === "object" && !Array.isArray(value))
          ? value as Record<string, string>
          : {};
        const rows = q.config?.rows ?? [];
        const cols = q.config?.cols ?? [];
        return (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left p-1"></th>
                  {cols.map((c) => (
                    <th key={c.value} className="p-1 font-semibold text-slate-600 text-center">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.value}>
                    <td className="p-1 font-medium text-slate-700">{r.label}</td>
                    {cols.map((c) => (
                      <td key={c.value} className="p-1 text-center">
                        <input type="radio" name={`grid_${q.id}_${r.value}`}
                          checked={obj[r.value] === c.value}
                          onChange={() => onChange({ ...obj, [r.value]: c.value })} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}
