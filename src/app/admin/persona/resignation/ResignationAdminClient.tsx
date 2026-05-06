"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { ResignationStatus } from "@/app/staff/persona/resignation/ResignationClient";

export type ResignationAdminRow = {
  id: number;
  user_id: number;
  proposed_last_day: string;
  computed_min_last_day: string;
  reason: string;
  evidence_filename: string | null;
  is_special_request: number;
  status: ResignationStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  username: string;
  display_name: string;
  hire_date: string | null;
  decided_by_name: string | null;
};

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "all";
const FILTERS: StatusFilter[] = ["pending", "approved", "rejected", "cancelled", "all"];

export default function ResignationAdminClient({
  currentStatus,
  countMap,
  requests
}: {
  currentStatus: StatusFilter;
  countMap: Record<string, number>;
  requests: ResignationAdminRow[];
}) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);

  function decide(id: number, decision: "approved" | "rejected") {
    const promptMsg = decision === "approved"
      ? t("admin.persona.resignation.notePromptApprove")
      : t("admin.persona.resignation.notePromptReject");
    const note = prompt(promptMsg);
    if (note === null) return;
    setBusyId(id);
    fetch(apiUrl(`/api/admin/persona/resignation/${id}/decide`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, note: note || undefined })
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) startTransition(() => router.refresh());
        else alert(j?.error ?? t("common.error"));
      })
      .catch(() => alert(t("common.error")))
      .finally(() => setBusyId(null));
  }

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = currentStatus === f;
          const n = f === "all"
            ? Object.values(countMap).reduce((a, b) => a + b, 0)
            : (countMap[f] ?? 0);
          return (
            <Link
              key={f}
              href={`/admin/persona/resignation?status=${f}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                active
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-slate-700 border-slate-200 hover:border-brand"
              }`}
            >
              {t(`admin.persona.leave.filter.${f}` as any)}
              <span className={`ml-1.5 text-xs ${active ? "text-white/80" : "text-slate-400"}`}>
                {n}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("admin.persona.resignation.listTitle")} ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-slate-500 text-sm py-6 text-center">
            {t("admin.persona.resignation.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => {
              const earlier = r.proposed_last_day < r.computed_min_last_day;
              return (
                <li key={r.id} className="border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition">
                  <div className="flex flex-wrap justify-between items-start gap-2 mb-1">
                    <div className="flex-1 min-w-[200px]">
                      <div className="font-medium text-slate-800">
                        {r.display_name}
                        <span className="text-xs text-slate-400 ml-1.5">@{r.username}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-sm font-medium text-slate-700">
                          {t("admin.persona.resignation.lastDayLabel")}: {formatDate(r.proposed_last_day)}
                        </span>
                        {r.is_special_request === 1 && (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-violet-100 text-violet-700 border border-violet-300">
                            {t("admin.persona.leave.specialBadge")}
                          </span>
                        )}
                        {earlier && (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-rose-100 text-rose-700">
                            {t("admin.persona.resignation.earlierBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {t("admin.persona.resignation.minLastDayInfo", {
                          minLastDay: formatDate(r.computed_min_last_day)
                        })}
                      </div>
                      {r.hire_date && (
                        <div className="text-xs text-slate-500">
                          {t("admin.persona.resignation.hireDate")}: {formatDate(r.hire_date)}
                        </div>
                      )}
                      <div className="text-xs text-slate-500 mt-1.5 italic">"{r.reason}"</div>
                      {r.evidence_filename && (
                        <a
                          href={apiUrl(`/api/persona/resignation/${r.id}/attachment`)}
                          target="_blank" rel="noopener"
                          className="inline-block text-xs text-brand hover:underline mt-1"
                        >
                          {t("staff.persona.leave.viewEvidence")}
                        </a>
                      )}
                      {r.decision_note && r.decided_by_name && (
                        <div className="text-xs text-slate-600 mt-1.5 bg-slate-100 px-2 py-1 rounded">
                          <span className="font-medium">{r.decided_by_name}:</span> {r.decision_note}
                        </div>
                      )}
                    </div>
                    {r.status === "pending" && (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          disabled={pending || busyId === r.id}
                          onClick={() => decide(r.id, "approved")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50"
                        >
                          {t("admin.persona.leave.approve")}
                        </button>
                        <button
                          type="button"
                          disabled={pending || busyId === r.id}
                          onClick={() => decide(r.id, "rejected")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-rose-500 hover:bg-rose-600 text-white disabled:opacity-50"
                        >
                          {t("admin.persona.leave.reject")}
                        </button>
                      </div>
                    )}
                    {r.status !== "pending" && (
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        r.status === "approved" ? "bg-emerald-100 text-emerald-700" :
                        r.status === "rejected" ? "bg-rose-100 text-rose-700" :
                        "bg-slate-100 text-slate-500"
                      }`}>
                        {t(`leave.status.${r.status}` as any)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
