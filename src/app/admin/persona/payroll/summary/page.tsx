import Link from "next/link";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import { monthlyPayrollRollup, type MonthPerson } from "@/lib/payroll-month";
import { listExportScopes } from "@/lib/payroll-summary-doc";
import ExportDialog from "./ExportDialog";

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
  const yearDisplay = lang === "th" ? `พ.ศ. ${y + 543}` : String(y);
  return `${months[m - 1]} ${yearDisplay}`;
}

// fmtMoney moved to @/lib/format (2026-05) — imported above so every
// payroll surface shares an identical 2dp shape.

// Per-person rows come from monthlyPayrollRollup (MonthPerson) — see @/lib/payroll-month.

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

  // ── ONE data set (owner 2026-10-01) ──────────────────────────────────
  // Every figure on this page comes from monthlyPayrollRollup — the same rollup
  // the export document and the monthly payslip read — so no surface can
  // disagree. The page only groups and renders.
  const rollup = monthlyPayrollRollup(db, month);
  const svcMonth = rollup.svcMonth;
  const homeByUser = rollup.homeByUser;
  type CompanyGroup = { key: number | null; name: string };
  const companyGroups: CompanyGroup[] = rollup.companies;
  type EmpCompanyRow = MonthPerson;
  const rowsByCompany = rollup.byCompany;

  // KPI card totals — payroll across all companies (distinct people for the
  // headcounts), SVC + meeting fee alongside.
  // Headcount = distinct people who had a payroll line (any company), by tax mode.
  const payrollModeByUser = new Map<number, "sso" | "wht" | null>();
  for (const p of rollup.people) if (p.hasPayroll && !payrollModeByUser.has(p.userId)) payrollModeByUser.set(p.userId, p.taxMode);
  const totals = rollup.people.reduce(
    (acc, p) => ({
      gross: acc.gross + p.comp,
      sso:   acc.sso   + p.sso,
      tax:   acc.tax   + p.taxWage,
      net:   acc.net   + p.payrollNet,
      ssoEmployees: acc.ssoEmployees,
      whtEmployees: acc.whtEmployees
    }),
    {
      gross: 0, sso: 0, tax: 0, net: 0,
      ssoEmployees: [...payrollModeByUser.values()].filter((m) => m === "sso").length,
      whtEmployees: [...payrollModeByUser.values()].filter((m) => m === "wht").length
    }
  );
  const grandSvc = rollup.people.reduce(
    (a, p) => ({ gross: a.gross + p.svcGross, wht: a.wht + p.svcWht, gi: a.gi + p.svcGi, net: a.net + p.svcNet,
                 mtgGross: a.mtgGross + p.mtgGross, mtgWht: a.mtgWht + p.mtgWht, mtgNet: a.mtgNet + p.mtgNet }),
    { gross: 0, wht: 0, gi: 0, net: 0, mtgGross: 0, mtgWht: 0, mtgNet: 0 }
  );
  const hasAnyRow = rollup.people.length > 0;

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, +1);

  // One merged table per employment type (owner 2026-07-27: แยกตาราง FT/PT +
  // รวม NAMA+HYPO เป็นแถวเดียว/คน). สังกัด = home branch; the per-branch net
  // columns are the where-they-worked split (บัญชีลงแยกสาขาตามนี้).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const money = (v: number, cls = "") =>
    v ? <span className={cls}>{fmtMoney(v)}</span> : <span className="text-slate-300">—</span>;
  // Per-row figures in the owner's statement order (2026-08-02): ค่าตอบแทน (สะสม
  // ทุกรอบจ่ายในเดือน) → SVC → เบี้ยประชุม → รวมรายรับ → หัก (ปกส./ภาษี/ประกันกลุ่ม) →
  // รวมรับจริง. SVC + meeting-fee WHT fold into the tax column; take = income − all
  // deductions.
  // All figures are pre-derived by the rollup (round2, stored-net anchored,
  // itemised parts capped) — this is a plain read so the page can't diverge.
  const figuresFor = (r: EmpCompanyRow, _companyKey: number | null) => ({
    comp: r.comp, svcGross: r.svcGross, mtgGross: r.mtgGross, income: r.income,
    sso: r.sso, tax: r.tax, gi: r.gi,
    inRound: r.inRound, drink: r.drink, mealpass: r.mealpass, otherDed: r.otherDed,
    unpaidDays: r.unpaidDays, baseCut: r.unpaidCut,
    ded: r.ded, take: r.take
  });
  // One table per (employment type × tax mode). Read-only overview — every figure
  // is the month's accumulation across pay rounds, sourced from the per-branch
  // payroll runs (owner 2026-09-03: แยกสัดส่วน ปกส./หัก ณ ที่จ่าย เป็นคนละตาราง; ยุบ
  // คอลัมน์รายสาขา + ตารางรอบจ่ายให้เรียบ). Columns collapse to: สังกัด · ค่าตอบแทน ·
  // SVC · รวมรายรับ · หัก · สุทธิ.
  const empTable = (title: string, subtitle: string, accent: string, rows: EmpCompanyRow[], companyKey: number | null) => {
    if (rows.length === 0) return null;
    // Figures once per row — the subtotal and the row cells read the same objects.
    const figs = rows.map((r) => ({ r, f: figuresFor(r, companyKey) }));
    const sub = figs.reduce(
      (a, { f }) => {
        return {
          comp: a.comp + f.comp, svcGross: a.svcGross + f.svcGross, mtgGross: a.mtgGross + f.mtgGross, income: a.income + f.income,
          sso: a.sso + f.sso, tax: a.tax + f.tax, gi: a.gi + f.gi, inRound: a.inRound + f.inRound, ded: a.ded + f.ded, take: a.take + f.take
        };
      },
      { comp: 0, svcGross: 0, mtgGross: 0, income: 0, sso: 0, tax: 0, gi: 0, inRound: 0, ded: 0, take: 0 }
    );
    return (
      <div className="card overflow-x-auto">
        <h3 className="font-semibold text-slate-700 mb-0.5">
          <span className={accent}>{title}</span> · {rows.length} {t(lang, "admin.persona.payroll.col.staff")}
        </h3>
        <p className="text-xs text-slate-400 mb-3">{subtitle}</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.staff")}</th>
              <th className="py-2 pr-3">สังกัด</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">ค่าตอบแทน</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">เซอร์วิสชาร์จ</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">เบี้ยประชุม</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">รวมรายรับ</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
              <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">ประกันกลุ่ม</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">หักระหว่างเดือน</th>
              <th className="py-2 pr-3 text-right whitespace-nowrap">รวมรับจริง</th>
            </tr>
          </thead>
          <tbody>
            {figs.map(({ r, f }) => {
              return (
                <tr key={r.userId} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{r.name}</div>
                    <Link
                      href={`/admin/persona/payroll/monthly-payslip/${r.userId}?m=${month}`}
                      className="text-[11px] text-brand hover:underline"
                    >
                      สลิปรายเดือน →
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{homeByUser.get(r.userId) ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {money(f.comp)}
                    {f.unpaidDays > 0 && (
                      <div className="text-[10px] text-rose-600 whitespace-nowrap">
                        ลาไม่รับค่าจ้าง/ขาดงาน {f.unpaidDays} วัน{f.baseCut > 0 ? ` −${fmtMoney(f.baseCut)}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-violet-700">{money(f.svcGross)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fuchsia-700">{money(f.mtgGross)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">{money(f.income)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-sky-700">{money(f.sso)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-amber-700">{money(f.tax)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{money(f.gi)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                    {money(f.inRound)}
                    {f.inRound > 0 && (
                      <div className="text-[10px] text-slate-400 whitespace-nowrap">
                        {[
                          f.drink > 0 ? `เครื่องดื่ม ${fmtMoney(f.drink)}` : null,
                          f.mealpass > 0 ? `อาหารข้ามบริษัท ${fmtMoney(f.mealpass)}` : null,
                          f.otherDed > 0 ? `อื่นๆ ${fmtMoney(f.otherDed)}` : null
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">{fmtMoney(f.take)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-medium">
              <td className="py-2 pr-3" colSpan={2}>
                {t(lang, "admin.persona.payroll.detail.total")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(sub.comp)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-violet-700">{fmtMoney(sub.svcGross)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-fuchsia-700">{fmtMoney(sub.mtgGross)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-800">{fmtMoney(sub.income)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-sky-700">{fmtMoney(sub.sso)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-700">{fmtMoney(sub.tax)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(sub.gi)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-600">{fmtMoney(sub.inRound)}</td>
              <td className="py-2 pr-3 text-right tabular-nums font-bold text-emerald-700">{fmtMoney(sub.take)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

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

      {/* Export for downstream documents (ภ.ง.ด.1 / SSO / bank). สร้างเอกสาร: pick
          company/branch + format (CSV/XLSX/PDF), with pay rounds + marked
          deductions (owner 2026-07-04 → 2026-09-06). */}
      {hasAnyRow && (
        <div className="flex justify-end">
          <ExportDialog month={month} scopes={listExportScopes(db, month, rollup)} />
        </div>
      )}

      {periods.length === 0 && companyGroups.length === 0 ? (
        <div className="card text-sm text-slate-500 py-8 text-center">
          {t(lang, "admin.persona.payroll.summary.empty")}
        </div>
      ) : (
        <>
          {/* Aggregate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card">
              <div className="text-xs text-slate-500">
                รวมรายรับ (ค่าตอบแทน + เซอร์วิสชาร์จ + เบี้ยประชุม)
              </div>
              <div className="text-2xl font-bold mt-1 text-slate-800">{fmtMoney(totals.gross + grandSvc.gross + grandSvc.mtgGross)}</div>
              <div className="text-xs text-slate-500 mt-1">
                ค่าตอบแทน {fmtMoney(totals.gross)}{grandSvc.gross > 0 ? ` + SVC ${fmtMoney(grandSvc.gross)}` : ""}{grandSvc.mtgGross > 0 ? ` + เบี้ยประชุม ${fmtMoney(grandSvc.mtgGross)}` : ""}
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
              <div className="text-2xl font-bold mt-1 text-amber-700">{fmtMoney(totals.tax + grandSvc.wht + grandSvc.mtgWht)}</div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.whtEmployees} {t(lang, "admin.persona.payroll.summary.whtEmpLabel")}
                {grandSvc.gi > 0 ? ` · ประกันกลุ่ม ${fmtMoney(grandSvc.gi)}` : ""}
              </div>
            </div>
            <div className="card border-2 border-emerald-300 bg-emerald-50/40">
              <div className="text-xs text-slate-500">
                รวมรับจริง (โอนเข้าบัญชี)
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(totals.net + grandSvc.net + grandSvc.mtgNet)}</div>
              <div className="text-xs text-slate-500 mt-1">
                เงินเดือนสุทธิ {fmtMoney(totals.net)}{grandSvc.net > 0 ? ` + SVC ${fmtMoney(grandSvc.net)}` : ""}{grandSvc.mtgNet > 0 ? ` + เบี้ยประชุม ${fmtMoney(grandSvc.mtgNet)}` : ""}
              </div>
            </div>
          </div>

          {/* Per-employee breakdown — read-only overview. Split per บริษัท, then
              per ประเภทพนักงาน × โหมดภาษี (owner 2026-09-03). Every figure is the
              month's accumulation across pay rounds. */}
          <p className="text-xs text-slate-400">
            แยกตามบริษัท (บัญชีแยกกัน) → แยกพนักงานประจำ/พาร์ทไทม์ → แยกประกันสังคม/หัก ณ ที่จ่าย · ทุกยอดคือ<b>ยอดสะสมทั้งเดือน</b>จากทุกรอบจ่าย (ดูอย่างเดียว แก้ที่หน้าค่าตอบแทนรายสาขา) · ค่าตอบแทน + เซอร์วิสชาร์จ + เบี้ยประชุม = รวมรายรับ → หัก ปกส./ภาษี/ประกันกลุ่ม/หักระหว่างเดือน (เครื่องดื่ม · อาหารข้ามบริษัท · อื่นๆ) → รวมรับจริง (= ยอดโอนจริง) · ค่าตอบแทนที่มีบรรทัดแดงใต้ยอด = ฐานเงินเดือนถูกตัดจากลาไม่รับค่าจ้าง/ขาดงาน (ประกันสังคมจึงคิดจากฐานที่ลดแล้ว) · เซอร์วิสชาร์จและเบี้ยประชุมเป็นของเดือน{monthLabel(svcMonth, lang)} (จ่ายพร้อมกันในรอบเซอร์วิสชาร์จ)
          </p>
          {/* One section per company — the books are separate, so NAMA+HYPO and
              AT HOME never share a table (owner 2026-08-01). */}
          {companyGroups.map((g) => {
            const crows = rowsByCompany.get(g.key) ?? [];
            if (crows.length === 0) return null;
            // Split each employment type by tax mode so ประกันสังคม and
            // หัก ณ ที่จ่าย are separate tables (owner 2026-09-03: แยกสัดส่วน).
            // 'sso' or null → SSO group; 'wht' → WHT group. PT is uniformly WHT.
            const isWht = (r: EmpCompanyRow) => r.taxMode === "wht";
            const cft = crows.filter((r) => r.employmentType === "ft");
            const cpt = crows.filter((r) => r.employmentType === "pt");
            const coth = crows.filter((r) => r.employmentType !== "ft" && r.employmentType !== "pt");
            const ftSso = cft.filter((r) => !isWht(r));
            const ftWht = cft.filter((r) => isWht(r));
            const othSso = coth.filter((r) => !isWht(r));
            const othWht = coth.filter((r) => isWht(r));
            // Company subtotal in the statement order: รวมรายรับ (ค่าตอบแทน + SVC) −
            // รายการหัก (ปกส. + ภาษี + SVC WHT + ประกันกลุ่ม) = รวมรับจริง. WHT + SSO
            // shown split so the accounting proportion is visible at a glance.
            const cAgg = crows.reduce((s, r) => {
              const f = figuresFor(r, g.key);
              return {
                income: s.income + f.income,
                wht: s.wht + f.tax,
                sso: s.sso + f.sso,
                gi: s.gi + f.gi,
                inRound: s.inRound + f.inRound
              };
            }, { income: 0, wht: 0, sso: 0, gi: 0, inRound: 0 });
            const cDed = cAgg.wht + cAgg.sso + cAgg.gi + cAgg.inRound;
            return (
              <div key={String(g.key)} className="space-y-3">
                <div className="border-l-4 border-brand pl-3 pt-2">
                  <h2 className="text-lg font-bold text-slate-800">{g.name}</h2>
                  <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>รวมรายรับ <b className="text-slate-800">{fmtMoney(cAgg.income)}</b></span>
                    <span>หัก ณ ที่จ่าย <b className="text-amber-700">{fmtMoney(cAgg.wht)}</b></span>
                    <span>ประกันสังคม <b className="text-sky-700">{fmtMoney(cAgg.sso)}</b></span>
                    {cAgg.gi > 0 && <span>ประกันกลุ่ม <b className="text-rose-600">{fmtMoney(cAgg.gi)}</b></span>}
                    {cAgg.inRound > 0 && <span>หักระหว่างเดือน <b className="text-rose-600">{fmtMoney(cAgg.inRound)}</b></span>}
                    <span>รวมรับจริง <b className="text-emerald-700">{fmtMoney(cAgg.income - cDed)}</b></span>
                  </div>
                </div>
                {empTable("พนักงานประจำ", "ประกันสังคม (ในระบบ)", "text-emerald-700", ftSso, g.key)}
                {empTable("พนักงานประจำ", "หัก ณ ที่จ่าย 3% (นอกระบบ)", "text-amber-700", ftWht, g.key)}
                {empTable("พาร์ทไทม์", "หัก ณ ที่จ่าย 3%", "text-violet-700", cpt, g.key)}
                {empTable("อื่นๆ", "ประกันสังคม (ในระบบ)", "text-slate-600", othSso, g.key)}
                {empTable("อื่นๆ", "หัก ณ ที่จ่าย 3%", "text-slate-600", othWht, g.key)}
              </div>
            );
          })}

          {/* Per-period list — collapsed by default (owner 2026-09-03: ยุบให้เรียบ).
              It's the audit trail of which rounds paid this month, not the headline. */}
          <details className="card">
            <summary className="font-semibold text-slate-700 cursor-pointer select-none">
              {t(lang, "admin.persona.payroll.summary.perPeriodTitle")}
              <span className="text-xs font-normal text-slate-400"> · {periods.length} รอบ (กดเพื่อดู)</span>
            </summary>
            <div className="overflow-x-auto mt-3">
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
          </details>
        </>
      )}
    </div>
  );
}
