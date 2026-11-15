import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, ERROR_TEXT, setViewCookie, clearViewCookie, viewExpiry } from "@/lib/annual-checkup-api";
import { checkViewPin, hasConsented } from "@/lib/annual-checkup-employee";

// POST {pin} — after consent, the employee proves it is them with their own PIN; a signed cookie then opens the results page for
// 15 minutes. DELETE — close it. GET — is it open?
const Body = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  return handle(async (user) => {
    if (!hasConsented(user.id)) return NextResponse.json({ ok: false, error: "consent_required", message: ERROR_TEXT.consent_required }, { status: 403 });
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "pin_wrong", message: ERROR_TEXT.pin_wrong }, { status: 400 });
    const r = checkViewPin(user.id, p.data.pin);
    if (r === "ok") return NextResponse.json({ ok: true, expiresAt: setViewCookie(user) });
    const code = r === "wrong" ? "pin_wrong" : r;
    return NextResponse.json({ ok: false, error: code, message: ERROR_TEXT[code] }, { status: r === "too_many" ? 429 : 403 });
  });
}
export async function DELETE() { return handle(async () => { clearViewCookie(); return NextResponse.json({ ok: true }); }); }
export async function GET() { return handle(async (user) => NextResponse.json({ ok: true, openUntil: viewExpiry(user) })); }
