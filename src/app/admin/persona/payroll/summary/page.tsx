import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สรุปประจำเดือน · ค่าตอบแทน" };

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function todayMonth(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 7);
}

function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${String(lastDay).padStart(2, "0")}`
  };
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthLabel(yearMonth: string, lang: Lang): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const months = lang === "th" ? TH_MONTHS : EN_MONTHS;
  const yearDisplay = lang === "th" ? y + 543 : y;
  return `${months[m - 1]} ${yearDisplay}`;
}

// fmtMoney moved to @/lib/format (2026-05) — imported above so every
// payroll surface shares an identical 2dp shape.

// Per-employee aggregate row across all periods that pay in the month
type EmpRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number;
  total_sso: number;
  total_tax: number;
  total_net: number;
  period_count: number;
};

// Per-period aggregate (header summary of each period)
type PeriodRow = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  total_gross: number | null;
  total_sso: number | null;
  total_tax: number | null;
  total_net: number | null;
  line_count: number;
};

export default function PayrollMonthlySummaryPage({
  searchParams
}: {
  searchParams: { m?: string };
}) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const month = /^\d{4}-\d{2}$/.test(searchParams.m ?? "")
    ? searchParams.m!
    : todayMonth();
  const { from, to } = monthRange(month);

  // All periods whose pay_date falls in this month
  const periods = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.status,
           (SELECT SUM(gross_pay)  FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(sso_amount) FROM payroll_lines WHERE period_id = p.id) AS total_sso,
           (SELECT SUM(tax_amount) FROM payroll_lines WHERE period_id = p.id) AS total_tax,
           (SELECT SUM(net_pay)    FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)        FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    WHERE p.pay_date >= ? AND p.pay_date <= ?
    ORDER BY p.pay_date, p.id
  `).all(from, to) as PeriodRow[];

  // Per-employee aggregate across all those periods
  const empRows = db.prepare(`
    SELECT pl.user_id,
           pl.display_name,
           u.title_prefix,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
    GROUP BY pl.user_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(from, to) as EmpRow[];

  // Aggregate totals
  const totals = empRows.reduce(
    (acc, r) => ({
      gross: acc.gross + (r.total_gross ?? 0),
      sso:   acc.sso   + (r.total_sso   ?? 0),
      tax:   acc.tax   + (r.total_tax   ?? 0),
      net:   acc.net   + (r.total_net   ?? 0),
      ssoEmployees: acc.ssoEmployees + (r.salary_tax_mode_snapshot === "sso" ? 1 : 0),
      whtEmployees: acc.whtEmployees + (r.salary_tax_mode_snapshot === "wht" ? 1 : 0)
    }),
    { gross: 0, sso: 0, tax: 0, net: 0, ssoEmployees: 0, whtEmployees: 0 }
  );

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, +1);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.summary.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.payroll.summary.subtitle")}
        </p>
      </div>

      {/* Month nav */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/admin/persona/payroll/summary?m=${prev}`}
          className="text-sm px-3 py-1.5 rounded-md text-slate-700 hover:bg-slate-100 whitespace-nowrap"
        >
          ← {monthLabel(prev, lang)}
        </Link>
        <div className="text-lg font-bold text-slate-800 whitespace-nowrap">
          {monthLabel(month, lang)}
        </div>
        <Link
          href={`/admin/persona/payroll/summary?m=${next}`}
          className="text-sm px-3 py-1.5 rounded-md text-slate-700 hover:bg-slate-100 whitespace-nowrap"
        >
          {monthLabel(next, lang)} →
        </Link>
      </div>

      {/* Export for downstream documents (ภ.ง.ด.1 / SSO / bank) — owner 2026-07-04 */}
      {empRows.length > 0 && (
        <div className="flex justify-end">
          <a
            href={`/api/admin/persona/payroll/summary/csv?m=${month}`}
            className="text-sm px-4 py-2 rounded-lg border border-brand text-brand font-medium hover:bg-amber-50"
          >
            ⬇ ดาวน์โหลด CSV (ต่อพนักงาน)
          </a>
        </div>
      )}

      {periods.length === 0 ? (
        <div className="card text-sm text-slate-500 py-8 text-center">
          {t(lang, "admin.persona.payroll.summary.empty")}
        </div>
      ) : (
        <>
          {/* Aggregate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.summary.totalGross")}
              </div>
              <div className="text-2xl font-bold mt-1 text-slate-800">{fmtMoney(totals.gross)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {periods.length} {t(lang, "admin.persona.payroll.summary.periodsLabel")} · {empRows.length} {t(lang, "admin.persona.payroll.col.staff")}
              </div>
            </div>
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.col.sso")}
              </div>
              <div className="text-2xl font-bold mt-1 text-sky-700">{fmtMoney(totals.sso)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.ssoEmployees} {t(lang, "admin.persona.payroll.summary.ssoEmpLabel")}
              </div>
            </div>
            <div className="card">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.col.tax")}
              </div>
              <div className="text-2xl font-bold mt-1 text-amber-700">{fmtMoney(totals.tax)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.whtEmployees} {t(lang, "admin.persona.payroll.summary.whtEmpLabel")}
              </div>
            </div>
            <div className="card border-2 border-emerald-300 bg-emerald-50/40">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.summary.totalNet")}
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(totals.net)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {t(lang, "admin.persona.payroll.summary.totalNetHint")}
              </div>
            </div>
          </div>

          {/* Per-employee breakdown */}
          <div className="card overflow-x-auto">
            <h2 className="font-semibold text-slate-700 mb-3">
              {t(lang, "admin.persona.payroll.summary.perEmployeeTitle")}
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.staff")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.summary.periodsLabel")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                </tr>
              </thead>
              <tbody>
                {empRows.map((r) => (
                  <tr key={r.user_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                        <span>{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                        {r.employment_type === "pt" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                            {t(lang, "admin.persona.employees.employment.pt")}
                          </span>
                        )}
                        {r.employment_type === "ft" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                            {t(lang, "admin.persona.employees.employment.ft")}
                          </span>
                        )}
                        {r.salary_tax_mode_snapshot === "wht" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                            {t(lang, "admin.persona.employees.taxMode.whtTag")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-600">{r.period_count}</td>
                    <td className="py-2 pr-3 text-right">{fmtMoney(r.total_gross ?? 0)}</td>
                    <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(r.total_sso ?? 0)}</td>
                    <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(r.total_tax ?? 0)}</td>
                    <td className="py-2 pr-3 text-right font-bold text-emerald-700">{fmtMoney(r.total_net ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-medium">
                  <td className="py-2 pr-3">{t(lang, "admin.persona.payroll.detail.total")}</td>
                  <td className="py-2 pr-3 text-right text-slate-500">{periods.length}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(totals.gross)}</td>
                  <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(totals.sso)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(totals.tax)}</td>
                  <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Per-period list */}
          <div className="card overflow-x-auto">
            <h2 className="font-semibold text-slate-700 mb-3">
              {t(lang, "admin.persona.payroll.summary.perPeriodTitle")}
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.cycle")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.period")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.payDate")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.status")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => {
                  const catLabel =
                    p.cycle === "monthly" ? t(lang, "admin.persona.payroll.hub.cat.ftMonthly") :
                    p.target === "pt"     ? t(lang, "admin.persona.payroll.hub.cat.pt") :
                                            t(lang, "admin.persona.payroll.hub.cat.ftWeekly");
                  const catCls =
                    p.cycle === "monthly" ? "bg-emerald-100 text-emerald-700" :
                    p.target === "pt"     ? "bg-violet-100 text-violet-700" :
                                            "bg-emerald-50 text-emerald-700";
                  const statusCls =
                    p.status === "paid" ? "bg-sky-100 text-sky-700" :
                    p.status === "finalized" ? "bg-emerald-100 text-emerald-700" :
                    "bg-amber-100 text-amber-700";
                  const statusLabel = t(lang, `admin.persona.payroll.status.${p.status}` as any);
                  return (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${catCls}`}>{catLabel}</span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">
                        {formatLongDate(p.period_start, lang)} – {formatLongDate(p.period_end, lang)}
                      </td>
                      <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">{formatLongDate(p.pay_date, lang)}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusCls}`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right">{fmtMoney(p.total_gross ?? 0)}</td>
                      <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(p.total_sso ?? 0)}</td>
                      <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(p.total_tax ?? 0)}</td>
                      <td className="py-2 pr-3 text-right font-medium text-emerald-700">{fmtMoney(p.total_net ?? 0)}</td>
                      <td className="py-2 pr-3 text-right">
                        <Link
                          href={`/admin/persona/payroll/${p.id}`}
                          className="text-xs text-brand hover:underline whitespace-nowrap"
                        >
                          {t(lang, "admin.persona.payroll.hub.openPeriod")} →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
