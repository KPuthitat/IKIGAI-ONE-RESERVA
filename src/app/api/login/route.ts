import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { findPayrollUserByUsername } from "@/lib/payroll-db";
import { createSession, syncUserFromPayroll } from "@/lib/auth";
import { getDb, type UserRole } from "@/lib/db";
import { consumeEmergencyCred } from "@/lib/emergency-creds";

const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(["admin", "staff"]).optional()
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  const { username, password, role: requestedRole } = parsed.data;
  const db = getDb();

  // ─── 3-step authentication ladder ─────────────────────────────
  //   1. Payroll DB (legacy admin/staff accounts that pre-date this app)
  //   2. Local users table (invite-redeemed accounts that exist only
  //      here — they don't have a Payroll equivalent)
  //   3. Emergency credentials (24h temp username + password issued
  //      by admin when the staff can't log in any other way)
  //
  // The first match wins. We compare bcrypt at every step to avoid
  // a timing-channel difference between "user exists, wrong password"
  // and "user doesn't exist" — both fall through to the same final
  // 401 below.

  let authedUserId: number | null = null;
  let authedRole: UserRole | null = null;

  // (1) Payroll
  const payrollUser = findPayrollUserByUsername(username);
  if (payrollUser && bcrypt.compareSync(password, payrollUser.password_hash)) {
    syncUserFromPayroll(payrollUser);
    // Read the synced role from local users — preserves a locally-
    // granted super_admin promotion, which Payroll doesn't know about.
    const local = db.prepare("SELECT id, role FROM users WHERE id = ?")
      .get(payrollUser.id) as { id: number; role: UserRole } | undefined;
    if (local) {
      authedUserId = local.id;
      authedRole = local.role;
    }
  }

  // (2) Local users (invite-redeemed). Look up WITHOUT a status
  // filter so a 'resigned' or 'disabled' row still gets a password
  // check + returns the proper account-state error below — instead
  // of falling through to a generic 401 that doesn't tell the staff
  // why their working credentials no longer work.
  if (!authedUserId) {
    const local = db.prepare(`
      SELECT id, password_hash, role FROM users
      WHERE username = ?
    `).get(username) as {
      id: number; password_hash: string; role: UserRole;
    } | undefined;
    if (local && bcrypt.compareSync(password, local.password_hash)) {
      authedUserId = local.id;
      authedRole = local.role;
    }
  }

  // (3) Emergency credentials — single-use temp login.
  if (!authedUserId) {
    const emergencyUserId = consumeEmergencyCred(username, password);
    if (emergencyUserId != null) {
      const u = db.prepare("SELECT id, role FROM users WHERE id = ?")
        .get(emergencyUserId) as { id: number; role: UserRole } | undefined;
      if (u) {
        authedUserId = u.id;
        authedRole = u.role;
      }
    }
  }

  if (!authedUserId || !authedRole) {
    return NextResponse.json(
      { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" },
      { status: 401 }
    );
  }

  // Account-state gate (2026-05-28). Even if credentials matched,
  // the row may be flagged as resigned (auto-closed by the nightly
  // sweep after the staff's last working day) or disabled (admin
  // manually closed it). Show a specific message so the staff knows
  // who to contact instead of staring at a generic 401.
  const accountState = db.prepare(
    "SELECT status, resigned_at FROM users WHERE id = ?"
  ).get(authedUserId) as { status: string; resigned_at: string | null } | undefined;
  if (accountState?.status === "resigned") {
    return NextResponse.json({
      error: "บัญชีของคุณถูกปิดเนื่องจากครบกำหนดวันลาออกแล้ว",
      error_code: "account_resigned",
      message: "หากต้องการกลับเข้าทำงานหรือสอบถามข้อมูล กรุณาติดต่อแอดมินผ่าน LINE OA ของบริษัท",
      resigned_at: accountState.resigned_at
    }, { status: 403 });
  }
  if (accountState?.status === "disabled") {
    return NextResponse.json({
      error: "บัญชีของคุณถูกปิดใช้งาน",
      error_code: "account_disabled",
      message: "กรุณาติดต่อแอดมินเพื่อขอเปิดบัญชีอีกครั้ง"
    }, { status: 403 });
  }
  if (accountState?.status === "pending_invite") {
    return NextResponse.json({
      error: "บัญชียังไม่ได้ตั้งค่าครั้งแรก",
      error_code: "account_pending_invite",
      message: "กรุณากดลิงก์เชิญที่แอดมินส่งให้ผ่าน LINE เพื่อตั้งรหัสผ่านก่อน"
    }, { status: 403 });
  }

  // Role gate vs the tab the form is on. super_admin counts as
  // "admin" for tab purposes — there's no separate super_admin tab.
  const tabRole: "admin" | "staff" =
    authedRole === "super_admin" || authedRole === "admin" ? "admin" : "staff";
  if (requestedRole && requestedRole !== tabRole) {
    const msg = requestedRole === "admin"
      ? "บัญชีนี้ไม่มีสิทธิ์เข้าฝั่งผู้ดูแล"
      : "บัญชีผู้ดูแล กรุณาเลือกแท็บ ADMIN";
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  // Stamp last_login_at — useful for the admin "inactive users" audit.
  db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(authedUserId);

  createSession(authedUserId, null);

  const branchCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM user_branches WHERE user_id = ?"
  ).get(authedUserId) as { n: number }).n;

  // `is_super_admin` lets the client route super_admin straight to the
  // /admin console (its dedicated entry, unchanged) while every other
  // role — including plain admin — lands on the module picker first
  // (admin is an employee first; management is an opt-in toggle).
  return NextResponse.json({
    ok: true,
    role: tabRole,
    is_super_admin: authedRole === "super_admin",
    branchCount
  });
}
