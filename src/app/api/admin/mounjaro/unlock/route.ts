import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, setClinicalUnlocked } from "@/lib/auth";
import { verifyClinicalLicense, type MjActor } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/unlock — a doctor re-enters their professional
// license number to unlock clinical data for this session (8h cookie).

const Body = z.object({ license: z.string().min(1).max(60) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  if (!verifyClinicalLicense(user as MjActor, parsed.data.license)) {
    return NextResponse.json({ error: "bad_license" }, { status: 403 });
  }
  setClinicalUnlocked(user.id);
  return NextResponse.json({ ok: true });
}
