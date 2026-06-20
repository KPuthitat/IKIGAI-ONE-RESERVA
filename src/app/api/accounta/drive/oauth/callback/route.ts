import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { verifyState, completeDriveOAuth } from "@/lib/google-drive";

// GET /api/accounta/drive/oauth/callback — Google redirects here after the
// branch authorises. Fixed redirect URI (registered on the OAuth client);
// the branch id rides in the signed `state`. Stores the refresh token and
// bounces back to the admin Drive page with a status flag.
export async function GET(req: Request) {
  const back = (q: string) => NextResponse.redirect(new URL(`/admin/accounta/drive?${q}`, req.url));

  const user = getSessionUser();
  if (!user || user.role !== "super_admin") {
    return NextResponse.redirect(new URL("/admin/accounta", req.url));
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
