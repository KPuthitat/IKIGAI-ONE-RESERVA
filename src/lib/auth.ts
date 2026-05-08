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

export type SessionUser = User & { branches: Branch[]; activeBranchId: number | null };

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

  let activeBranchId = row.active_branch_id;
  if (!activeBranchId && branches.length > 0) activeBranchId = branches[0].id;

  return { ...row, branches, activeBranchId };
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
  const role = payrollUser.role === "admin" ? "admin" : "staff";
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(payrollUser.id);
  if (exists) {
    db.prepare(
      "UPDATE users SET username=?, password_hash=?, display_name=?, role=? WHERE id=?"
    ).run(payrollUser.username, payrollUser.password_hash, payrollUser.display_name, role, payrollUser.id);
  } else {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?,?,?,?,?)"
    ).run(payrollUser.id, payrollUser.username, payrollUser.password_hash, payrollUser.display_name, role);
  }
}

export function setActiveBranch(branchId: number): void {
  const id = cookies().get(SESSION_COOKIE)?.value;
  if (!id) return;
  getDb().prepare("UPDATE sessions SET active_branch_id = ? WHERE id = ?").run(branchId, id);
}

export function requireUser(): SessionUser {
  const u = getSessionUser();
  if (!u) redirect("/login");
  return u;
}

export function requireAdmin(): SessionUser {
  const u = requireUser();
  if (u.role !== "admin") redirect("/staff?error=forbidden");
  return u;
}

export function requireStaffOrAdmin(): SessionUser {
  return requireUser();
}

export function userHasBranch(user: SessionUser, branchId: number): boolean {
  return user.branches.some((b) => b.id === branchId);
}
