import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch, type User } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import StaffClient from "./StaffClient";

export const dynamic = "force-dynamic";

type UserWithBranches = User & { branch_ids: number[] };

export default function StaffPage() {
  requireAdmin();
  const lang = getLang();
  const db = getDb();
  const branches = db.prepare(`
    SELECT * FROM branches
    ORDER BY CASE WHEN slug = 'nama-sriracha' THEN 0 ELSE 1 END, name
  `).all() as Branch[];
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as User[];
  const userBranches = db.prepare(
    "SELECT user_id, branch_id FROM user_branches"
  ).all() as Array<{ user_id: number; branch_id: number }>;

  const data: UserWithBranches[] = users.map((u) => ({
    ...u,
    branch_ids: userBranches.filter((ub) => ub.user_id === u.id).map((ub) => ub.branch_id)
  }));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.users.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "admin.users.subtitle")}</p>
      </div>
      <StaffClient users={data} branches={branches} />
    </div>
  );
}
