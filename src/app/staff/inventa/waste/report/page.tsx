import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, isAdminCapable } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { fmtMoney } from "@/lib/format";
import { wasteSummary } from "@/lib/inventa-waste-server";
import { wasteReasonLabel } from "@/lib/inventa-waste";

export const dynamic = "force-dynamic";

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function bkkMonth(): string { return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7); }
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Admin-only monthly waste report (owner 2026-09-22): total value, by-reason,
// and the costliest items — so the owner can act on where money is lost.
export default function WasteReportPage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requireUser();
  if (!isAdminCapable(user)) redirect("/staff/inventa/waste");

  const lang = getLang();
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : bkkMonth();
  const branchId = user.activeBranchId ?? null;
  const branchName = user.branches.find((b) => b.id === branchId)?.name ?? null;
  const sum = wasteSummary(branchId, month);

  const [, mm] = month.split("-").map(Number);
  const monthLabel = lang === "en" ? month : `${TH_MONTHS[mm]} ${Number(month.slice(0, 4)) + 543}`;
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const isFuture = next > bkkMonth();
  const href = (m: string) => `/staff/inventa/waste/report?month=${m}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/staff/inventa/waste" className="text-sm text-slate-500 hover:text-brand">← {t(lang, "inv.waste.title")}</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "inv.waste.report.title")}
          {branchName && <span className="ml-2 text-sm font-medium text-brand">· {branchName}</span>}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "inv.waste.report.subtitle")}</p>
      </div>

      <div className="card flex items-center justify-between gap-2">
        <Link href={href(prev)} className="text-sm px-3 py-1.5 rounded-full border border-slate-200 hover:bg-slate-50">←</Link>
        <div className="text-center">
          <div className="text-[11px] text-slate-400">{t(lang, "inv.waste.report.month")}</div>
          <div className="font-bold text-slate-800">{monthLabel}</div>
        </div>
        {isFuture
          ? <span className="text-sm px-3 py-1.5 rounded-full border border-slate-100 text-slate-300">→</span>
          : <Link href={href(next)} className="text-sm px-3 py-1.5 rounded-full border border-slate-200 hover:bg-slate-50">→</Link>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">{t(lang, "inv.waste.report.totalValue")}</div>
          <div className="text-2xl font-bold text-rose-600 mt-0.5">{fmtMoney(sum.totalValue)}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">{t(lang, "inv.waste.report.events")}</div>
          <div className="text-2xl font-bold text-slate-800 mt-0.5">{sum.totalEvents}</div>
        </div>
      </div>

      {sum.totalEvents === 0 ? (
        <div className="card text-sm text-slate-400 text-center py-6">{t(lang, "inv.waste.report.empty")}</div>
      ) : (
        <>
          <div className="card overflow-x-auto">
            <h2 className="font-bold text-slate-800 mb-2">{t(lang, "inv.waste.report.byReason")}</h2>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">{t(lang, "inv.waste.col.reason")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "inv.waste.report.count")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "inv.waste.col.value")}</th>
              </tr></thead>
              <tbody>
                {sum.byReason.map((b) => (
                  <tr key={b.reason} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3">{wasteReasonLabel(b.reason, lang)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{b.qtyEvents}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(b.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card overflow-x-auto">
            <h2 className="font-bold text-slate-800 mb-2">{t(lang, "inv.waste.report.topItems")}</h2>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">{t(lang, "inv.waste.col.item")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "inv.waste.report.count")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "inv.waste.col.value")}</th>
              </tr></thead>
              <tbody>
                {sum.topItems.map((it) => (
                  <tr key={it.item_name} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 text-slate-800">{it.item_name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{it.qtyEvents}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(it.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
