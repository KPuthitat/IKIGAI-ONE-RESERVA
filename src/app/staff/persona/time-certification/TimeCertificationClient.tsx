"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type EntryRow = {
  id: number;
  type: "in" | "out";
  ts: string;
  branch_id: number | null;
};
type CertRow = {
  id: number;
  entry_id: number;
  proposed_ts: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decision_note: string | null;
};

// Bangkok "YYYY-MM-DD HH:MM" from an ISO string. The <input type=
// "datetime-local"> wants a value in this shape (without timezone)
// so admin/staff sees + edits the local-wall-clock time directly
// rather than wrestling with UTC offsets.
function bkkLocalForInput(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
}

function bkkDisplay(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16).replace("T", " ");
}

// Convert datetime-local string ("2026-05-13T08:32") back to a
// proper ISO with the Bangkok offset, so the server sees the same
// instant the user picked on their phone.
function inputToIso(local: string): string {
  return new Date(local + ":00+07:00").toISOString();
}

export default function TimeCertificationClient({
  entries,
  certs,
  pendingEntryIds
}: {
  entries: EntryRow[];
  certs: CertRow[];
  pendingEntryIds: number[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const pendingSet = new Set(pendingEntryIds);
  const [form, setForm] = useState<{
    entryId: number;
    originalTs: string;
    proposedLocal: string;
    reason: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function openForm(entry: EntryRow) {
    setForm({
      entryId: entry.id,
      originalTs: entry.ts,
      proposedLocal: bkkLocalForInput(entry.ts),
      reason: ""
    });
    setMsg(null);
  }

  async function submit() {
    if (!form) return;
    if (form.reason.trim().length < 3) {
      setMsg({ kind: "err", text: t("staff.persona.timeCert.reasonTooShort") });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/time-certification"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_id: form.entryId,
          proposed_ts: inputToIso(form.proposedLocal),
          reason: form.reason.trim()
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({
          kind: "err",
          text: j.error === "already_pending"
            ? t("staff.persona.timeCert.alreadyPending")
            : t("common.error")
        });
        return;
      }
      setMsg({ kind: "ok", text: t("staff.persona.timeCert.submitted") });
      setForm(null);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Form modal (rendered inline) ── */}
      {form && (
        <div className="card space-y-3 border-l-4 border-amber-400">
          <h2 className="font-bold text-slate-800 text-sm">
            {t("staff.persona.timeCert.formTitle")}
          </h2>
          <div className="text-xs text-slate-600">
            {t("staff.persona.timeCert.originalLabel")}:{" "}
            <span className="font-mono font-bold">{bkkDisplay(form.originalTs)}</span>
          </div>
          <div>
            <label className="label">{t("staff.persona.timeCert.proposedLabel")}</label>
            <input
              type="datetime-local"
              className="input"
              value={form.proposedLocal}
              onChange={(e) => setForm({ ...form, proposedLocal: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("staff.persona.timeCert.reasonLabel")}</label>
            <textarea
              className="input text-sm"
              rows={3}
              maxLength={500}
              placeholder={t("staff.persona.timeCert.reasonPlaceholder")}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              disabled={busy}
              className="btn-secondary flex-1 text-sm"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="btn-primary flex-1 text-sm"
            >
              {busy ? t("common.submitting") : t("staff.persona.timeCert.submit")}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`text-sm text-center ${
          msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
        }`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      {/* ── Recent entries — pick one to certify ── */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("staff.persona.timeCert.recentTitle")}
        </h2>
        {entries.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6">
            {t("staff.persona.timeCert.noEntries")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map((e) => {
              const pending = pendingSet.has(e.id);
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      e.type === "in"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}>
                      {e.type === "in" ? "เข้า" : "ออก"}
                    </span>
                    <span className="font-mono text-sm">{bkkDisplay(e.ts)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openForm(e)}
                    disabled={pending}
                    className="text-xs px-2.5 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {pending
                      ? t("staff.persona.timeCert.pendingChip")
                      : t("staff.persona.timeCert.requestBtn")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── My certification history ── */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("staff.persona.timeCert.historyTitle")}
        </h2>
        {certs.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6">
            {t("staff.persona.timeCert.noHistory")}
          </div>
        ) : (
          <div className="space-y-2">
            {certs.map((c) => (
              <div key={c.id} className="border border-slate-200 rounded-lg p-2.5 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {bkkDisplay(c.proposed_ts)}
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold whitespace-nowrap ${
                    c.status === "pending" ? "bg-amber-100 text-amber-700"
                    : c.status === "approved" ? "bg-emerald-100 text-emerald-700"
                    : "bg-rose-100 text-rose-700"
                  }`}>
                    {t(`staff.persona.timeCert.status.${c.status}`)}
                  </span>
                </div>
                <div className="text-xs text-slate-700">{c.reason}</div>
                {c.decision_note && (
                  <div className="text-[11px] text-slate-500 italic">
                    {t("staff.persona.timeCert.adminNote")}: "{c.decision_note}"
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
