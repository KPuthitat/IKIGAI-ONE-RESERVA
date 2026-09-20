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

  // Everyone lands in STAFF mode by default so they clock in like any employee;
  // ONLY an admin who is exempt from clocking in (track_attendance = 0 — the
  // "ไม่ต้องลงเวลา" toggle in employee settings) auto-lands in the admin console
  // (owner 2026-09-20). This keeps admins who work a shift from operating in
  // admin mode by accident. os_view is still just a view preference; they can
  // switch modes any time (PIN-gated), and every admin page enforces RBAC.
  //
  // "Admin rights" for the admin picker = super_admin, or an admin with a
  // per-branch admin grant (the picker only lists admin branches; a
  // permission-only user would get an empty picker).
  const hasAdminBranch = !!db.prepare(
    "SELECT 1 FROM user_branches WHERE user_id = ? AND is_admin = 1 LIMIT 1"
  ).get(userId);
  const trackAttendance = (
    db.prepare("SELECT track_attendance FROM users WHERE id = ?").get(userId) as { track_attendance: number } | undefined
  )?.track_attendance ?? 1;
  const clockInExempt = trackAttendance === 0;
  const hasAdminRights = role === "super_admin" || (role === "admin" && hasAdminBranch);
  const landsOnAdmin = hasAdminRights && clockInExempt;

  // Match the view intent to the home the user lands on, so the console is
  // coherent on arrival. os_view is a view preference only — every admin page
  // still enforces requireAdmin()/requirePermission() server-side.
  cookies().set("os_view", landsOnAdmin ? "admin" : "staff", {
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
