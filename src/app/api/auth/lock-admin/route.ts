import { NextResponse } from "next/server";
import { getSessionUser, clearAdminUnlocked } from "@/lib/auth";

// POST /api/auth/lock-admin
//
// Leaves admin mode: clears the httpOnly os_admin_unlock cookie (the source of
// truth for admin mode). Called when switching to staff view so returning to
// admin re-prompts the PIN (owner 2026-09-21). Idempotent; safe when already out.

export async function POST() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  clearAdminUnlocked();
  return NextResponse.json({ ok: true });
}
