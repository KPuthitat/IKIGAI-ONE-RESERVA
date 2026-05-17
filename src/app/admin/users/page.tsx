import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import UsersClient, {
  type UserRow,
  type BranchRow,
  type GrantRow
} from "./UsersClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สิทธิ์ผู้ใช้ · IKIGAI OS" };

// /admin/users — super_admin-only access control. Decides which
// branches each account may enter and which of those branches they
// administer (user_branches.is_admin). This is the only place a
// sub-admin's reach is widened, so the page + its API both enforce
// requireSuperAdmin.

export default function AdminUsersPage() {
  requireSuperAdmin();
  const db = getDb();

  const users = db
    .prepare(
      `SELECT id, username, display_name, role
       FROM users
       ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                display_name`
    )
    .all() as UserRow[];

  const branches = db
    .prepare(
      `SELECT b.id, b.name, b.company_id,
              COALESCE(c.name_th, '— ไม่ระบุบริษัท —') AS company_name
       FROM branches b
       LEFT JOIN companies c ON c.id = b.company_id
       ORDER BY c.id, b.display_order, b.name`
    )
    .all() as BranchRow[];

  const grants = db
    .prepare("SELECT user_id, branch_id, is_admin FROM user_branches")
    .all() as GrantRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สิทธิ์ผู้ใช้งาน</h1>
        <p className="text-sm text-slate-500 mt-1">
          กำหนดว่าแต่ละบัญชีเข้าสาขาไหนได้ และเป็นแอดมินของสาขาใดบ้าง
          — ผู้ที่จะเป็นแอดมินสาขาต้องตั้งบทบาทเป็น “แอดมิน” และเปิดสิทธิ์แอดมินอย่างน้อยหนึ่งสาขา
        </p>
      </div>
      <UsersClient users={users} branches={branches} grants={grants} />
    </div>
  );
}
