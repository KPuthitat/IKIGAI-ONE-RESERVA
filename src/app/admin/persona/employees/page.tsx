import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listEmployees, listFtEmployees, type Employee, type FtEmployee } from "@/lib/payroll-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Employees · PERSONA · Admin" };

type Tab = "pt" | "ft";

export default function EmployeesPage({ searchParams }: { searchParams: { tab?: string } }) {
  requireAdmin();
  const lang = getLang();
  const tab: Tab = searchParams.tab === "ft" ? "ft" : "pt";

  let rows: Array<Employee | FtEmployee> = [];
  let err: string | null = null;
  try {
    rows = tab === "pt" ? listEmployees() : listFtEmployees();
  } catch (e) {
    err = e instanceof Error ? e.message : "DB error";
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.persona.employees.title")}</h1>
      </div>

      {/* Tabs PT / FT */}
      <div className="inline-flex gap-0 bg-slate-100 rounded-lg p-1">
        <Link
          href="/admin/persona/employees?tab=pt"
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
            tab === "pt" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >{t(lang, "admin.persona.employees.tabPt")}</Link>
        <Link
          href="/admin/persona/employees?tab=ft"
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
            tab === "ft" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >{t(lang, "admin.persona.employees.tabFt")}</Link>
      </div>

      {err ? (
        <div className="card text-amber-700 bg-amber-50 border-amber-200">{err}</div>
      ) : rows.length === 0 ? (
        <div className="card text-center text-slate-500 py-10">
          {t(lang, "admin.persona.employees.empty")}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2 pr-2">{t(lang, "admin.persona.employees.col.code")}</th>
                <th className="pr-2">{t(lang, "admin.persona.employees.col.name")}</th>
                <th className="pr-2">{t(lang, "admin.persona.employees.col.tax")}</th>
                <th className="pr-2 text-right">{t(lang, "admin.persona.employees.col.salary")}</th>
                <th className="pr-2">{t(lang, "admin.persona.employees.col.bank")}</th>
                <th className="text-center">{t(lang, "admin.persona.employees.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const active = (e.is_active ?? 1) === 1;
                return (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="py-2 pr-2 font-mono text-xs">{e.code}</td>
                    <td className="pr-2 font-medium">{e.name}</td>
                    <td className="pr-2 text-slate-500">{e.tax_type}</td>
                    <td className="pr-2 text-right tabular-nums">
                      {e.base_salary > 0
                        ? new Intl.NumberFormat(lang === "th" ? "th-TH" : "en-US").format(e.base_salary)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="pr-2 text-slate-500 text-xs">
                      {e.bank_name && e.bank_account
                        ? `${e.bank_name} ${e.bank_account}`
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                        active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                      }`}>
                        {active
                          ? t(lang, "admin.persona.employees.statusActive")
                          : t(lang, "admin.persona.employees.statusInactive")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-slate-400 text-center">
        🚧 อ่านอย่างเดียว · CRUD จะทำใน Phase 1B (PT employees CRUD + FT employees)
      </div>
    </div>
  );
}
