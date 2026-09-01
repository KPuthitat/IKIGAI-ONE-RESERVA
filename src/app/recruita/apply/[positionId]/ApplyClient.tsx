"use client";

import { useEffect, useRef, useState, createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { apiUrl } from "@/lib/url";
import type { CustomQuestion } from "@/lib/recruita";
import { INFO_SOURCE_OPTIONS, DEFAULT_RECRUITA_PDPA_TEXT } from "@/lib/recruita";
import { useLang } from "@/lib/LangProvider";
import LangToggle from "@/app/LangToggle";
import "@/lib/liff-types";

// Active form language drives all the hard-coded copy below. Field
// LABELS come bilingual from the admin form template (label_th /
// label_en); everything else (section headers, dropdown options, help,
// PDPA, buttons, errors) flips via the `tr()` helper / per-component
// useLang(). Custom (per-position) questions stay in the language the
// admin authored them — out of scope for the standard EN form.
type FormLang = "th" | "en";
const trBy = (lang: FormLang, th: string, en: string) => (lang === "en" ? en : th);

// Public application form — owner's existing Google Form ported to
// our own pipeline, plus the per-position custom_questions admin
// defined. Single long page (not multi-step) so the applicant can
// scroll back and forth; localStorage saves a draft on every change
// so a browser refresh doesn't lose progress.

const DRAFT_KEY_PREFIX = "recruita_draft_";

// Downscale + re-encode an image File to a modest JPEG before upload.
// Phone photos are commonly 3–8 MB, which trips the reverse-proxy body
// limit and the upload silently 413s ("ส่งใบสมัครไม่สำเร็จ"). Shrinking to
// ≤1600px / JPEG q0.82 lands well under a megabyte and also normalises
// HEIC / empty-type files to image/jpeg so the server's mime allow-list
// accepts them. Non-images (PDF résumé) pass straight through. Any decode
// failure falls back to the original file so we never block a submit.
async function downscaleImage(file: File, maxDim = 1600, quality = 0.82): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob) return file;
    // Keep the original only if it's already a smaller JPEG.
    if (file.type === "image/jpeg" && blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

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

// Per-field config from the admin form template (enabled/required/label).
// Threaded to <Field> via context so each standard field can hide /
// rename / require itself. The default template mirrors the live form,
// so an un-customised template renders the form exactly as before.
type FieldCfg = Record<string, { enabled: boolean; required: boolean; label: string; label_en: string }>;
const FieldCfgContext = createContext<FieldCfg>({});

// Fields the business ALWAYS requires, regardless of what the admin form
// template says (owner #9 2026-06-06: คำนำหน้า must be captured at the
// source so every employee record carries the title prefix from day one).
// These render with a "*" and block submit even if the template tried to
// hide or un-require them.
const ALWAYS_REQUIRED_FIELDS: ReadonlySet<string> = new Set(["title_prefix"]);

// Simple string-valued FormState fields the template can mark required —
// used to compute the missing-required (red border) set on submit.
const STRING_FIELD_KEYS: ReadonlyArray<keyof FormState> = [
  "title_prefix", "first_name_th", "last_name_th", "first_name_en", "last_name_en",
  "nickname_th", "dob", "gender", "nationality", "race", "marital_status",
  "military_status", "religion", "national_id",
  "personal_email", "mobile_phone", "line_id", "house_address", "housing_type",
  "professional_license_status", "skills_other", "introduction",
  "emergency_name", "emergency_relationship", "emergency_phone", "referee_external_text",
  "expected_salary", "earliest_start_date", "goals", "why_join", "info_source",
  "can_travel", "prior_illness", "prior_illness_detail", "prior_application_at"
];

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

type GateState = "checking" | "outside_line" | "need_consent" | "connecting" | "connected";

// RC-4 capture gate UI. Shown in place of the form until we've captured the
// applicant's LINE userId (or LIFF is unconfigured). Three live states:
//   outside_line → opened in a plain browser → lock + "add OA" deep link
//   need_consent / connecting → in LINE → consent notice + connect button
function ApplyGate({
  gate, oaLink, sdkLoaded, err, onConnect, tr
}: {
  gate: GateState;
  oaLink: string;
  sdkLoaded: boolean;
  err: string | null;
  onConnect: () => void;
  tr: (th: string, en: string) => string;
}) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="card max-w-md w-full space-y-4 text-center py-8">
        {gate === "checking" && (
          <p className="text-sm text-slate-500">{tr("กำลังตรวจสอบ…", "Checking…")}</p>
        )}

        {gate === "outside_line" && (
          <>
            <h2 className="text-lg font-bold text-slate-800">
              {tr("กรุณาสมัครผ่านไลน์ของคุณ", "Please apply via your LINE")}
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              {tr(
                "กรุณากรอกใบสมัครผ่านไลน์ส่วนตัวของคุณเท่านั้น เพื่อให้ระบบเชื่อมต่อบัญชีและส่งแจ้งเตือนสถานะใบสมัครให้คุณได้",
                "Please complete the application through your own LINE so we can link your account and send you status updates."
              )}
            </p>
            <a href={oaLink} target="_blank" rel="noopener noreferrer"
              className="btn-primary inline-block w-full py-3">
              {tr("เพิ่มเพื่อน IKIGAI Recruit", "Add IKIGAI Recruit")}
            </a>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {tr(
                "เพิ่มเพื่อนแล้ว เปิดเมนูด้านล่างแชต แล้วกด \"สมัครงาน\" อีกครั้งผ่าน LINE",
                "After adding, open the chat menu and tap \"Apply\" again inside LINE."
              )}
            </p>
          </>
        )}

        {(gate === "need_consent" || gate === "connecting") && (
          <>
            <h2 className="text-lg font-bold text-slate-800">
              {tr("เชื่อมต่อ LINE เพื่อรับการแจ้งเตือน", "Connect LINE for notifications")}
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              {tr(
                "ระบบจะเก็บ LINE UserID ของคุณ เพื่อส่งแจ้งเตือนสถานะใบสมัครจากบริษัท — กดปุ่มด้านล่างเพื่อเชื่อมต่อ แล้วจึงกรอกใบสมัคร",
                "We'll store your LINE UserID to send you application-status updates. Tap below to connect, then fill in the form."
              )}
            </p>
            {err && <p className="text-xs text-rose-600">{err}</p>}
            {/* Button stays tappable even before the SDK loads — connectLine
                handles the not-ready case with a "tap again" message. This
                avoids a permanent lock-out if the LIFF CDN script stalls. */}
            <button type="button" onClick={onConnect}
              disabled={gate === "connecting"}
              className="btn-primary w-full py-3 disabled:opacity-50">
              {gate === "connecting"
                ? tr("กำลังเชื่อมต่อ…", "Connecting…")
                : tr("เชื่อมต่อ LINE", "Connect LINE")}
            </button>
            {!sdkLoaded && gate === "need_consent" && (
              <p className="text-[11px] text-slate-400">
                {tr("กำลังโหลด LINE… ถ้ากดแล้วยังไม่ติด กรุณากดอีกครั้ง", "Loading LINE… if nothing happens, please tap again")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ApplyClient({
  positionId, positionTitle, positionCode, branchName, department,
  customQuestions, liffId, oaLink, privacyPolicyUrl, pdpaImageUrl, fieldCfg
}: {
  positionId: number;
  positionTitle: string;
  positionCode: string | null;
  branchName: string | null;
  department: string | null;
  customQuestions: CustomQuestion[];
  liffId: string | null;
  /** "Add IKIGAI Recruit OA as friend" deep link — shown on the apply gate
   *  when the form is opened outside LINE (RC-4). */
  oaLink: string;
  /** Per-field config from the admin form template (hide/rename/require
   *  standard fields). Empty object = use built-in defaults. */
  fieldCfg: FieldCfg;
  /** Global URL set in /admin/system-settings. Renders as a
   *  "ดูนโยบายฉบับเต็ม" link below the PDPA consent text. NULL
   *  hides the link entirely. */
  privacyPolicyUrl: string | null;
  /** URL of the admin-uploaded PDPA policy image (served from
   *  /api/recruita/pdpa-image). When set, the consent section shows a
   *  "เปิดดูนโยบาย" button instead of the default text. NULL = no
   *  image → fall back to DEFAULT_RECRUITA_PDPA_TEXT. */
  pdpaImageUrl: string | null;
}) {
  const router = useRouter();
  const { lang } = useLang();
  const tr = (th: string, en: string) => trBy(lang, th, en);
  // Document-field label: prefer the admin template's bilingual label,
  // else the built-in fallback for the active language.
  const docLabel = (key: string, fallback: string) => {
    const c = fieldCfg[key];
    const lbl = lang === "en" ? (c?.label_en?.trim() || c?.label?.trim()) : c?.label?.trim();
    return lbl || fallback;
  };
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
  // RC-4 capture gate (owner 2026-06-14). The form is locked until we've
  // captured the applicant's LINE userId, so every application links to a
  // LINE account for notifications. Gate states:
  //   checking     → deciding (client-only, before UA/sessionStorage read)
  //   outside_line → opened in a plain browser (not LINE) → locked + OA link
  //   need_consent → in LINE, awaiting the applicant's consent tap
  //   connecting   → capturing via LIFF
  //   connected    → userId captured (or LIFF unconfigured) → form unlocked
  const [gate, setGate] = useState<GateState>("checking");
  const [sdkLoaded, setSdkLoaded] = useState(false);
  // Returning-candidate prefill state
  const prefillFetched = useRef(false);
  const [welcomeBack, setWelcomeBack] = useState(false);

  // Decide the gate on mount (client only — UA + sessionStorage aren't
  // available during SSR, hence the effect). Robust to entry path: we no
  // longer require the fragile ?liff.state survival — the in-LINE consent
  // tap establishes the session directly via liff.login()/getProfile().
  useEffect(() => {
    if (!liffId) { setGate("connected"); return; }   // LIFF unconfigured → don't lock anyone out
    // Fast path: userId already captured by LiffCapture on /recruita/positions.
    try {
      const raw = sessionStorage.getItem("recruita_liff_profile_v1");
      const uid = raw ? (JSON.parse(raw) as { userId?: string }).userId : null;
      if (uid) { setLineUserId(uid); setGate("connected"); return; }
    } catch { /* ignore corrupt cache */ }
    const inLineApp = /Line\/[\d.]+/i.test(navigator.userAgent);
    setGate(inLineApp ? "need_consent" : "outside_line");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  // Consent tap → capture the LINE userId. Only ever called when we're
  // inside the LINE in-app browser (the gate UI only shows the button in
  // 'need_consent', reached only when inLineApp). That UA guard is what
  // keeps the 2026-06-01 "400 on web view" regression from returning —
  // liff.init()/login() never runs in a plain browser here.
  async function connectLine() {
    if (!liffId) return;
    setErr(null);
    setGate("connecting");
    try {
      const w = window as unknown as { liff?: { init: (a: { liffId: string }) => Promise<void>; isLoggedIn: () => boolean; login: () => void; getProfile: () => Promise<{ userId: string; displayName?: string }> } };
      if (!w.liff) {
        setErr(tr("กำลังโหลด LINE… กรุณากดอีกครั้ง", "Loading LINE… please tap again"));
        setGate("need_consent");
        return;
      }
      // Tolerate a second init — LiffCapture on /recruita/positions may have
      // already initialised the SDK with the same liffId (the SDK is a single
      // window.liff instance shared across the soft-navigated pages). A
      // re-init throw is benign; isLoggedIn()/getProfile() work regardless.
      try { await w.liff.init({ liffId }); } catch { /* already initialized */ }
      if (!w.liff.isLoggedIn()) {
        // Not in a LIFF session here (the apply page isn't the LIFF's own
        // Endpoint URL, so a deep-navigated apply page is "outside" the
        // LIFF and isLoggedIn() is false). Calling w.liff.login() then
        // redirects to access.line.me with the apply URL as redirect_uri,
        // which LINE rejects → "400 Bad Request" (owner 2026-06-15, same
        // class as the 2026-06-01 incident). Instead RE-ENTER through the
        // LIFF launcher URL — LINE establishes the login itself and lands
        // on the LIFF endpoint (where LiffCapture stores the userId), no
        // access.line.me round-trip, no 400.
        window.location.href = `https://liff.line.me/${liffId}`;
        return;
      }
      const profile = await w.liff.getProfile();
      if (profile?.userId) {
        setLineUserId(profile.userId);
        // Cache so a re-open / soft-nav stays connected without re-tapping.
        try {
          sessionStorage.setItem("recruita_liff_profile_v1", JSON.stringify({
            userId: profile.userId,
            displayName: profile.displayName ?? "",
            capturedAt: Date.now()
          }));
        } catch { /* storage unavailable — non-fatal */ }
        setGate("connected");
      } else {
        setErr(tr("เชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง", "Could not connect. Please try again."));
        setGate("need_consent");
      }
    } catch (e) {
      console.warn("[recruita] connectLine failed:", e);
      setErr(tr("เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองอีกครั้ง", "LINE connection failed. Please try again."));
      setGate("need_consent");
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

    // LIFF userId pickup (no name prefill) — pulled from
    // sessionStorage by LiffCapture at /recruita/positions.
    //
    // Owner decision 2026-06-01: only consume userId, not the
    // displayName. LINE display names are nicknames more often
    // than legal names ("Tom Cruise" / "MintCH" / etc.) so
    // pre-filling first/last/nickname created more "wait, this
    // isn't me" friction than typing saved. The pictureUrl is
    // similarly skipped — it's a LINE profile photo, not a
    // formal-attire ID photo.
    //
    // We still want the userId for stage-change pushes, so it's
    // captured into state and sent with the submission payload.
    try {
      const raw = sessionStorage.getItem("recruita_liff_profile_v1");
      if (!raw) return;
      const prof = JSON.parse(raw) as { userId?: string };
      if (prof.userId) setLineUserId(prof.userId);
    } catch { /* ignore — best-effort */ }
  }, [draftKey]);

  // Returning-candidate prefill: when lineUserId becomes known,
  // fetch their previous data and pre-populate the form — but ONLY
  // if there is no in-progress draft for this specific position.
  // A draft means they already started editing this form, so we
  // respect that rather than overwriting their work.
  useEffect(() => {
    if (!lineUserId || prefillFetched.current) return;
    prefillFetched.current = true;

    // Respect existing draft (position-specific)
    try {
      if (localStorage.getItem(draftKey)) return;
    } catch { /* storage unavailable — proceed anyway */ }

    fetch(apiUrl(`/api/recruita/candidates/prefill?line_user_id=${encodeURIComponent(lineUserId)}`))
      .then((r) => {
        if (r.status === 204) return null;  // first-time applicant
        if (!r.ok) return null;
        return r.json() as Promise<{ candidate?: Partial<FormState> }>;
      })
      .then((data) => {
        const c = data?.candidate;
        if (!c) return;
        setF((prev) => ({
          ...prev,
          ...c,
          // Keep array fields only when non-empty; fall back to the
          // existing blank-row defaults so the form never renders with zero rows.
          education:       (c.education       as FormState["education"]       | undefined)?.length ? c.education as FormState["education"]       : prev.education,
          experience:      (c.experience      as FormState["experience"]      | undefined)?.length ? c.experience as FormState["experience"]      : prev.experience,
          skills_language: (c.skills_language as FormState["skills_language"] | undefined)?.length ? c.skills_language as FormState["skills_language"] : prev.skills_language,
          // Never prefill consent or custom answers
          pdpa_consent: false,
          truth_declaration_accepted: false,
          custom: {}
        }));
        setWelcomeBack(true);
      })
      .catch(() => { /* prefill is best-effort */ });
  }, [lineUserId, draftKey]);

  // Save draft on every change (debounced via animation frame)
  useEffect(() => {
    if (!draftLoaded.current) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify(f)); }
      catch { /* quota exceeded — ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [f, draftKey]);

  // Keys of required fields left empty at the last submit attempt →
  // drives the red borders. Cleared per-field as the user fills them.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  function clearMissing(key: string) {
    setMissing((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }
  function up<K extends keyof FormState>(k: K, v: FormState[K]) {
    setF((p) => ({ ...p, [k]: v }));
    clearMissing(k as string);
  }
  function upCustom(qid: string, v: unknown) {
    setF((p) => ({ ...p, custom: { ...p.custom, [qid]: v } }));
    clearMissing(`custom_${qid}`);
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

    // Collect ALL missing required fields in one pass so we can show
    // red borders on every one at once (not just the first).
    const miss = new Set<string>();
    for (const key of STRING_FIELD_KEYS) {
      const c = fieldCfg[key];
      const forced = ALWAYS_REQUIRED_FIELDS.has(key as string);
      if (!forced && (!c || !c.enabled || !c.required)) continue; // only enabled+required (or forced) count
      const v = f[key];
      if (typeof v === "string" && !v.trim()) miss.add(key as string);
    }
    if (!f.pdpa_consent) miss.add("pdpa_consent");
    if (!f.truth_declaration_accepted) miss.add("truth_declaration_accepted");
    // Required custom questions
    for (const q of customQuestions) {
      if (!q.required) continue;
      const ans = f.custom[q.id];
      const empty = ans == null
        || (typeof ans === "string" && !ans.trim())
        || (Array.isArray(ans) && ans.length === 0)
        || (typeof ans === "object" && ans !== null && Object.keys(ans).length === 0);
      if (empty) miss.add(`custom_${q.id}`);
    }
    if (miss.size > 0) {
      setMissing(miss);
      setErr(tr(
        `ยังกรอกไม่ครบ — มี ${miss.size} ช่องที่จำเป็นแต่ยังว่าง (ดูช่องกรอบสีแดง)`,
        `${miss.size} required field${miss.size > 1 ? "s are" : " is"} still empty (see the red-outlined fields)`
      ));
      // Let React paint the red borders, then scroll to the first one.
      setTimeout(() => {
        document.querySelector('[data-invalid="true"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      return;
    }
    setMissing(new Set());
    // Education years must be Common Era (reject พ.ศ. / malformed)
    for (const edu of f.education) {
      const ye = ceYearError(edu.year_finished, lang);
      if (ye) { setErr(`${tr("ปีที่จบการศึกษา", "Graduation year")}: ${ye}`); return; }
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
      // Shrink image attachments client-side so a multi-MB phone photo
      // doesn't 413 at the proxy. PDFs pass through untouched.
      const [outPhoto, outResume, outIdCopy] = await Promise.all([
        photo ? downscaleImage(photo) : Promise.resolve(null),
        resume ? downscaleImage(resume) : Promise.resolve(null),
        idCopy ? downscaleImage(idCopy) : Promise.resolve(null)
      ]);
      if (outPhoto)  fd.append("photo", outPhoto);
      if (outResume) fd.append("resume", outResume);
      if (outIdCopy) fd.append("id_copy", outIdCopy);

      const res = await fetch(apiUrl("/api/recruita/applications"), {
        method: "POST",
        body: fd
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        // Server returns { error, message, field, detail } on Zod
        // failures (see api/recruita/applications/route.ts). Prefer
        // the human-readable `message` so the user sees "ช่อง dob
        // ไม่ถูกต้อง" instead of "invalid_body". Log full detail to
        // console so ops can see the full Zod tree if needed.
        if (j.detail) {
          // eslint-disable-next-line no-console
          console.warn("[recruita/apply] validation detail:", j.detail);
        }
        setErr(j.message ?? j.error ?? tr("ส่งใบสมัครไม่สำเร็จ", "Could not submit your application"));
        return;
      }
      // Clear draft on success
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      router.push(`/recruita/apply/${positionId}/thanks?aid=${j.application_id}`);
    } catch {
      setErr(tr("เกิดข้อผิดพลาดในการส่งใบสมัคร กรุณาลองอีกครั้ง", "Something went wrong submitting your application. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  // Gate (RC-4): until connected, the form is hidden behind a capture
  // step so we never take an application without a LINE userId.
  if (gate !== "connected") {
    return (
      <FieldCfgContext.Provider value={fieldCfg}>
        {liffId && (
          <Script src="https://static.line-scdn.net/liff/edge/2/sdk.js"
            strategy="afterInteractive"
            onLoad={() => setSdkLoaded(true)} />
        )}
        <ApplyGate
          gate={gate}
          oaLink={oaLink}
          sdkLoaded={sdkLoaded}
          err={err}
          onConnect={connectLine}
          tr={tr}
        />
      </FieldCfgContext.Provider>
    );
  }

  return (
    <FieldCfgContext.Provider value={fieldCfg}>
    <form onSubmit={submit} className="space-y-4">
      {/* Keep the SDK mounted post-connect too (harmless, idempotent). */}
      {liffId && (
        <Script src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={() => setSdkLoaded(true)} />
      )}

      {/* LINE-connected confirmation — transparency that we stored their
          userId for status notifications (owner 2026-06-14). */}
      {lineUserId && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs text-emerald-800">
          {tr(
            "เชื่อมต่อ LINE ของคุณแล้ว — จะได้รับการแจ้งเตือนสถานะใบสมัครหลังจากนี้",
            "Your LINE is connected — you'll receive application-status updates."
          )}
        </div>
      )}

      {/* Language switch — foreigners flip to EN here (owner 2026-06-03).
          Reuses the app-wide toggle so the choice persists via cookie. */}
      <div className="flex justify-end">
        <LangToggle variant="light" />
      </div>

      {/* Welcome-back banner — shown when prefill was applied */}
      {welcomeBack && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-sm text-sky-800 space-y-1">
          <div className="font-bold">{tr("ยินดีต้อนรับกลับมา!", "Welcome back!")}</div>
          <div className="text-xs leading-relaxed text-sky-700">
            {tr(
              "เราพบข้อมูลใบสมัครเก่าของคุณและกรอกไว้ให้แล้ว — ตรวจสอบและแก้ไขให้ครบก่อนกดส่ง",
              "We found your previous application and filled it in — please review and update before submitting."
            )}
          </div>
          <button
            type="button"
            onClick={() => setWelcomeBack(false)}
            className="text-[10px] text-sky-500 hover:text-sky-700 underline"
          >
            {tr("ปิดข้อความนี้", "Dismiss")}
          </button>
        </div>
      )}

      {/* Header */}
      <div className="card text-center space-y-2">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-[2px]">
          {tr("ใบสมัครงาน", "Job Application")}
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
          {tr("ระบบบันทึกร่างอัตโนมัติ — รีเฟรชหน้าได้ ข้อมูลจะไม่หาย",
            "Your draft saves automatically — you can refresh without losing anything.")}
        </p>
      </div>

      {/* Section 1 — PDPA */}
      <Section title={tr("1. นโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA)", "1. Personal Data Protection (PDPA)")}>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-slate-700 leading-relaxed space-y-2">
          {pdpaImageUrl ? (
            // Admin uploaded a policy image — open it in a new tab.
            <>
              <p>{tr("กรุณาอ่านนโยบายคุ้มครองข้อมูลส่วนบุคคลก่อนให้ความยินยอม",
                "Please review the personal data protection policy before giving consent.")}</p>
              <a
                href={pdpaImageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white font-bold px-3 py-2 rounded-full">
                {tr("เปิดดูนโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA) →", "Open the privacy policy (PDPA) →")}
              </a>
            </>
          ) : (
            // No image — show the built-in default text + optional link.
            <>
              <div className="max-h-56 overflow-y-auto whitespace-pre-line pr-1">
                {DEFAULT_RECRUITA_PDPA_TEXT}
              </div>
              {privacyPolicyUrl && (
                <a
                  href={privacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-amber-800 hover:text-amber-900 font-bold underline underline-offset-2">
                  {tr("ดูนโยบายฉบับเต็ม →", "Read the full policy →")}
                </a>
              )}
            </>
          )}
        </div>
        <label
          data-invalid={missing.has("pdpa_consent") ? "true" : undefined}
          className={`flex items-start gap-2 text-sm text-slate-700 rounded-lg p-2 ${
            missing.has("pdpa_consent") ? "ring-2 ring-rose-400 bg-rose-50" : ""
          }`}>
          <input type="checkbox" className="mt-1 flex-shrink-0"
            checked={f.pdpa_consent}
            onChange={(e) => up("pdpa_consent", e.target.checked)} />
          <span>
            {lang === "en" ? (
              <><b>I consent</b> to the company collecting, using and disclosing my personal data for the stated purposes.</>
            ) : (
              <><b>ยินยอม</b> ให้บริษัทเก็บรวบรวม ใช้ และเปิดเผยข้อมูลส่วนบุคคลตามวัตถุประสงค์ที่ระบุ</>
            )}
            {missing.has("pdpa_consent") && (
              <span className="block text-[10px] text-rose-500 font-bold mt-0.5">
                {tr("ต้องติ๊กยินยอมก่อนส่ง", "You must consent before submitting")}
              </span>
            )}
          </span>
        </label>
      </Section>

      {/* Section 2 — Personal */}
      <Section title={tr("2. ข้อมูลส่วนตัว", "2. Personal Information")}>
        <Grid2>
          <Field k="title_prefix" fb="คำนำหน้า" invalid={missing.has("title_prefix")}>
            <select className="input" value={f.title_prefix}
              onChange={(e) => up("title_prefix", e.target.value)}>
              <option value="">—</option>
              <option value="นาย">{tr("นาย", "Mr.")}</option>
              <option value="นางสาว">{tr("นางสาว", "Ms.")}</option>
              <option value="นาง">{tr("นาง", "Mrs.")}</option>
            </select>
          </Field>
          <Field k="gender" fb="เพศ" invalid={missing.has("gender")}>
            <select className="input" value={f.gender}
              onChange={(e) => up("gender", e.target.value)}>
              <option value="">—</option>
              <option value="male">{tr("ชาย", "Male")}</option>
              <option value="female">{tr("หญิง", "Female")}</option>
              <option value="other">{tr("อื่นๆ", "Other")}</option>
            </select>
          </Field>
          <Field k="first_name_th" fb="ชื่อจริง (ไทย)" invalid={missing.has("first_name_th")}>
            <input className="input" value={f.first_name_th}
              onChange={(e) => up("first_name_th", e.target.value)} />
          </Field>
          <Field k="last_name_th" fb="นามสกุล (ไทย)" invalid={missing.has("last_name_th")}>
            <input className="input" value={f.last_name_th}
              onChange={(e) => up("last_name_th", e.target.value)} />
          </Field>
          <Field k="first_name_en" fb="First name (EN)" invalid={missing.has("first_name_en")}>
            <input className="input" value={f.first_name_en}
              onChange={(e) => up("first_name_en", e.target.value)} />
          </Field>
          <Field k="last_name_en" fb="Last name (EN)" invalid={missing.has("last_name_en")}>
            <input className="input" value={f.last_name_en}
              onChange={(e) => up("last_name_en", e.target.value)} />
          </Field>
          <Field k="nickname_th" fb="ชื่อเล่น" invalid={missing.has("nickname_th")}>
            <input className="input" value={f.nickname_th}
              onChange={(e) => up("nickname_th", e.target.value)} />
          </Field>
          <Field k="dob" fb="วัน/เดือน/ปี เกิด" invalid={missing.has("dob")}
            hint={tr("รูปแบบ DD/MM/YYYY · ถ้าจำวันไม่แม่นยำ ใส่วันที่ 1 ของเดือนได้",
              "Format DD/MM/YYYY · if unsure of the day, use the 1st of the month")}>
            <DateInput value={f.dob} onChange={(v) => up("dob", v)} required />
          </Field>
          <Field k="nationality" fb="สัญชาติ" invalid={missing.has("nationality")}>
            <input className="input" value={f.nationality}
              onChange={(e) => up("nationality", e.target.value)} />
          </Field>
          <Field k="race" fb="เชื้อชาติ" invalid={missing.has("race")}>
            <input className="input" value={f.race}
              onChange={(e) => up("race", e.target.value)} />
          </Field>
          <Field k="religion" fb="ศาสนา" invalid={missing.has("religion")}>
            <input className="input" value={f.religion}
              onChange={(e) => up("religion", e.target.value)} />
          </Field>
          <Field k="marital_status" fb="สถานภาพ" invalid={missing.has("marital_status")}>
            <select className="input" value={f.marital_status}
              onChange={(e) => up("marital_status", e.target.value)}>
              <option value="">—</option>
              <option value="single">{tr("โสด", "Single")}</option>
              <option value="married">{tr("สมรส", "Married")}</option>
              <option value="divorced">{tr("หย่าร้าง", "Divorced")}</option>
              <option value="widowed">{tr("หม้าย", "Widowed")}</option>
            </select>
          </Field>
          {f.gender === "male" && (
            <Field k="military_status" fb="ภาวะทางทหาร" invalid={missing.has("military_status")}>
              <select className="input" value={f.military_status}
                onChange={(e) => up("military_status", e.target.value)}>
                <option value="">—</option>
                <option value="exempt">{tr("ได้รับการยกเว้น", "Exempt")}</option>
                <option value="reservist">{tr("ปลดเป็นทหารกองหนุน", "Discharged (reservist)")}</option>
                <option value="pending">{tr("ยังไม่ได้รับการเกณฑ์", "Not yet conscripted")}</option>
              </select>
            </Field>
          )}
          <Field k="national_id" fb="เลขบัตรประจำตัวประชาชน" invalid={missing.has("national_id")}
            hint={tr("เข้ารหัสในระบบ (PDPA)", "Encrypted at rest (PDPA)")}>
            <input className="input" inputMode="numeric"
              maxLength={13} value={f.national_id}
              onChange={(e) => up("national_id", e.target.value.replace(/\D/g, ""))} />
          </Field>
        </Grid2>
      </Section>

      {/* Section 3 — Contact */}
      <Section title={tr("3. ติดต่อ", "3. Contact")}>
        <Grid2>
          <Field k="mobile_phone" fb="เบอร์โทรศัพท์มือถือ" invalid={missing.has("mobile_phone")}>
            <input className="input" type="tel" value={f.mobile_phone}
              onChange={(e) => up("mobile_phone", e.target.value)} />
          </Field>
          <Field k="personal_email" fb="อีเมล" invalid={missing.has("personal_email")}>
            <input className="input" type="email" value={f.personal_email}
              onChange={(e) => up("personal_email", e.target.value)} />
          </Field>
          <Field k="line_id" fb="LINE ID" invalid={missing.has("line_id")}>
            <input className="input" value={f.line_id}
              onChange={(e) => up("line_id", e.target.value)} />
          </Field>
          <Field k="housing_type" fb="ลักษณะที่อยู่" invalid={missing.has("housing_type")}>
            <select className="input" value={f.housing_type}
              onChange={(e) => up("housing_type", e.target.value)}>
              <option value="">—</option>
              <option value="family">{tr("อาศัยกับครอบครัว", "Living with family")}</option>
              <option value="own_home">{tr("บ้านตัวเอง", "Own home")}</option>
              <option value="rental">{tr("บ้านเช่า", "Rented")}</option>
              <option value="dormitory">{tr("หอพัก", "Dormitory")}</option>
              <option value="other">{tr("อื่นๆ", "Other")}</option>
            </select>
          </Field>
        </Grid2>
        <Field k="house_address" fb="ที่อยู่ปัจจุบัน" invalid={missing.has("house_address")}>
          <textarea className="input" rows={2} value={f.house_address}
            onChange={(e) => up("house_address", e.target.value)} />
        </Field>
      </Section>

      {/* Section 4 — Education */}
      <Section title={tr("4. ประวัติการศึกษา", "4. Education")}>
        {f.education.map((row, i) => {
          const eduYearErr = ceYearError(row.year_finished, lang);
          return (
          <div key={i} className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">{tr("รายการที่", "Entry")} {i + 1}</span>
              {f.education.length > 1 && (
                <button type="button" onClick={() => delEdu(i)}
                  className="text-xs text-rose-600 hover:underline">{tr("ลบ", "Remove")}</button>
              )}
            </div>
            <Grid2>
              <Field label={tr("ระดับ", "Level")}>
                <select className="input" value={row.level}
                  onChange={(e) => setEdu(i, { level: e.target.value })}>
                  <option value="">—</option>
                  <option value="high_school">{tr("มัธยมศึกษาตอนปลาย", "High school")}</option>
                  <option value="vocational">{tr("ปวช.", "Vocational certificate")}</option>
                  <option value="diploma">{tr("ปวส.", "Higher vocational diploma")}</option>
                  <option value="bachelor">{tr("ปริญญาตรี", "Bachelor's")}</option>
                  <option value="master">{tr("ปริญญาโท", "Master's")}</option>
                  <option value="phd">{tr("ปริญญาเอก", "Doctorate")}</option>
                </select>
              </Field>
              <Field label={tr("ปีที่จบ (ค.ศ.)", "Year finished (CE)")}>
                <input className="input" inputMode="numeric" maxLength={4}
                  value={row.year_finished}
                  onChange={(e) => setEdu(i, { year_finished: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  placeholder={tr("เช่น 2023", "e.g. 2023")} />
                {eduYearErr && (
                  <p className="text-[11px] text-rose-600 mt-1">{eduYearErr}</p>
                )}
              </Field>
              <Field label={tr("สถาบัน", "Institution")}>
                <input className="input" value={row.institution}
                  onChange={(e) => setEdu(i, { institution: e.target.value })} />
              </Field>
              <Field label={tr("คณะ", "Faculty")}>
                <input className="input" value={row.faculty}
                  onChange={(e) => setEdu(i, { faculty: e.target.value })} />
              </Field>
              <Field label={tr("สาขาวิชา", "Major")}>
                <input className="input" value={row.major}
                  onChange={(e) => setEdu(i, { major: e.target.value })} />
              </Field>
              <Field label={tr("เกรดเฉลี่ย", "GPA")}>
                <input className="input" value={row.gpa}
                  onChange={(e) => setEdu(i, { gpa: e.target.value })} />
              </Field>
            </Grid2>
          </div>
          );
        })}
        <button type="button" onClick={addEdu}
          className="text-xs text-brand hover:underline">+ {tr("เพิ่มประวัติการศึกษา", "Add education")}</button>

        <Field k="professional_license_status" fb="มีใบประกอบวิชาชีพหรือไม่ (พยาบาล/เทคนิคการแพทย์/สาธารณสุข)"
          invalid={missing.has("professional_license_status")}
          hint={tr("เฉพาะตำแหน่งที่ต้องใช้ใบประกอบ", "Only for positions that require a license")}>
          <select className="input" value={f.professional_license_status}
            onChange={(e) => up("professional_license_status", e.target.value)}>
            <option value="">—</option>
            <option value="has_license">{tr("มีใบประกอบวิชาชีพ", "Hold a professional license")}</option>
            <option value="no_license">{tr("ไม่มีใบประกอบวิชาชีพ", "No professional license")}</option>
            <option value="not_applicable">{tr("ไม่ได้สมัครตำแหน่งดังกล่าว", "Not applying for such a role")}</option>
          </select>
        </Field>
      </Section>

      {/* Section 5 — Experience */}
      <Section title={tr("5. ประสบการณ์การทำงาน", "5. Work Experience")}>
        {f.experience.map((row, i) => (
          <div key={i} className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">{tr("งานล่าสุดที่", "Job")} {i + 1}</span>
              {f.experience.length > 1 && (
                <button type="button" onClick={() => delExp(i)}
                  className="text-xs text-rose-600 hover:underline">{tr("ลบ", "Remove")}</button>
              )}
            </div>
            <Grid2>
              <Field label={tr("ชื่อบริษัท/สถานที่", "Company / workplace")}><input className="input" value={row.company}
                onChange={(e) => setExp(i, { company: e.target.value })} /></Field>
              <Field label={tr("ตำแหน่ง", "Position")}><input className="input" value={row.position}
                onChange={(e) => setExp(i, { position: e.target.value })} /></Field>
              <Field label={tr("เริ่มงาน", "Start date")}
                hint={tr("รูปแบบ DD/MM/YYYY · ถ้าจำวันไม่แม่นยำ ใส่วันที่ 1 ของเดือนได้",
                  "Format DD/MM/YYYY · if unsure of the day, use the 1st")}>
                <DateInput value={row.started}
                  onChange={(v) => setExp(i, { started: v })} />
              </Field>
              <Field label={tr("ออกจากงาน", "End date")} hint={tr("DD/MM/YYYY (เว้นว่าง = ยังทำอยู่)", "DD/MM/YYYY (blank = still working)")}>
                <DateInput value={row.ended}
                  onChange={(v) => setExp(i, { ended: v })} />
              </Field>
              <Field label={tr("เงินเดือน/ค่าจ้าง", "Salary / wage")}><input className="input" value={row.salary}
                onChange={(e) => setExp(i, { salary: e.target.value })} /></Field>
              <Field label={tr("สาเหตุที่ออก", "Reason for leaving")}><input className="input" value={row.reason_left}
                onChange={(e) => setExp(i, { reason_left: e.target.value })} /></Field>
            </Grid2>
          </div>
        ))}
        <button type="button" onClick={addExp}
          className="text-xs text-brand hover:underline">+ {tr("เพิ่มประวัติการทำงาน", "Add work experience")}</button>
      </Section>

      {/* Section 6 — Skills */}
      <Section title={tr("6. ทักษะ & ภาษา", "6. Skills & Languages")}>
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-600">{tr("ภาษา", "Languages")}</div>
          {f.skills_language.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input className="input text-sm" value={row.language}
                placeholder={tr("ภาษา", "Language")}
                onChange={(e) => setLang(i, { language: e.target.value })} />
              <select className="input text-sm" value={row.level}
                onChange={(e) => setLang(i, { level: e.target.value })}>
                <option value="">{tr("— ระดับ —", "— Level —")}</option>
                <option value="native">{tr("เจ้าของภาษา", "Native")}</option>
                <option value="fluent">{tr("ดีมาก", "Fluent")}</option>
                <option value="good">{tr("ดี", "Good")}</option>
                <option value="basic">{tr("พอใช้", "Basic")}</option>
              </select>
              {f.skills_language.length > 1 && (
                <button type="button" onClick={() => delLang(i)}
                  className="text-xs text-rose-600 px-2">{tr("ลบ", "Remove")}</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addLang}
            className="text-xs text-brand hover:underline">+ {tr("เพิ่มภาษา", "Add language")}</button>
        </div>
        <Field k="skills_other" fb="ทักษะพิเศษอื่นๆ" invalid={missing.has("skills_other")} hint={tr("คอมพิวเตอร์, ขับรถ, ฯลฯ", "Computer, driving, etc.")}>
          <textarea className="input" rows={2} value={f.skills_other}
            onChange={(e) => up("skills_other", e.target.value)} />
        </Field>
        <Field k="introduction" fb="แนะนำตัวเองเพิ่มเติม" invalid={missing.has("introduction")}>
          <textarea className="input" rows={3} value={f.introduction}
            onChange={(e) => up("introduction", e.target.value)} />
        </Field>
      </Section>

      {/* Section 7 — References & emergency */}
      <Section title={tr("7. บุคคลอ้างอิง & ติดต่อฉุกเฉิน", "7. References & Emergency Contact")}>
        <div className="text-xs font-bold text-slate-600">{tr("ติดต่อฉุกเฉิน", "Emergency contact")}</div>
        <Grid2>
          <Field k="emergency_name" fb="ชื่อ-นามสกุล (ติดต่อฉุกเฉิน)" invalid={missing.has("emergency_name")}>
            <input className="input" value={f.emergency_name}
              onChange={(e) => up("emergency_name", e.target.value)} />
          </Field>
          <Field k="emergency_relationship" fb="ความสัมพันธ์" invalid={missing.has("emergency_relationship")}>
            <input className="input" value={f.emergency_relationship}
              onChange={(e) => up("emergency_relationship", e.target.value)} />
          </Field>
          <Field k="emergency_phone" fb="เบอร์โทร (ติดต่อฉุกเฉิน)" invalid={missing.has("emergency_phone")}>
            <input className="input" type="tel" value={f.emergency_phone}
              onChange={(e) => up("emergency_phone", e.target.value)} />
          </Field>
        </Grid2>
        <Field k="referee_external_text" fb="บุคคลอ้างอิง (ไม่ใช่ญาติ/นายจ้างเดิม)"
          invalid={missing.has("referee_external_text")}
          hint={tr("ชื่อ + เบอร์ + อาชีพ + ความสัมพันธ์ที่รู้จัก", "Name + phone + occupation + how you know them")}>
          <textarea className="input" rows={3} value={f.referee_external_text}
            onChange={(e) => up("referee_external_text", e.target.value)} />
        </Field>
      </Section>

      {/* Section 8 — Expectations */}
      <Section title={tr("8. ความคาดหวังในการทำงาน", "8. Job Expectations")}>
        <Grid2>
          <Field k="expected_salary" fb="เงินเดือนที่คาดหวัง (บาท)" invalid={missing.has("expected_salary")}>
            <input className="input" type="number" min="0" value={f.expected_salary}
              onChange={(e) => up("expected_salary", e.target.value)} />
          </Field>
          <Field k="earliest_start_date" fb="วันที่พร้อมเริ่มงาน" invalid={missing.has("earliest_start_date")} hint="รูปแบบ DD/MM/YYYY">
            <DateInput value={f.earliest_start_date}
              onChange={(v) => up("earliest_start_date", v)} />
          </Field>
          <Field k="can_travel" fb="ไปต่างจังหวัดได้ไหม" invalid={missing.has("can_travel")}>
            <select className="input" value={f.can_travel}
              onChange={(e) => up("can_travel", e.target.value)}>
              <option value="">—</option>
              <option value="yes">{tr("ได้", "Yes")}</option>
              <option value="no">{tr("ไม่ได้", "No")}</option>
            </select>
          </Field>
          <Field k="info_source" fb="ทราบข่าวการรับสมัครจาก" invalid={missing.has("info_source")}>
            <select className="input" value={f.info_source}
              onChange={(e) => up("info_source", e.target.value)}>
              <option value="">—</option>
              {INFO_SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        </Grid2>
        <Field k="why_join" fb="ทำไมอยากร่วมงานกับเรา" invalid={missing.has("why_join")}>
          <textarea className="input" rows={3} value={f.why_join}
            onChange={(e) => up("why_join", e.target.value)} />
        </Field>
        <Field k="goals" fb="ความคาดหวัง/เป้าหมาย" invalid={missing.has("goals")}>
          <textarea className="input" rows={3} value={f.goals}
            onChange={(e) => up("goals", e.target.value)} />
        </Field>
      </Section>

      {/* Section 9 — Health & history */}
      <Section title={tr("9. ประวัติสุขภาพ & ประวัติการสมัคร", "9. Health & Application History")}>
        <Grid2>
          <Field k="prior_illness" fb="เคยป่วยหนัก/โรคติดต่อร้ายแรงไหม" invalid={missing.has("prior_illness")}>
            <select className="input" value={f.prior_illness}
              onChange={(e) => up("prior_illness", e.target.value)}>
              <option value="">—</option>
              <option value="yes">{tr("เคย", "Yes")}</option>
              <option value="no">{tr("ไม่เคย", "No")}</option>
            </select>
          </Field>
          {f.prior_illness === "yes" && (
            <Field k="prior_illness_detail" fb="ระบุชื่อโรค" invalid={missing.has("prior_illness_detail")}>
              <input className="input" value={f.prior_illness_detail}
                onChange={(e) => up("prior_illness_detail", e.target.value)} />
            </Field>
          )}
          <Field k="prior_application_at" fb="เคยสมัครงานกับเราเมื่อ"
            invalid={missing.has("prior_application_at")}
            hint={tr("รูปแบบ DD/MM/YYYY · ถ้าจำวันไม่แม่นยำ ใส่วันที่ 1 ของเดือนได้",
              "Format DD/MM/YYYY · if unsure of the day, use the 1st")}>
            <DateInput value={f.prior_application_at}
              onChange={(v) => up("prior_application_at", v)} />
          </Field>
        </Grid2>
      </Section>

      {/* Section 10 — Documents */}
      <Section title={tr("10. อัปโหลดเอกสาร", "10. Upload Documents")}>
        <div className="text-[11px] text-slate-500 mb-2 space-y-1">
          <p>{tr("ไฟล์ .pdf .jpg .png ขนาดไม่เกิน 10 MB ต่อไฟล์", ".pdf .jpg .png files, up to 10 MB each")}</p>
          <p className="text-slate-400">
            {tr(
              "ไฟล์จะถูกเก็บใน server ของ IKIGAI Medihealth (ไม่ส่งต่อให้บุคคลที่สาม) — ลบอัตโนมัติภายใน 30 วัน หากใบสมัครไม่ผ่านการพิจารณา",
              "Files are stored on IKIGAI Medihealth's server (not shared with third parties) and auto-deleted within 30 days if the application is unsuccessful."
            )}
          </p>
        </div>
        {(fieldCfg["doc_photo"]?.enabled ?? true) && (
          <FileField label={docLabel("doc_photo", tr("รูปถ่าย", "Photo"))} file={photo} onChange={setPhoto}
            accept="image/*" />
        )}
        {(fieldCfg["doc_resume"]?.enabled ?? true) && (
          <FileField label={docLabel("doc_resume", "Resume / CV")} file={resume} onChange={setResume}
            accept=".pdf,image/*" />
        )}
        {(fieldCfg["doc_id_copy"]?.enabled ?? true) && (
          <FileField label={docLabel("doc_id_copy", tr("สำเนาบัตรประชาชน", "ID card copy"))} file={idCopy} onChange={setIdCopy}
            accept=".pdf,image/*" />
        )}
      </Section>

      {/* Section 11 — Custom questions */}
      {customQuestions.length > 0 && (
        <Section title={tr("11. คำถามเฉพาะตำแหน่ง", "11. Position-specific Questions")}>
          {customQuestions.map((q) => {
            const invalid = missing.has(`custom_${q.id}`);
            return (
              <div key={q.id}
                data-invalid={invalid ? "true" : undefined}
                className={invalid ? "rounded-lg ring-2 ring-rose-400 p-2" : ""}>
                <CustomQuestionField q={q}
                  value={f.custom[q.id]}
                  onChange={(v) => upCustom(q.id, v)} />
                {invalid && (
                  <p className="text-[10px] text-rose-500 font-bold mt-0.5">{tr("จำเป็นต้องตอบข้อนี้", "This question is required")}</p>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* Section 12 — Truth declaration */}
      <Section title={tr("12. รับรองความถูกต้อง", "12. Declaration of Truth")}>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-slate-700 leading-relaxed">
          {tr(
            "ข้าพเจ้าขอรับรองว่า ข้อความทั้งหมดในใบสมัครนี้เป็นความจริงทุกประการ หากปรากฏภายหลังว่า ข้อความใดไม่เป็นความจริง บริษัทมีสิทธิ์เลิกจ้างข้าพเจ้าได้ โดยไม่ต้องจ่ายเงินชดเชยหรือค่าเสียหายใดๆ ทั้งสิ้น",
            "I certify that all statements in this application are true. If any statement is later found to be false, the company has the right to terminate my employment without any severance or compensation."
          )}
        </div>
        <label
          data-invalid={missing.has("truth_declaration_accepted") ? "true" : undefined}
          className={`flex items-start gap-2 text-sm text-slate-700 rounded-lg p-2 ${
            missing.has("truth_declaration_accepted") ? "ring-2 ring-rose-400 bg-rose-50" : ""
          }`}>
          <input type="checkbox" className="mt-1 flex-shrink-0"
            checked={f.truth_declaration_accepted}
            onChange={(e) => up("truth_declaration_accepted", e.target.checked)} />
          <span>
            {lang === "en" ? (
              <><b>I accept</b> and certify that all the information is accurate.</>
            ) : (
              <><b>ยอมรับ</b> รับรองความถูกต้องของข้อมูลทั้งหมด</>
            )}
            {missing.has("truth_declaration_accepted") && (
              <span className="block text-[10px] text-rose-500 font-bold mt-0.5">
                {tr("ต้องติ๊กยอมรับก่อนส่ง", "You must accept before submitting")}
              </span>
            )}
          </span>
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
          {busy ? tr("กำลังส่งใบสมัคร…", "Submitting…") : tr("ส่งใบสมัคร", "Submit application")}
        </button>
      </div>
    </form>
    </FieldCfgContext.Provider>
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
  k, fb, label, hint, invalid, children
}: {
  /** Template field key. When set, the field reads enabled/label/
   *  required from the admin form template (via context). */
  k?: string;
  /** Fallback label when the template has no override. */
  fb?: string;
  /** Static label (legacy / non-template fields). */
  label?: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  const { lang } = useLang();
  const cfg = useContext(FieldCfgContext);
  const c = k ? cfg[k] : undefined;
  // Some fields are always required by the business regardless of the
  // admin template — they can't be hidden or un-starred (owner #9).
  const forced = k ? ALWAYS_REQUIRED_FIELDS.has(k) : false;
  // Hidden by the template → render nothing (unless forced-required).
  if (k && c && !c.enabled && !forced) return null;
  // Template fields are bilingual (label_en); fall back to the Thai
  // label then the call-site `fb` if a translation is missing.
  const tplLabel = c
    ? (lang === "en" ? (c.label_en?.trim() || c.label?.trim()) : c.label?.trim())
    : "";
  const shownLabel = k
    ? ((tplLabel || fb || "") + ((c?.required || forced) ? " *" : ""))
    : (label ?? "");
  return (
    <div data-invalid={invalid ? "true" : undefined}>
      <label className="label">{shownLabel}</label>
      <div className={invalid ? "rounded-lg ring-2 ring-rose-400" : ""}>
        {children}
      </div>
      {invalid && (
        <p className="text-[10px] text-rose-500 font-bold mt-0.5">
          {trBy(lang, "จำเป็นต้องกรอกช่องนี้", "This field is required")}
        </p>
      )}
      {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ── DateInput — DD/MM/YYYY masked text input ───────────────────────
//
// We don't use native <input type="date"> because:
//   1. The display format depends on the user's OS locale — Thai
//      users on an English-locale phone see MM/DD/YYYY which the
//      owner explicitly didn't want.
//   2. The native picker is keyboard-driven, which on Android opens
//      a fullscreen widget that hides the rest of the form context.
//
// This input renders DD/MM/YYYY consistently. We store ISO YYYY-MM-DD
// in FormState so the API + DB keep their existing shape — convert
// in both directions on the boundary.
//
// Partial inputs (just a day, just day+month) yield "" upstream — the
// FormState only flips to a real value when the user has typed all
// three segments AND they round-trip to a valid Date. Owner spec:
// "if the candidate doesn't know the day, use day 1" — that's a copy
// hint we surface as `hint` text; the field itself doesn't substitute.
function DateInput({
  value, onChange, required
}: {
  /** Stored format: YYYY-MM-DD or "" */
  value: string;
  /** Receives YYYY-MM-DD on a complete valid date, "" otherwise. */
  onChange: (iso: string) => void;
  required?: boolean;
}) {
  const { lang } = useLang();
  // Track the typed string separately so partial input ("12/") still
  // renders while the user keeps typing. Sync with the canonical
  // value when it changes externally (draft restore, prefill, etc.).
  const initialDisplay = isoToDDMMYYYY(value);
  const [display, setDisplay] = useState(initialDisplay);
  // Inline warning when the typed year looks like พ.ศ. (Buddhist era).
  const [yearWarn, setYearWarn] = useState<string | null>(null);
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setDisplay(isoToDDMMYYYY(value));
      setYearWarn(null);
    }
  }, [value]);

  function handle(raw: string) {
    // Keep only digits, then re-insert slashes at fixed positions —
    // this way users can type 01012000 and get 01/01/2000 with no
    // friction, and pasting "01-01-2000" / "01.01.2000" still works.
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    let formatted = digits;
    if (digits.length > 4) {
      formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    } else if (digits.length > 2) {
      formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    setDisplay(formatted);
    // Buddhist-era guard: a complete date whose year is far past the
    // present is almost certainly พ.ศ. (543 ahead of ค.ศ.). Surface a
    // hint to convert; ddmmyyyyToIso already returns "" for it so we
    // never store a Buddhist year.
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(formatted);
    if (m) {
      const yyyy = Number(m[3]);
      const nowY = new Date().getFullYear();
      if (yyyy > nowY + 5) {
        setYearWarn(trBy(lang,
          `ปี ${yyyy} เป็น พ.ศ.? — กรอกเป็น ค.ศ. (เช่น ${yyyy - 543})`,
          `Is ${yyyy} a Buddhist-era year? Use CE (e.g. ${yyyy - 543})`));
      } else if (yyyy < 1900) {
        setYearWarn(trBy(lang, "ปีไม่ถูกต้อง", "Invalid year"));
      } else {
        setYearWarn(null);
      }
    } else {
      setYearWarn(null);
    }
    lastValueRef.current = ddmmyyyyToIso(formatted);
    onChange(lastValueRef.current);
  }

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        className="input font-mono"
        value={display}
        onChange={(e) => handle(e.target.value)}
        required={required} />
      {yearWarn && (
        <p className="text-[11px] text-rose-600 mt-1">{yearWarn}</p>
      )}
    </>
  );
}

/** Convert YYYY-MM-DD → DD/MM/YYYY. Returns "" on anything else
 *  (incl. partial / invalid). */
function isoToDDMMYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** Convert DD/MM/YYYY → YYYY-MM-DD. Returns "" on anything other
 *  than a fully-formed, calendar-valid date. */
function ddmmyyyyToIso(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? "").trim());
  if (!m) return "";
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12) return "";
  if (dd < 1 || dd > 31) return "";
  // Calendar sanity check — catches 31/02, 31/04, leap-year etc.
  const probe = new Date(yyyy, mm - 1, dd);
  if (
    probe.getFullYear() !== yyyy ||
    probe.getMonth() !== mm - 1 ||
    probe.getDate() !== dd
  ) return "";
  // Sane year range — avoid auto-formed garbage from typos. 1900 lets
  // the oldest legitimate applicant through; +5y catches "earliest
  // start date" looking ahead without letting 9999 type-os save.
  const nowY = new Date().getFullYear();
  if (yyyy < 1900 || yyyy > nowY + 5) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Validate a standalone 4-digit YEAR field (e.g. graduation year) as
 *  Common Era. Returns a Thai error string, or null when valid/empty.
 *  A พ.ศ. year is 543 ahead of ค.ศ., so anything past the current
 *  year is almost certainly Buddhist-era and we ask the user to
 *  convert. */
function ceYearError(raw: string, lang: FormLang = "th"): string | null {
  const t = (th: string, en: string) => trBy(lang, th, en);
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^\d{4}$/.test(v)) return t("กรอกปีเป็นตัวเลข 4 หลัก (ค.ศ.)", "Enter a 4-digit Gregorian (CE) year");
  const y = Number(v);
  const nowY = new Date().getFullYear();
  if (y > nowY) return t(`ปี ${y} เป็น พ.ศ.? — กรอกเป็น ค.ศ. เช่น ${y - 543}`, `Is ${y} a Buddhist-era year? Use the CE year, e.g. ${y - 543}`);
  if (y < 1940) return t("ปีเก่าเกินไป — ตรวจสอบอีกครั้ง", "That year looks too old — please re-check");
  return null;
}

function FileField({
  label, file, onChange, accept
}: {
  label: string;
  file: File | null;
  onChange: (f: File | null) => void;
  accept: string;
}) {
  const { lang } = useLang();
  return (
    <div className="mb-2">
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <label className="flex-1 cursor-pointer border-2 border-dashed border-slate-200 rounded-lg px-3 py-3 text-sm text-slate-500 hover:bg-slate-50">
          {file ? (
            <span className="text-emerald-700">✓ {file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
          ) : (
            <span>{trBy(lang, "แตะเพื่อเลือกไฟล์", "Tap to choose a file")}</span>
          )}
          <input type="file" className="hidden" accept={accept}
            onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
        </label>
        {file && (
          <button type="button" onClick={() => onChange(null)}
            className="text-xs text-rose-600 px-2">{trBy(lang, "ลบ", "Remove")}</button>
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
