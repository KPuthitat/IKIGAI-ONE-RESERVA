import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { lineLoginConfigured, buildAuthorizeUrl, publicBaseUrl } from "@/lib/line-login";

// Kick off "Login with LINE": mint a CSRF state, stash it (with the
// optional deep-link `next`) in a short-lived httpOnly cookie, and bounce
// to LINE's authorize screen. The callback verifies the state on return.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const base = publicBaseUrl() || new URL(req.url).origin;
  if (!lineLoginConfigured()) {
    return NextResponse.redirect(`${base}/login?error=line_unavailable`);
  }
  const next = new URL(req.url).searchParams.get("next") ?? "";
  const state = crypto.randomBytes(16).toString("hex");
  cookies().set("line_login_state", `${state}|${next}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600
  });
  return NextResponse.redirect(buildAuthorizeUrl(state));
}
