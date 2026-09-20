import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { recordModuleVisit } from "@/lib/module-usage";

// Best-effort per-user module-usage beacon (owner 2026-09-20). The staff layout
// posts the module segment on each navigation; the landing page reads the counts
// to order a person's cards by what they use most. Always returns 200-ish so a
// beacon failure never shows up to the user.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  let body: { module?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  if (typeof body.module === "string") recordModuleVisit(user.id, body.module);
  return NextResponse.json({ ok: true });
}
