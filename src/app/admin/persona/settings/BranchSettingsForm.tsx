"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Client form for editing per-branch PERSONA settings. Today this
// covers just the 2 readiness round times — staff form subtitles +
// LINE Flex card titles consume these. Both are HH:MM type=time
// inputs so mobile gets the native time picker.
//
// "Reset" button reverts both fields to the system defaults
// (11:30 / 16:00) — common case when a branch wants the original
// rounds back after experimenting.

const DEFAULT_MORNING = "11:30";
const DEFAULT_AFTERNOON = "16:00";

export default function BranchSettingsForm({
  morningTime,
  afternoonTime,
  branchName
}: {
  morningTime: string;
  afternoonTime: string;
  branchName: string;
}) {
  const router = useRouter();
  const { t } = useLang();

  const [morning, setMorning] = useState(morningTime);
  const [afternoon, setAfternoon] = useState(afternoonTime);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Pristine = same as last saved values. Disables Save when there's
  // nothing to write, which keeps the activity log from filling up
  // with no-op entries when admin clicks Save twice in a row.
  const pristine = morning === morningTime && afternoon === afternoonTime;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/branch-settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readiness_morning_time: morning,
          readiness_afternoon_time: afternoon
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({
          kind: "err",
          text: j.error === "invalid_body"
            ? t("admin.persona.settings.invalidTime")
            : t("common.error")
        });
        return;
      }
      setMsg({ kind: "ok", text: t("admin.persona.settings.saved") });
      // Refresh server props so the form's "pristine" detection
      // resets to the new saved values immediately.
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  function resetDefaults() {
    setMorning(DEFAULT_MORNING);
    setAfternoon(DEFAULT_AFTERNOON);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">
            {t("admin.persona.settings.readinessTimes.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.settings.readinessTimes.help", { branch: branchName })}
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">
              {t("admin.persona.settings.readinessTimes.morning")}
            </label>
            <input
              type="time"
              className="input"
              value={morning}
              onChange={(e) => setMorning(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">
              {t("admin.persona.settings.readinessTimes.afternoon")}
            </label>
            <input
              type="time"
              className="input"
              value={afternoon}
              onChange={(e) => setAfternoon(e.target.value)}
              required
            />
          </div>
        </div>
        <button
          type="button"
          onClick={resetDefaults}
          className="text-xs text-slate-500 hover:text-brand underline"
        >
          {t("admin.persona.settings.readinessTimes.reset", {
            morning: DEFAULT_MORNING,
            afternoon: DEFAULT_AFTERNOON
          })}
        </button>
      </div>

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || pristine}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy
          ? t("common.submitting")
          : pristine
            ? t("admin.persona.settings.pristine")
            : t("common.save")}
      </button>
    </form>
  );
}
