import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { isAnnualCheckupForbidden, isAnnualCheckupInvalid, setRoundStatus } from "@/lib/annual-checkup-db";
import { ERROR_TEXT } from "@/lib/annual-checkup-api";

// POST {roundId, status} — the owner or a clinic recorder opens / closes a round. Employees see their number and QR only while it is open.
const Body = z.object({ roundId: z.number().int().positive(), status: z.enum(["open", "closed", "draft"]) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    const r = setRoundStatus(user, p.data.roundId, p.data.status);
    return NextResponse.json({ ok: true, changed: r.changed });
  } catch (e) {
    if (isAnnualCheckupForbidden(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? ERROR_TEXT.not_allowed }, { status: 403 });
    if (isAnnualCheckupInvalid(e)) return NextResponse.json({ ok: false, error: e.code, message: e.message !== e.code ? e.message : (ERROR_TEXT[e.code] ?? e.code) }, { status: 422 });
    throw e;
  }
}
