"use client";

// Shared inline-expand viewer for a daily_reports row's full content.
// Used by both:
//   - /admin/persona/shift-reports (supervisor verifying what staff
//     submitted today, before approving or asking for re-do)
//   - /staff/persona/shift/* locked screens (staff re-checking what
//     they just submitted before deciding whether to ask for an
//     edit unlock)
//
// Lives in /components so both client-component callers can import
// without duplicating the ~100-line render logic. Visual conventions
// mirror the LINE Flex card + staff form so what admin sees here
// matches what staff saw when filling it:
//   ✓ checked    emerald
//   📝 skipped   amber + reason indented
//   ✗ not done   rose bold
//   section      muted small-caps header
//   amount/text  shows the typed value as the "↳ value" line
//
// Caller owns the loading + fetching; this component just renders
// whatever state it's given.

export type ReportDetail = {
  id: number;
  type: "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600";
  report_date: string;
  created_at: string;
  opener_name: string;
  opener_prefix: string | null;
  is_revision: boolean;
  data: {
    yesterday_closing_amount?: number | null;
    morning_drawer_amount?: number | null;
    closing_drawer_amount?: number | null;
    service_charge_amount?: number | null;
    checklist?: Array<{
      label: string;
      checked: boolean;
      note?: string | null;
      kind?: string;
      is_child?: boolean;
      is_headline?: boolean;
      description?: string | null;
    }>;
  };
};

function fmtBaht(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} บาท`;
}

export default function ReportDetailView({
  reportId,
  detail,
  loading,
  error,
  t
}: {
  reportId: number;
  detail: ReportDetail | null;
  loading: boolean;
  error: string | null;
  /** Pass the parent's translator. We keep ReportDetailView
   *  i18n-agnostic (no useLang call here) so it can be embedded
   *  in either a Lang-rooted page or a server-rendered context
   *  that already has `t` bound. */
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  if (loading) {
    return (
      <div className="ml-7 pl-3 border-l-2 border-slate-200 py-2">
        <div className="text-xs text-slate-500">
          {t("admin.persona.shiftReports.detail.loading")}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ml-7 pl-3 border-l-2 border-rose-300 py-2">
        <div className="text-xs text-rose-700">
          ✗ {t("admin.persona.shiftReports.detail.loadError")}: {error}
        </div>
      </div>
    );
  }
  if (!detail) return null;

  const data = detail.data;
  const checklist = data.checklist ?? [];

  // Numeric fields rendered as a small key/value table at top.
  // Skipped entirely for readiness reports where these don't exist.
  const amounts: Array<{ label: string; value: number | null | undefined }> = [];
  if (detail.type === "shift_open") {
    amounts.push({
      label: t("admin.persona.shiftReports.detail.yesterdayClosing"),
      value: data.yesterday_closing_amount
    });
    amounts.push({
      label: t("admin.persona.shiftReports.detail.morningDrawer"),
      value: data.morning_drawer_amount
    });
  } else if (detail.type === "shift_close") {
    if (data.closing_drawer_amount != null) {
      amounts.push({
        label: t("admin.persona.shiftReports.detail.closingDrawer"),
        value: data.closing_drawer_amount
      });
    }
    if (data.service_charge_amount != null) {
      amounts.push({
        label: t("admin.persona.shiftReports.detail.serviceCharge"),
        value: data.service_charge_amount
      });
    }
  }

  return (
    <div className="ml-7 pl-3 border-l-2 border-emerald-200 py-2 space-y-2">
      <div className="text-[10px] font-bold tracking-[1px] text-emerald-700 uppercase">
        {t("admin.persona.shiftReports.detail.heading", { id: reportId })}
      </div>

      {amounts.length > 0 && (
        <div className="rounded bg-slate-50 border border-slate-200 p-2.5 space-y-1">
          {amounts.map((a) => (
            <div key={a.label} className="flex justify-between text-xs">
              <span className="text-slate-500">{a.label}</span>
              <span className="font-mono font-bold text-slate-800">
                {fmtBaht(a.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {checklist.length === 0 ? (
        <div className="text-xs text-slate-400 italic">
          {t("admin.persona.shiftReports.detail.emptyChecklist")}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {checklist.map((it, i) => {
            // Section header — non-interactive group title.
            if (it.kind === "section") {
              return (
                <li key={i} className={`pt-2 ${it.is_child ? "pl-4" : ""}`}>
                  <div className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                    {it.label}
                  </div>
                </li>
              );
            }
            const note = it.note?.trim();
            const skipped = !it.checked && !!note;
            const icon = it.checked ? "✓" : skipped ? "📝" : "✗";
            const iconCls = it.checked
              ? "text-emerald-700"
              : skipped ? "text-amber-700"
              : "text-rose-600";
            const labelCls = it.checked
              ? "text-slate-800"
              : skipped ? "text-slate-700"
              : "text-rose-700 font-bold";
            return (
              <li
                key={i}
                className={`flex items-start gap-2 text-xs ${it.is_child ? "pl-4" : ""}`}
              >
                <span className={`text-sm leading-none mt-0.5 ${iconCls}`}>{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className={labelCls}>{it.label}</div>
                  {it.description?.trim() && (
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      {it.description.trim()}
                    </div>
                  )}
                  {note && (
                    <div className={`text-[11px] mt-0.5 font-mono ${
                      skipped ? "text-amber-700" : "text-slate-700"
                    }`}>
                      ↳ {note}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
