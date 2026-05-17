import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
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
  requireSuperAdmin();
  const lang = getLang();
  const db = getDb();

  const rows = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM branches b WHERE b.company_id = c.id) AS branch_count
    FROM companies c
    ORDER BY c.id ASC
  `).all() as Array<Company & { branch_count: number }>;

  const branches = db.prepare(`
    SELECT id, name, company_id, reg_address, tax_branch_code
    FROM branches
    ORDER BY display_order, name
  `).all() as Array<{
    id: number;
    name: string;
    company_id: number | null;
    reg_address: string | null;
    tax_branch_code: string | null;
  }>;

  // Users + their branch grants — drives the per-branch admin list
  // nested under each branch (company → branch → admins).
  // Exclude disabled + not-yet-onboarded (pending_invite) accounts:
  // they can't log in, so they shouldn't be assignable as branch
  // admins and only clutter the picker (these are the stale
  // "@invite.xxxx" placeholder rows).
  const users = db.prepare(`
    SELECT id, display_name, username, role, title_prefix
    FROM users
    WHERE status NOT IN ('disabled', 'pending_invite')
    ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             display_name
  `).all() as Array<{
    id: number;
    display_name: string;
    username: string;
    role: "super_admin" | "admin" | "staff";
    title_prefix: string | null;
  }>;

  const grants = db.prepare(
    "SELECT user_id, branch_id, is_admin FROM user_branches"
  ).all() as Array<{ user_id: number; branch_id: number; is_admin: number }>;

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
      <CompaniesClient
        companies={rows}
        branches={branches}
        users={users}
        grants={grants}
      />
    </div>
  );
}
