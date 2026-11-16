import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { isAnnualCheckupForbidden, isAnnualCheckupInvalid, upsertQueueRow } from "@/lib/annual-checkup-db";
import { ERROR_TEXT } from "@/lib/annual-checkup-api";

// POST {roundId, subject: "u<id>" | "e<id>", queueNo, apptTime?} — the owner or a clinic recorder moves a person to another queue number
// and / or sets their appointment time. A number already held by someone else is refused (never silently swapped).
const Body = z.object({ roundId: z.number().int().positive(), subject: z.string().regex(/^[ue]\d+$/), queueNo: z.number().int().positive(), apptTime: z.string().max(5).nullable().optional() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const id = Number(p.data.subject.slice(1));
  const subject = p.data.subject[0] === "u" ? { userId: id } : { externalId: id };
  try {
    const r = upsertQueueRow(user, p.data.roundId, subject, p.data.queueNo, p.data.apptTime === undefined ? undefined : p.data.apptTime || null);
    return NextResponse.json({ ok: true, action: r.action });
  } catch (e) {
    if (isAnnualCheckupForbidden(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? ERROR_TEXT.not_allowed }, { status: 403 });
    if (isAnnualCheckupInvalid(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
