import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getDb, getUserPermissions, type User, type Branch } from "./db";
import type { RbacPermissionKey } from "./rbac";
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
  // RBAC (2026-06-04) — union of permission keys from all roles assigned
  // to this user. Empty for super_admin (it bypasses checks via userCan).
  // Drives requirePermission() module gates + sidebar link filtering.
  permissions: string[];
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
  // Account-state gate (2026-05-28). If the cron flipped this user
  // to 'resigned' or admin manually 'disabled' them mid-session,
  // their cookie is now stale — drop the session row so any
  // subsequent request lands on the login page where the API will
  // surface the proper "บัญชีคุณถูกปิด" message. Single source of
  // truth for "is this user allowed in" — checked here so every
  // route that calls getSessionUser inherits the gate automatically.
  if (row.status !== "active") {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  // ลำดับการแสดงสาขา — flagship (NAMA = display_order 1) ขึ้นก่อนเสมอ
  // ตามด้วยอัลฟาเบติก (display_order default = 100 สำหรับสาขาอื่น)
  //
  // super_admin is global: it can enter EVERY branch, so its branch
  // set is the whole table (not just user_branches rows). Everyone
  // else is scoped to their explicit membership.
  const branches = (row.role === "super_admin"
    ? db.prepare(`
        SELECT b.* FROM branches b ORDER BY b.display_order, b.name
      `).all()
    : db.prepare(`
        SELECT b.* FROM user_branches ub JOIN branches b ON ub.branch_id = b.id
        WHERE ub.user_id = ?
        ORDER BY b.display_order, b.name
      `).all(row.id)) as Branch[];

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

  // RBAC permission union. super_admin bypasses checks (userCan returns
  // true regardless) so we skip the query for it.
  const permissions = row.role === "super_admin" ? [] : getUserPermissions(row.id);

  return { ...row, branches, activeBranchId, adminBranchIds, permissions };
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
 *  branches, but a hand-crafted POST must not bypass that).
 *  super_admin is global — it may switch into any existing branch.
 *  Returns true when the switch was applied. */
export function setActiveBranch(branchId: number): boolean {
  const id = cookies().get(SESSION_COOKIE)?.value;
  if (!id) return false;
  const db = getDb();
  const session = db.prepare(
    `SELECT s.user_id, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`
  ).get(id) as { user_id: number; role: string } | undefined;
  if (!session) return false;
  const allowed =
    session.role === "super_admin"
      ? db.prepare("SELECT 1 FROM branches WHERE id = ?").get(branchId)
      : db.prepare(
          "SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?"
        ).get(session.user_id, branchId);
  if (!allowed) return false;
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
  // RBAC (additive): a user granted any admin-module role may enter the
  // console. Individual modules are still gated by requirePermission(),
  // so entering /admin alone leaks nothing — they only see the landing
  // + the modules their roles allow. This clause is purely permissive:
  // everyone who passed before still passes.
  if (u.permissions.length > 0) return u;
  redirect("/staff?error=forbidden");
}

// ── RBAC permission gates (2026-06-04) ─────────────────────────────
/** Raw permission check — true when the user literally holds the key.
 *  super_admin always passes. Does NOT apply the legacy fallback. */
export function userCan(user: SessionUser | null, key: RbacPermissionKey): boolean {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  return user.permissions.includes(key);
}

/** Module-access check used by the gates + sidebar. Rules:
 *    • super_admin → every module (god).
 *    • user with ≥1 RBAC role → RBAC governs strictly (only ticked
 *      modules). This is how the owner restricts access.
 *    • user with NO roles → legacy fallback: a full branch-admin sees
 *      every module (preserves pre-RBAC behaviour for admins created
 *      after the one-time backfill, so nobody is ever locked out);
 *      everyone else (plain staff) sees nothing.
 *  The "no roles ⇒ legacy" rule means: to RESTRICT an admin, assign
 *  them a narrower role (or set them to staff); to grant a staffer
 *  module access, assign a role with those modules. */
export function canModule(user: SessionUser | null, key: RbacPermissionKey): boolean {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (user.permissions.length > 0) return user.permissions.includes(key);
  return user.role === "admin" && user.adminBranchIds.length > 0;
}

/** Server-route / page gate: requires access to a specific module.
 *  Authenticated users lacking it bounce to the console landing (where
 *  requireAdmin sends pure-staff onward to /staff). super_admin passes. */
export function requirePermission(key: RbacPermissionKey): SessionUser {
  const u = requireUser();
  if (canModule(u, key)) return u;
  redirect("/admin?error=forbidden_module");
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

/** Payroll / salary visibility gate (PDPA, 2026-05-30).
 *
 *  Used to hide:
 *    - the entire /admin/persona/payroll/* section
 *    - salary columns (hourly_rate, monthly_salary) in the employee list
 *    - the same fields in employee detail modals
 *
 *  Rule: super_admin always sees it (system owner). Other admins
 *  only see it when users.can_view_payroll = 1 (granted explicitly
 *  by super_admin in user management). Staff never see it. The
 *  default for can_view_payroll is 0, so the gate closes
 *  automatically on first deploy — every existing admin loses
 *  access until super_admin re-grants. This is intentional: the
 *  bug we're fixing is "admin sees everyone's salary by default,"
 *  and the safest migration is opt-in not opt-out. */
export function userCanViewPayroll(user: SessionUser | null): boolean {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (user.role === "admin") return user.can_view_payroll === 1;
  return false;
}

/** Server-route gate: 403 if the caller can't see payroll. Mirrors
 *  the `requireAdmin()` shape so callers can write:
 *    const user = requirePayrollAccess();
 *  and trust they may serve salary fields below. */
export function requirePayrollAccess(): SessionUser {
  const u = requireUser();
  if (userCanViewPayroll(u)) return u;
  redirect("/admin?error=payroll_no_access");
}

// ── Mounjaro clinical access ───────────────────────────────────────
/** Only clinical doctors reach raw clinical data (and only their own
 *  patients — enforced in the mounjaro-db gateway). Nurses / HR /
 *  super_admin are bounced. */
export function requireClinicalDoctor(): SessionUser {
  const u = requireUser();
  if (u.clinical_role === "doctor") return u;
  redirect("/staff?error=forbidden");
}
export function userIsClinicalDoctor(user: SessionUser | null): boolean {
  return user?.clinical_role === "doctor";
}
export function userIsHrAnalytics(user: SessionUser | null): boolean {
  return user?.is_hr_analytics === 1;
}

const MJ_UNLOCK_COOKIE = "mj_unlock";
/** A doctor must re-enter their license number to unlock clinical data
 *  each session (presence-proof like a PIN). The unlock route sets an
 *  httpOnly cookie = the doctor's user id; JS can't forge it. */
export function isClinicalUnlocked(user: SessionUser): boolean {
  return cookies().get(MJ_UNLOCK_COOKIE)?.value === String(user.id);
}
export function setClinicalUnlocked(userId: number): void {
  cookies().set(MJ_UNLOCK_COOKIE, String(userId), {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH, maxAge: 8 * 3600
  });
}
