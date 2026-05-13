import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Company } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import CompaniesClient from "./CompaniesClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "บริษัทในเครือ · IKIGAI OS" };

// /admin/companies — top-level company management. Used to onboard
// new tenants in the future (the owner currently has one company but
// the model is multi-tenant from day one so we don't have to retrofit
// later). Branches list which company they belong to via
// branches.company_id.

export default function AdminCompaniesPage() {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const rows = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM branches b WHERE b.company_id = c.id) AS branch_count
    FROM companies c
    ORDER BY c.id ASC
  `).all() as Array<Company & { branch_count: number }>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.companies.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.companies.subtitle")}
        </p>
      </div>
      <CompaniesClient companies={rows} />
    </div>
  );
}
