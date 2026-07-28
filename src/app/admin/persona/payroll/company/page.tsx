import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รอบบริษัท · ค่าตอบแทน" };

// Landing for the company-wide payout view (owner 2026-07-28: แยกเป็นเมนู —
// ทำแยกสาขาให้ข้อมูลตรงก่อน แล้วมาที่นี่เพื่อทำจ่าย เพราะเงินออกบัญชีเดียว).
// Lists each company pay-cycle (the per-branch periods sharing one
// cycle/target/dates/pay_date), then links into the combined /cycle/[id] page.

type CycleRow = {
  cycle: string;
  target: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  rep_id: number;
  branch_count: number;
  n_finalized: number;
  n_paid: number;
  n_posted: number;
  total_net: number | null;
};

function catLabel(r: CycleRow, lang: Lang): { label: string; cls: string } {
  if (r.cycle === "monthly") return { label: t(lang, "admin.persona.payroll.hub.cat.ftMonthly"), cls: "bg-emerald-100 text-emerald-700" };
  if (r.target === "pt") return { label: t(lang, "admin.persona.payroll.hub.cat.pt"), cls: "bg-violet-100 text-violet-700" };
  if (r.target === "ft") return { label: t(lang, "admin.persona.payroll.hub.cat.ftWeekly"), cls: "bg-emerald-50 text-emerald-700" };
  return { label: t(lang, "admin.persona.payroll.hub.targetAll"), cls: "bg-slate-100 text-slate-700" };
}

function frac(done: number, n: number): { text: string; cls: string } {
  const cls = done === 0 ? "text-slate-400" : done === n ? "text-emerald-600" : "text-amber-600";
  return { text: `${done}/${n}`, cls };
}

export default function CompanyPayrollPage() {
  const user = requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  // The company's branches. A NULL company_id branch is treated as its own
  // company of one.
  const companyBranchIds = (branch.company_id != null
    ? (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(branch.company_id) as Array<{ id: number }>)
    : [{ id: branch.id }]
  ).map((r) => r.id);
  const ph = companyBranchIds.map(() => "?").join(",");

  const cycles = db.prepare(`
    SELECT p.cycle, p.target, p.period_start, p.period_end, p.pay_date,
           MIN(p.id) AS rep_id,
           COUNT(*) AS branch_count,
           SUM(CASE WHEN p.status IN ('finalized','paid') THEN 1 ELSE 0 END) AS n_finalized,
           SUM(CASE WHEN p.status = 'paid' THEN 1 ELSE 0 END) AS n_paid,
           SUM(CASE WHEN p.posted_at IS NOT NULL THEN 1 ELSE 0 END) AS n_posted,
           COALESCE(SUM(pl.net), 0) AS total_net
    FROM payroll_periods p
    LEFT JOIN (
      SELECT period_id, SUM(net_pay) AS net FROM payroll_lines GROUP BY period_id
    ) pl ON pl.period_id = p.id
    WHERE p.branch_id IN (${ph})
    GROUP BY p.cycle, p.target, p.period_start, p.period_end, p.pay_date
    ORDER BY p.period_end DESC, p.pay_date DESC
    LIMIT 24
  `).all(...companyBranchIds) as CycleRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.company.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {t(lang, "admin.persona.payroll.company.subtitle")}
        </p>
      </div>

      <div className="card overflow-x-auto">
        {cycles.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">{t(lang, "admin.persona.payroll.hub.noPeriods")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.cycle")}</th>
                <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.period")}</th>
                <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.payDate")}</th>
                <th className="py-2 pr-3 text-center">{t(lang, "admin.persona.payroll.cycle.branch")}</th>
                <th className="py-2 pr-3 text-center">{t(lang, "admin.persona.payroll.status.finalized")}</th>
                <th className="py-2 pr-3 text-center">{t(lang, "admin.persona.payroll.status.paid")}</th>
                <th className="py-2 pr-3 text-center">{t(lang, "admin.persona.payroll.cycle.posted")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((r) => {
                const cat = catLabel(r, lang);
                const f = frac(r.n_finalized, r.branch_count);
                const pd = frac(r.n_paid, r.branch_count);
                const po = frac(r.n_posted, r.branch_count);
                return (
                  <tr key={r.rep_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${cat.cls}`}>{cat.label}</span>
                    </td>
                    <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">
                      {formatLongDate(r.period_start, lang)} – {formatLongDate(r.period_end, lang)}
                    </td>
                    <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">{formatLongDate(r.pay_date, lang)}</td>
                    <td className="py-2 pr-3 text-center text-slate-600">{r.branch_count}</td>
                    <td className={`py-2 pr-3 text-center font-medium ${f.cls}`}>{f.text}</td>
                    <td className={`py-2 pr-3 text-center font-medium ${pd.cls}`}>{pd.text}</td>
                    <td className={`py-2 pr-3 text-center font-medium ${po.cls}`}>{po.text}</td>
                    <td className="py-2 pr-3 text-right font-medium">{r.total_net != null ? fmtMoney(r.total_net) : "—"}</td>
                    <td className="py-2 pr-3 text-right">
                      <Link href={`/admin/persona/payroll/cycle/${r.rep_id}`} className="text-xs text-brand hover:underline whitespace-nowrap">
                        {t(lang, "admin.persona.payroll.company.open")} →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-slate-400">{t(lang, "admin.persona.payroll.company.note")}</p>
    </div>
  );
}
