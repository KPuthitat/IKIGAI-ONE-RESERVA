import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSessionUser, clearAdminUnlocked } from "@/lib/auth";

// POST /api/auth/lock-admin
//
// Leaves admin mode: clears the httpOnly os_admin_unlock cookie and sets the
// os_view chrome preference back to staff. Called when switching to staff view
// so that returning to admin re-prompts the PIN (owner 2026-09-21 — entering
// admin requires the PIN every time). Idempotent; safe to call when already out.

export async function POST() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  clearAdminUnlocked();
  cookies().set("os_view", "staff", {
    httpOnly: false, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", path: "/", maxAge: 31_536_000
  });
  return NextResponse.json({ ok: true });
}
