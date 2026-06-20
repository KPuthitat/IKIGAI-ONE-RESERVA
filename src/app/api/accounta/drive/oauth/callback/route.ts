import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { verifyState, completeDriveOAuth } from "@/lib/google-drive";

// GET /api/accounta/drive/oauth/callback — Google redirects here after the
// branch authorises. Fixed redirect URI (registered on the OAuth client);
// the branch id rides in the signed `state`. Stores the refresh token and
// bounces back to the admin Drive page with a status flag.
export async function GET(req: Request) {
  // Build redirects against the PUBLIC base URL, not req.url — behind Nginx
  // req.url's host is the internal localhost:3010, which the browser can't
  // reach (it followed the redirect to localhost and got CONNECTION_REFUSED).
  const appBase = (process.env.APP_BASE_URL || "https://ikigaimedihealth.com").replace(/\/$/, "");
  const back = (q: string) => NextResponse.redirect(`${appBase}/admin/accounta/drive?${q}`);

  const user = getSessionUser();
  if (!user || user.role !== "super_admin") {
    return NextResponse.redirect(`${appBase}/admin/accounta`);
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return back(`drive=denied`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const branchId = verifyState(state);
  if (!code || branchId == null) return back(`drive=bad_state`);

  const r = await completeDriveOAuth(branchId, code, user.id);
  if (!r.ok) {
    return back(`drive=error&msg=${encodeURIComponent((r.error || "").slice(0, 120))}`);
  }
  return back(`drive=connected&branch=${branchId}`);
}
