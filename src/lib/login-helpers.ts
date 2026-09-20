// Shared login primitives (2026-07-02).
//
// Both the password login route (/api/login) and the one-tap LINE-login
// callback (/api/auth/line/callback) must gate the same account states
// and finalize a session identically. Keeping that logic here means the
// two entry points can never silently diverge (e.g. LINE login letting a
// resigned staff in because it forgot the status check).

import { cookies } from "next/headers";
import { getDb, type UserRole } from "./db";
import { createSession } from "./auth";

export type AccountStateError = {
  error: string;
  error_code: "account_resigned" | "account_disabled" | "account_pending_invite";
  message: string;
  resigned_at?: string | null;
};

/** Post-auth account-state gate. Returns a 403-shaped payload when the
 *  credentials were valid but the account is closed/paused/not-yet-set,
 *  or null when the account may proceed to a session. */
export function accountStateError(userId: number): AccountStateError | null {
  const s = getDb()
    .prepare("SELECT status, resigned_at FROM users WHERE id = ?")
    .get(userId) as { status: string; resigned_at: string | null } | undefined;
  if (s?.status === "resigned") {
    return {
      error: "บัญชีของคุณถูกปิดเนื่องจากครบกำหนดวันลาออกแล้ว",
      error_code: "account_resigned",
      message: "หากต้องการกลับเข้าทำงานหรือสอบถามข้อมูล กรุณาติดต่อแอดมินผ่าน LINE OA ของบริษัท",
      resigned_at: s.resigned_at
    };
  }
  if (s?.status === "disabled") {
    return {
      error: "บัญชีของคุณถูกปิดใช้งาน",
      error_code: "account_disabled",
      message: "กรุณาติดต่อแอดมินเพื่อขอเปิดบัญชีอีกครั้ง"
    };
  }
  if (s?.status === "pending_invite") {
    return {
      error: "บัญชียังไม่ได้ตั้งค่าครั้งแรก",
      error_code: "account_pending_invite",
      message: "กรุณากดลิงก์เชิญที่แอดมินส่งให้ผ่าน LINE เพื่อตั้งรหัสผ่านก่อน"
    };
  }
  return null;
}

/** Stamp last_login_at, reset the os_view intent to the role's HOME mode
 *  (so crossing into the non-default mode re-prompts the PIN), and open a
 *  session cookie. Returns the routing hints the caller needs to land the
 *  user on the right branch picker. Mirrors the tail of /api/login. */
export function finalizeLogin(
  userId: number,
  role: UserRole
): { branchCount: number; landsOnAdmin: boolean } {
  const db = getDb();
  db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
  createSession(userId, null);

  // EVERY account — super_admin included — auto-lands in STAFF mode on login,
  // with NO exception (owner 2026-09-20: "บังคับเลยให้ทุกบัญชีเข้า auto login
  // โหมดพนักงานก่อน แล้วก็ค่อยให้กด PIN เข้าโหมดผู้ดูแลระบบ ป้องกันปัญหา"). Nobody
  // is dropped straight into the admin console anymore — you clock in like any
  // employee first, then deliberately PIN into admin view via the mode toggle.
  // This prevents accidentally operating in admin mode. os_view is only a view
  // preference; every admin page still enforces RBAC server-side.
  //
  // `role` is unused now that landing is unconditional, but kept in the
  // signature so both login entry points share one shape.
  void role;
  const landsOnAdmin = false;

  // Everyone starts in staff view; entering admin is a deliberate, PIN-gated
  // switch. os_view is a view preference only — every admin page still enforces
  // requireAdmin()/requirePermission() server-side.
  cookies().set("os_view", "staff", {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 31_536_000
  });
  const branchCount = (
    db.prepare("SELECT COUNT(*) AS n FROM user_branches WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  return { branchCount, landsOnAdmin };
}

/** Landing path after any successful login. Users who land on the admin console
 *  go through the admin picker → /admin (all modules); everyone else through the
 *  staff picker. Both pickers auto-skip when there's a single eligible branch,
 *  so single-branch users feel no step. */
export function loginLandingPath(landsOnAdmin: boolean, branchCount: number, next?: string | null): string {
  const base = landsOnAdmin
    ? "/admin/branch-picker"
    : branchCount >= 1
      ? "/staff/branch-picker"
      : "/staff";
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}
