"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { PendingCertRow } from "./page";

function bkkDisplay(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16).replace("T", " ");
}

export default function TimeCertificationsClient({
  pending
}: {
  pending: PendingCertRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectForm, setRejectForm] = useState<{ id: number; note: string } | null>(null);

  async function decide(certId: number, decision: "approved" | "rejected", note?: string) {
    setBusyId(certId);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/time-certification/${certId}/decide`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            decision_note: note?.trim() || undefined
          })
        }
      );
      if (!res.ok) throw new Error("decide failed");
      router.refresh();
      setRejectForm(null);
    } finally {
      setBusyId(null);
    }
  }

  if (pending.length === 0) {
    return (
      <div className="card text-sm text-slate-400 text-center py-10">
        {t("admin.persona.timeCert.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pending.map((r) => {
        const busy = busyId === r.id;
        return (
          <div key={r.id} className="card border-l-4 border-amber-400 space-y-3">
            <div>
              <div className="text-xs text-slate-400 tracking-[0.5px] uppercase">
                {t("admin.persona.timeCert.requesterLabel")}
              </div>
              <div className="font-bold text-slate-800 text-sm mt-0.5">
                {r.requester_name}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-[10px] uppercase tracking-[1px] text-slate-500 font-bold">
                  {t("admin.persona.timeCert.original")}
                </div>
                <div className="font-mono mt-0.5">{bkkDisplay(r.original_ts)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[1px] text-emerald-700 font-bold">
                  {t("admin.persona.timeCert.proposed")}
                </div>
                <div className="font-mono mt-0.5 text-emerald-700 font-bold">
                  {bkkDisplay(r.proposed_ts)}
                </div>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded p-2.5">
              <div className="text-[10px] uppercase tracking-[1px] text-amber-700 font-bold mb-1">
                {t("admin.persona.timeCert.reasonLabel")}
              </div>
              <div className="text-sm text-slate-800 whitespace-pre-wrap">{r.reason}</div>
            </div>

            {rejectForm?.id === r.id ? (
              <div className="space-y-2 bg-rose-50/50 border border-rose-200 rounded-lg p-3">
                <textarea
                  className="input text-sm"
                  rows={2}
                  maxLength={500}
                  placeholder={t("admin.persona.timeCert.rejectNotePlaceholder")}
                  value={rejectForm.note}
                  onChange={(e) => setRejectForm({ ...rejectForm, note: e.target.value })}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRejectForm(null)}
                    disabled={busy}
                    className="btn-secondary flex-1 text-sm"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(r.id, "rejected", rejectForm.note)}
                    disabled={busy}
                    className="btn-danger flex-1 text-sm"
                  >
                    {busy ? t("common.submitting") : t("admin.persona.timeCert.rejectSubmit")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRejectForm({ id: r.id, note: "" })}
                  disabled={busy}
                  className="btn-secondary flex-1 text-sm"
                >
                  {t("admin.persona.timeCert.reject")}
                </button>
                <button
                  type="button"
                  onClick={() => decide(r.id, "approved")}
                  disabled={busy}
                  className="btn-primary flex-1 text-sm"
                >
                  {busy ? t("common.submitting") : t("admin.persona.timeCert.approve")}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
