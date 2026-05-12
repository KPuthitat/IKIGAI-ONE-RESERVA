"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Readiness report form — used by /staff/persona/shift/readiness-1130
// and /staff/persona/shift/readiness-1600. Replaces the older
// ChecklistRunner usage for these two types (which made staff tick
// admin-configured items); the new layout is 3 free-text textareas
// + an alcohol radio because the questions are inherently freeform:
//
//   • เรื่องที่อยากสื่อสารในทีม
//   • เมนูที่ไม่พร้อมขาย
//   • เมนูที่ขายได้ แต่มีการปรับบางอย่าง
//   • สถานะการขายแอลกอฮอล์ในวันนี้  (🟢 ขายได้ปกติ / ❌ ห้ามขาย)
//
// All 3 textareas are optional (เว้นว่างได้); the LINE card renders
// "ไม่มี" for any empty field. Alcohol status defaults to "ok" so
// the typical-case submission isn't blocked by a forced extra click.
//
// Reporter + date + branch are read-only display chips at the top —
// auto-filled from session/server so staff don't retype each time.

type ReportType = "readiness_1130" | "readiness_1600";
type AlcoholStatus = "ok" | "blocked";

export default function ReadinessForm({
  type,
  branchId,
  branchName,
  reporterName,
  todayDate,
  submitLabel,
  successCopy,
  initialValues
}: {
  type: ReportType;
  branchId: number;
  branchName: string;
  reporterName: string;
  /** YYYY-MM-DD — already in Bangkok local date from the server. */
  todayDate: string;
  submitLabel: string;
  successCopy: { title: string; body: string };
  /** Optional pre-fill for the afternoon round — staff sees the
   *  morning report's content already typed in and edits only what
   *  changed. Empty/undefined = start from blank. */
  initialValues?: {
    team_communications?: string;
    menus_not_ready?: string;
    menus_modified?: string;
    alcohol_status?: AlcoholStatus;
  };
}) {
  const router = useRouter();
  const { t } = useLang();

  // Seed from initialValues when provided (afternoon round prefills
  // from morning). Falling back to empty/ok matches the "blank form"
  // behaviour of the morning round.
  const [teamComm, setTeamComm] = useState(initialValues?.team_communications ?? "");
  const [menusNotReady, setMenusNotReady] = useState(initialValues?.menus_not_ready ?? "");
  const [menusModified, setMenusModified] = useState(initialValues?.menus_modified ?? "");
  const [alcohol, setAlcohol] = useState<AlcoholStatus>(initialValues?.alcohol_status ?? "ok");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          branch_id: branchId,
          data: {
            team_communications: teamComm.trim(),
            menus_not_ready: menusNotReady.trim(),
            menus_modified: menusModified.trim(),
            alcohol_status: alcohol
          }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.error === "already_submitted") {
        // Race: someone else submitted between page load + send.
        // Refresh so the locked view picks up.
        router.refresh();
        return;
      }
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: t("common.error") });
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card text-center space-y-3">
        <div className="text-5xl">✓</div>
        <h2 className="text-xl font-bold text-slate-800">{successCopy.title}</h2>
        <p className="text-sm text-slate-600">{successCopy.body}</p>
        <button
          type="button"
          onClick={() => router.push("/staff/persona")}
          className="btn-secondary w-full"
        >
          {t("common.back")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Auto-filled context — date / reporter / branch. Read-only
          input boxes (disabled) to match the shift-open form's layout
          so staff has a consistent visual pattern across all daily
          reports. Two-column grid on wider viewports collapses to
          stack on mobile. */}
      <div className="card">
        <div className="grid sm:grid-cols-2 gap-3">
          <ReadOnlyField
            label={t("staff.persona.readiness.field.date")}
            value={todayDate}
          />
          <ReadOnlyField
            label={t("staff.persona.readiness.field.reporter")}
            value={reporterName}
          />
          <ReadOnlyField
            label={t("staff.persona.readiness.field.branch")}
            value={branchName}
          />
        </div>
      </div>

      <FreeTextField
        label={t("staff.persona.readiness.field.teamCommunications")}
        placeholder={t("staff.persona.readiness.placeholder.teamCommunications")}
        value={teamComm}
        onChange={setTeamComm}
      />
      <FreeTextField
        label={t("staff.persona.readiness.field.menusNotReady")}
        placeholder={t("staff.persona.readiness.placeholder.menusNotReady")}
        value={menusNotReady}
        onChange={setMenusNotReady}
      />
      <FreeTextField
        label={t("staff.persona.readiness.field.menusModified")}
        placeholder={t("staff.persona.readiness.placeholder.menusModified")}
        value={menusModified}
        onChange={setMenusModified}
      />

      {/* Alcohol status — two pill buttons that mutually toggle.
          Default "ok" so the common case submits without an extra
          click; staff explicitly picks "blocked" when needed. */}
      <div className="card space-y-2.5">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("staff.persona.readiness.field.alcoholStatus")}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAlcohol("ok")}
            className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all border-2 ${
              alcohol === "ok"
                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            🟢 {t("staff.persona.readiness.alcohol.ok")}
          </button>
          <button
            type="button"
            onClick={() => setAlcohol("blocked")}
            className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all border-2 ${
              alcohol === "blocked"
                ? "border-rose-500 bg-rose-50 text-rose-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            ❌ {t("staff.persona.readiness.alcohol.blocked")}
          </button>
        </div>
      </div>

      {msg && (
        <div
          className={`text-sm text-center ${
            msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
          }`}
        >
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy ? t("staff.persona.shift.open.submitting") : submitLabel}
      </button>
    </form>
  );
}

// Read-only field with label-above-input layout — matches the
// shift-open form's visual pattern so staff has one consistent
// layout for "auto-filled context" across all 4 daily reports.
// The disabled input renders muted slate so it's clearly not
// editable but still feels like part of the form, not a chip.
function ReadOnlyField({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="text"
        className="input bg-slate-50 text-slate-600 cursor-not-allowed"
        value={value}
        disabled
        readOnly
      />
    </div>
  );
}

// Generic multi-line field block — same look as other staff "card"
// sections so the form has visual rhythm. 4 rows is enough to feel
// like "you can type multiple items" without dominating the screen;
// textarea grows on overflow naturally.
function FreeTextField({
  label,
  placeholder,
  value,
  onChange
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="card space-y-2">
      <h2 className="font-bold text-slate-800 text-sm">{label}</h2>
      <textarea
        className="input text-sm"
        rows={4}
        maxLength={2000}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
