import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { findPayrollUserByUsername } from "@/lib/payroll-db";
import { syncUserFromPayroll } from "@/lib/auth";
import { getDb, type UserRole } from "@/lib/db";
import { consumeEmergencyCred } from "@/lib/emergency-creds";
import { accountStateError, finalizeLogin } from "@/lib/login-helpers";

const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  const { username, password } = parsed.data;
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
    // Accept a 13-digit national ID as an alternate identifier (owner
    // 2026-07-02) — staff who can't recall their username log in with the
    // ID number bound to their record. length(@id)=13 keeps an ordinary
    // username from ever colliding into a national_id match.
    const local = db.prepare(`
      SELECT id, password_hash, role FROM users
      WHERE username = @id OR (national_id = @id AND length(@id) = 13)
      LIMIT 1
    `).get({ id: username }) as {
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

  // Account-state gate (2026-05-28) — shared with the LINE-login callback
  // so both entry points reject resigned/disabled/pending accounts the
  // same way. See login-helpers.accountStateError.
  const gate = accountStateError(authedUserId);
  if (gate) return NextResponse.json(gate, { status: 403 });

  // Login is unified (owner 2026-06-03) — no STAFF / ADMIN tab to match
  // against. Any valid credential signs in; the session role alone
  // decides what's reachable. tabRole is still derived for the response
  // so the client can route super_admin straight to the admin console.
  const tabRole: "admin" | "staff" =
    authedRole === "super_admin" || authedRole === "admin" ? "admin" : "staff";

  const { branchCount } = finalizeLogin(authedUserId, authedRole);

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
