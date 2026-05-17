import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getDb, type User, type Branch } from "./db";
export { hashPassword, verifyPassword } from "./password";

// Shared cookie name — Payroll Express ก็จะอ่าน cookie ตัวนี้ด้วย (SSO bridge)
const SESSION_COOKIE = "reserva_session";
const SESSION_DAYS = 14;
// Cookie scope ที่ root / เพื่อให้ Payroll (Express) อ่านเจอ
const COOKIE_PATH = "/";

export type SessionUser = User & {
  branches: Branch[];
  activeBranchId: number | null;
  // Branches this user may ADMINISTER. super_admin → every branch in
  // the system. admin → only branches granted via user_branches
  // .is_admin = 1. staff → always empty. Drives the admin branch
  // picker scope and requireAdmin's per-branch gate.
  adminBranchIds: number[];
};

export function createSession(userId: number, activeBranchId: number | null): string {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  getDb().prepare(
    "INSERT INTO sessions (id, user_id, active_branch_id, expires_at) VALUES (?,?,?,?)"
  ).run(id, userId, activeBranchId, expires);
  cookies().set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: SESSION_DAYS * 86_400
  });
  return id;
}

export function destroySession(): void {
  const id = cookies().get(SESSION_COOKIE)?.value;
  if (id) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  cookies().set(SESSION_COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
}

export function getSessionUser(): SessionUser | null {
  const id = cookies().get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const db = getDb();
  // ใช้ local users table (mirror จาก Payroll ตอน login)
  const row = db.prepare(`
    SELECT u.*, s.expires_at, s.active_branch_id
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(id) as (User & { expires_at: string; active_branch_id: number | null }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  // ลำดับการแสดงสาขา — flagship (NAMA = display_order 1) ขึ้นก่อนเสมอ
  // ตามด้วยอัลฟาเบติก (display_order default = 100 สำหรับสาขาอื่น)
  const branches = db.prepare(`
    SELECT b.* FROM user_branches ub JOIN branches b ON ub.branch_id = b.id
    WHERE ub.user_id = ?
    ORDER BY b.display_order, b.name
  `).all(row.id) as Branch[];

  // Branches this user can administer. super_admin is global so it
  // gets every branch; a sub-admin only gets branches explicitly
  // flagged user_branches.is_admin = 1; staff gets none.
  let adminBranchIds: number[];
  if (row.role === "super_admin") {
    adminBranchIds = (
      db.prepare("SELECT id FROM branches").all() as Array<{ id: number }>
    ).map((b) => b.id);
  } else if (row.role === "admin") {
    adminBranchIds = (
      db.prepare(
        "SELECT branch_id FROM user_branches WHERE user_id = ? AND is_admin = 1"
      ).all(row.id) as Array<{ branch_id: number }>
    ).map((r) => r.branch_id);
  } else {
    adminBranchIds = [];
  }

  // Validate the session's active branch against current membership.
  // A stale / forged active_branch_id pointing at a branch the user
  // no longer belongs to falls back to their first branch (never
  // leaks data from a branch they were removed from).
  let activeBranchId = row.active_branch_id;
  const isMember = activeBranchId != null && branches.some((b) => b.id === activeBranchId);
  if (!isMember) activeBranchId = branches.length > 0 ? branches[0].id : null;

  return { ...row, branches, activeBranchId, adminBranchIds };
}

/** Sync user จาก Payroll → local users table (เรียกตอน login สำเร็จ) */
export function syncUserFromPayroll(payrollUser: {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
}): void {
  const db = getDb();
  // Preserve a locally-granted super_admin promotion: if the user is
  // already super_admin in our DB, don't downgrade them back to admin
  // when Payroll's record syncs through. Payroll only knows about
  // admin/staff — super_admin is an IKIGAI OS-local concept.
  const existing = db.prepare("SELECT role FROM users WHERE id = ?")
    .get(payrollUser.id) as { role: string } | undefined;
  let role: "super_admin" | "admin" | "staff";
  if (existing?.role === "super_admin") {
    role = "super_admin";
  } else {
    role = payrollUser.role === "admin" ? "admin" : "staff";
  }
  if (existing) {
    db.prepare(
      "UPDATE users SET username=?, password_hash=?, display_name=?, role=? WHERE id=?"
    ).run(payrollUser.username, payrollUser.password_hash, payrollUser.display_name, role, payrollUser.id);
  } else {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?,?,?,?,?)"
    ).run(payrollUser.id, payrollUser.username, payrollUser.password_hash, payrollUser.display_name, role);
  }
}

/** Switch the session's active branch. Rejects branches the user is
 *  not a member of (defence-in-depth: the picker only lists allowed
 *  branches, but a hand-crafted POST must not bypass that). Returns
 *  true when the switch was applied. */
export function setActiveBranch(branchId: number): boolean {
  const id = cookies().get(SESSION_COOKIE)?.value;
  if (!id) return false;
  const db = getDb();
  const session = db.prepare(
    "SELECT user_id FROM sessions WHERE id = ?"
  ).get(id) as { user_id: number } | undefined;
  if (!session) return false;
  const member = db.prepare(
    "SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?"
  ).get(session.user_id, branchId);
  if (!member) return false;
  db.prepare("UPDATE sessions SET active_branch_id = ? WHERE id = ?").run(branchId, id);
  return true;
}

export function requireUser(): SessionUser {
  const u = getSessionUser();
  if (!u) redirect("/login");
  return u;
}

// Role hierarchy:  super_admin > admin > staff
// Each tier inherits the powers below. So an admin can do everything
// staff can; super_admin can do everything admin can. The require*
// helpers below take the role check exactly once at the page-server
// boundary; downstream code reads user.role for finer-grained gates
// (e.g. "only super_admin can delete a company").

/** Allows super_admin (global) or an admin who has been granted at
 *  least one admin branch. A sub-admin with no admin branches has no
 *  console to manage, so they're treated like staff. */
export function requireAdmin(): SessionUser {
  const u = requireUser();
  if (u.role === "super_admin") return u;
  if (u.role === "admin" && u.adminBranchIds.length > 0) return u;
  redirect("/staff?error=forbidden");
}

/** Allows super_admin only. Used by system-wide settings (companies,
 *  global LINE OA, user role management, impersonation). */
export function requireSuperAdmin(): SessionUser {
  const u = requireUser();
  if (u.role !== "super_admin") redirect("/admin?error=super_admin_only");
  return u;
}

export function requireStaffOrAdmin(): SessionUser {
  return requireUser();
}

/** Cheap role predicates for component-level gating
 *  (e.g. show/hide a delete button without redirecting). */
export function isSuperAdmin(user: SessionUser | null): boolean {
  return user?.role === "super_admin";
}
export function isAdminOrAbove(user: SessionUser | null): boolean {
  return user?.role === "admin" || user?.role === "super_admin";
}

export function userHasBranch(user: SessionUser, branchId: number): boolean {
  return user.branches.some((b) => b.id === branchId);
}

/** True when the user may administer the given branch. super_admin
 *  → any branch; admin → only branches in adminBranchIds. */
export function userCanAdminBranch(user: SessionUser, branchId: number): boolean {
  if (user.role === "super_admin") return true;
  return user.adminBranchIds.includes(branchId);
}
