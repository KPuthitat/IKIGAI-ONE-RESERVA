import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, ERROR_TEXT, setClinicCookie, clearClinicCookie, clinicExpiry } from "@/lib/annual-checkup-api";
import { isRecorderEligible } from "@/lib/annual-checkup-db";
import { checkViewPin } from "@/lib/annual-checkup-employee";

// POST {pin} — a clinician (recorder / approver) proves it is them with their own PIN; a signed cookie then opens the clinic screens (check-in
// list, result entry, verification) for 20 minutes. DELETE — close the window. GET — is it open?
const Body = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  return handle(async (user) => {
    if (!isRecorderEligible(user.id)) return NextResponse.json({ ok: false, error: "not_recorder", message: ERROR_TEXT.not_recorder ?? ERROR_TEXT.not_allowed }, { status: 403 });
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "pin_wrong", message: ERROR_TEXT.pin_wrong }, { status: 400 });
    const r = checkViewPin(user.id, p.data.pin);
    if (r === "ok") return NextResponse.json({ ok: true, expiresAt: setClinicCookie(user) });
    const code = r === "wrong" ? "pin_wrong" : r;
    return NextResponse.json({ ok: false, error: code, message: ERROR_TEXT[code] }, { status: r === "too_many" ? 429 : 403 });
  });
}
export async function DELETE() { return handle(async () => { clearClinicCookie(); return NextResponse.json({ ok: true }); }); }
export async function GET() { return handle(async (user) => NextResponse.json({ ok: true, openUntil: clinicExpiry(user) })); }
