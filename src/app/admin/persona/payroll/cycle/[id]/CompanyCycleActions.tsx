"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { t, type Lang } from "@/lib/i18n";
import PinPromptModal from "@/app/components/PinPromptModal";
import ConfirmModal from "@/app/components/ConfirmModal";

type Sib = { id: number; branch_name: string | null; status: string; posted: boolean };
type CascadeResult = { period_id: number; branch: string | null; ok: boolean; skipped?: string; error?: string };

// One-action cascade over every branch period of a company cycle. Each button
// hits POST /cycle/[id] which loops the same guarded per-period op — finalize
// needs the PIN, pay/post gate on status, each branch posts to its own books.
export default function CompanyCycleActions({
  lang, repId, siblings
}: {
  lang: Lang;
  repId: number;
  siblings: Sib[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [confirmPay, setConfirmPay] = useState(false);
  const [results, setResults] = useState<CascadeResult[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [paidAt, setPaidAt] = useState(todayBkk);

  const n = siblings.length;
  const anyDraft = siblings.some((s) => s.status === "draft");
  const anyFinalized = siblings.some((s) => s.status === "finalized");
  const anyPaidUnposted = siblings.some((s) => s.status === "paid" && !s.posted);
  const anyPosted = siblings.some((s) => s.posted);

  async function cascade(action: string, extra?: Record<string, unknown>): Promise<{ ok: boolean; errorText?: string }> {
    setBusy(action);
    setMsg(null);
    setResults(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/cycle/${repId}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        const rs = (j.results ?? []) as CascadeResult[];
        setResults(rs);
        const done = rs.filter((r) => r.ok).length;
        setMsg({ kind: "ok", text: t(lang, "admin.persona.payroll.cycle.cascadeDone", { done: String(done), n: String(n) }) });
        startTransition(() => router.refresh());
        return { ok: true };
      }
      const errorText = j?.message ?? j?.error ?? t(lang, "common.error");
      setMsg({ kind: "err", text: errorText });
      return { ok: false, errorText };
    } catch {
      const errorText = t(lang, "common.error");
      setMsg({ kind: "err", text: errorText });
      return { ok: false, errorText };
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card border-l-4 border-brand/40">
      <h2 className="font-semibold text-slate-700 mb-1">{t(lang, "admin.persona.payroll.cycle.actionsTitle")}</h2>
      <p className="text-xs text-slate-500 mb-3">{t(lang, "admin.persona.payroll.cycle.actionsNote")}</p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          disabled={busy !== null || !anyDraft}
          className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "finalize_all" ? "..." : "✓ " + t(lang, "admin.persona.payroll.cycle.finalizeAll")}
        </button>

        <button
          type="button"
          onClick={() => setConfirmPay(true)}
          disabled={busy !== null || !anyFinalized}
          className="text-sm px-4 py-1.5 rounded-full bg-sky-600 hover:bg-sky-700 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "mark_paid_all" ? "..." : t(lang, "admin.persona.payroll.cycle.payAll")}
        </button>

        <button
          type="button"
          onClick={() => cascade("post_all")}
          disabled={busy !== null || !anyPaidUnposted}
          className="text-sm px-4 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "post_all" ? "..." : t(lang, "admin.persona.payroll.cycle.postAll")}
        </button>

        {anyFinalized && (
          <button
            type="button"
            onClick={() => cascade("unfinalize_all")}
            disabled={busy !== null}
            className="text-sm px-3 py-1.5 rounded-md text-slate-600 hover:bg-slate-100"
          >
            {busy === "unfinalize_all" ? "..." : "↺ " + t(lang, "admin.persona.payroll.cycle.unfinalizeAll")}
          </button>
        )}

        {anyPosted && (
          <button
            type="button"
            onClick={() => cascade("unpost_all")}
            disabled={busy !== null}
            className="text-sm px-3 py-1.5 rounded-md text-rose-700 hover:bg-rose-50"
          >
            {busy === "unpost_all" ? "..." : t(lang, "admin.persona.payroll.cycle.unpostAll")}
          </button>
        )}
      </div>

      {msg && (
        <div className={`text-sm mt-3 ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      {results && results.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {results.map((r) => (
            <li key={r.period_id} className="flex items-center gap-2">
              <span className={r.ok ? "text-emerald-600" : r.skipped ? "text-slate-400" : "text-rose-600"}>
                {r.ok ? "✓" : r.skipped ? "–" : "✗"}
              </span>
              <span className="text-slate-700">{r.branch ?? t(lang, "admin.persona.payroll.cycle.noBranch")}</span>
              {r.skipped && <span className="text-slate-400">({t(lang, "admin.persona.payroll.cycle.skipped")}: {r.skipped})</span>}
              {r.error && <span className="text-rose-500">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {pinOpen && (
        <PinPromptModal
          title={t(lang, "admin.persona.payroll.cycle.finalizeAll")}
          description={<p className="text-xs text-slate-600">{t(lang, "admin.persona.payroll.confirmFinalize")}</p>}
          submitLabel={t(lang, "admin.persona.payroll.cycle.finalizeAll")}
          onClose={() => setPinOpen(false)}
          onSubmit={async (pin) => {
            const r = await cascade("finalize_all", { pin });
            if (!r.ok) return { ok: false, message: r.errorText ?? t(lang, "common.error") };
            setPinOpen(false);
            return { ok: true };
          }}
        />
      )}

      <ConfirmModal
        open={confirmPay}
        title={t(lang, "admin.persona.payroll.cycle.payAll")}
        body={
          <div className="space-y-3">
            <p>{t(lang, "admin.persona.payroll.confirmPay")}</p>
            <div>
              <label className="label">{t(lang, "admin.persona.payroll.field.actualPaidDate")}</label>
              <input
                type="date"
                className="input"
                value={paidAt}
                max={todayBkk}
                onChange={(e) => setPaidAt(e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">{t(lang, "admin.persona.payroll.field.actualPaidDateHint")}</p>
            </div>
          </div>
        }
        confirmLabel={t(lang, "admin.persona.payroll.cycle.payAll")}
        cancelLabel={t(lang, "common.cancel")}
        variant="info"
        busy={busy === "mark_paid_all"}
        onConfirm={async () => {
          await cascade("mark_paid_all", { paid_at: paidAt });
          setConfirmPay(false);
        }}
        onCancel={() => setConfirmPay(false)}
      />
    </div>
  );
}
