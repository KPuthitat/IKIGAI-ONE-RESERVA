import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildDriveAuthUrl, driveOAuthConfigured } from "@/lib/google-drive";

// GET /api/accounta/drive/[branchId]/oauth/start — kick off the Google
// consent flow for connecting this branch's Drive. super_admin only; the
// signed `state` carries the branch id, and the callback re-checks the
// super_admin session, so a forged callback can't bind a stray account.
export async function GET(_req: Request, { params }: { params: { branchId: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "super_admin") {
    return NextResponse.redirect(new URL("/admin/accounta", "https://ikigaimedihealth.com"));
  }
  const branchId = Number(params.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
  }
  if (!driveOAuthConfigured()) {
    return NextResponse.json(
      { error: "oauth_not_configured", message: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID / SECRET" },
      { status: 503 }
    );
  }
  return NextResponse.redirect(buildDriveAuthUrl(branchId));
}
