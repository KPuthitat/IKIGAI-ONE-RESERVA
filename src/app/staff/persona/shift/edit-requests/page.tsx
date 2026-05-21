// /staff/persona/shift/edit-requests — staff's history of their own
// edit requests across all 4 daily-report types. Read-only; lets the
// requester see the status (pending / granted / rejected) and admin's
// decision_note when present, so they don't have to chase the LINE
// group to know whether a request is still open.

import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "คำขอแก้ไขรายการ · PERSONA" };

type RequestRow = {
  id: number;
  reason: string;
  status: "pending" | "granted" | "rejected";
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  report_type: string;
  report_date: string;
  branch_name: string;
  decided_by_name: string | null;
  decided_by_prefix: string | null;
};

function formatBkkDateTime(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = bkk.getUTCFullYear();
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bkk.getUTCDate()).padStart(2, "0");
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mi = String(bkk.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function typeLabel(type: string, lang: Lang): string {
  switch (type) {
    case "shift_open":     return t(lang, "staff.persona.shiftReport.typeLabel.shiftOpen");
    case "shift_close":    return t(lang, "staff.persona.shiftReport.typeLabel.shiftClose");
    case "readiness_1130": return t(lang, "staff.persona.shiftReport.typeLabel.readiness1130");
    case "readiness_1600": return t(lang, "staff.persona.shiftReport.typeLabel.readiness1600");
    default: return type;
  }
}

function statusBadge(s: RequestRow["status"], lang: Lang) {
  if (s === "pending") return {
    cls: "bg-amber-100 text-amber-700",
    label: t(lang, "staff.persona.editRequests.status.pending")
  };
  if (s === "granted") return {
    cls: "bg-emerald-100 text-emerald-700",
    label: t(lang, "staff.persona.editRequests.status.granted")
  };
  return {
    cls: "bg-rose-100 text-rose-700",
    label: t(lang, "staff.persona.editRequests.status.rejected")
  };
}

export default function StaffEditRequestsPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();

  // Pull this user's recent requests (most recent 30). Joining
  // daily_reports + branches gives admin-like context (which report,
  // when, which branch) so staff can interpret the row without
  // remembering what the original report was. LEFT JOIN on the
  // decided_by user since pending requests have it null.
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.status, r.created_at, r.decided_at,
           r.decision_note,
           dr.type AS report_type, dr.report_date,
           b.name AS branch_name,
           du.display_name AS decided_by_name,
           du.title_prefix AS decided_by_prefix
    FROM shift_unlock_requests r
    JOIN daily_reports dr ON dr.id = r.daily_report_id
    JOIN branches b ON b.id = dr.branch_id
    LEFT JOIN users du ON du.id = r.decided_by
    WHERE r.requested_by = ?
    ORDER BY r.created_at DESC
    LIMIT 30
  `).all(user.id) as RequestRow[];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.persona.editRequests.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.persona.editRequests.subtitle")}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card text-sm text-slate-400 text-center py-10">
          {t(lang, "staff.persona.editRequests.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const badge = statusBadge(r.status, lang);
            return (
              <div key={r.id} className="card space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-xs text-slate-400 tracking-[0.5px] uppercase">
                      {r.branch_name} · {r.report_date}
                    </div>
                    <div className="font-bold text-slate-800 text-sm mt-0.5">
                      {typeLabel(r.report_type, lang)}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-1 rounded font-bold whitespace-nowrap ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded p-2.5">
                  <div className="text-[10px] font-bold tracking-[1px] text-slate-500 uppercase mb-1">
                    {t(lang, "staff.persona.editRequests.yourReason")}
                  </div>
                  <div className="text-sm text-slate-700 whitespace-pre-wrap">
                    {r.reason}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1.5">
                    {t(lang, "staff.persona.editRequests.requestedAt", {
                      time: formatBkkDateTime(r.created_at)
                    })}
                  </div>
                </div>

                {r.status !== "pending" && (
                  <div className={`border rounded p-2.5 ${
                    r.status === "granted"
                      ? "bg-emerald-50 border-emerald-200"
                      : "bg-rose-50 border-rose-200"
                  }`}>
                    <div className={`text-[10px] font-bold tracking-[1px] uppercase mb-1 ${
                      r.status === "granted" ? "text-emerald-700" : "text-rose-700"
                    }`}>
                      {r.status === "granted"
                        ? t(lang, "staff.persona.editRequests.adminGranted")
                        : t(lang, "staff.persona.editRequests.adminRejected")}
                      {r.decided_by_name && ` · ${nameWithPrefix(r.decided_by_prefix, r.decided_by_name)}`}
                    </div>
                    {r.decision_note ? (
                      <div className="text-sm text-slate-800 whitespace-pre-wrap">
                        {r.decision_note}
                      </div>
                    ) : (
                      <div className="text-sm text-slate-500 italic">
                        {t(lang, "staff.persona.editRequests.noNote")}
                      </div>
                    )}
                    {r.decided_at && (
                      <div className="text-[10px] text-slate-400 mt-1.5">
                        {t(lang, "staff.persona.editRequests.decidedAt", {
                          time: formatBkkDateTime(r.decided_at)
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
