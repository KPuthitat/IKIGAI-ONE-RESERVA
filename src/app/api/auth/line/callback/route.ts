import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb, type UserRole } from "@/lib/db";
import { lineLoginConfigured, exchangeCodeForLineUserId, publicBaseUrl } from "@/lib/line-login";
import { accountStateError, finalizeLogin, loginLandingPath } from "@/lib/login-helpers";

// LINE Login OAuth callback. Verifies the CSRF state, exchanges the code
// for the caller's LINE userId, maps it to an employee (must already be
// bound by an admin), applies the same account-state gate as password
// login, then opens a session and lands on the branch picker.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = publicBaseUrl() || url.origin;
  const fail = (code: string) => NextResponse.redirect(`${base}/login?error=${code}`);

  if (!lineLoginConfigured()) return fail("line_unavailable");

  const raw = cookies().get("line_login_state")?.value ?? "";
  cookies().set("line_login_state", "", { path: "/", maxAge: 0 });
  const [savedState, savedNext = ""] = raw.split("|");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !savedState || state !== savedState) return fail("line_state");

  const lineUserId = await exchangeCodeForLineUserId(code);
  if (!lineUserId) return fail("line_exchange");

  const user = getDb()
    .prepare("SELECT id, role FROM users WHERE line_user_id = ? LIMIT 1")
    .get(lineUserId) as { id: number; role: UserRole } | undefined;
  if (!user) return fail("line_not_linked");

  const gate = accountStateError(user.id);
  if (gate) return fail(gate.error_code);

  const { branchCount, isSuperAdmin } = finalizeLogin(user.id, user.role);
  const dest = loginLandingPath(isSuperAdmin, branchCount, savedNext || null);
  return NextResponse.redirect(`${base}${dest}`);
}
