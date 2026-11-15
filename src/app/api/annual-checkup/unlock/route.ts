import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyApproverLicense, isApproverEligible } from "@/lib/annual-checkup-db";
import { clearUnlockCookie, handle, licenseAttemptsLeft, noteWrongLicense, setUnlockCookie, unlockExpiry } from "@/lib/annual-checkup-api";

// POST {license} — the approver doctor proves presence with their licence number; a signed cookie then unlocks verify / revise /
// release for 30 minutes. DELETE — lock again. GET — is it unlocked?
const Body = z.object({ license: z.string().min(1).max(40) });

export async function POST(req: Request) {
  return handle(async (user) => {
    if (!isApproverEligible(user.id)) return NextResponse.json({ ok: false, error: "not_approver", message: "ต้องเป็นแพทย์ผู้อนุมัติผลเท่านั้น" }, { status: 403 });
    if (licenseAttemptsLeft(user.id) === 0) return NextResponse.json({ ok: false, error: "too_many", message: "กรอกผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่" }, { status: 429 });
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณากรอกเลขใบประกอบวิชาชีพ" }, { status: 400 });
    if (!verifyApproverLicense(user, p.data.license)) { noteWrongLicense(user.id); return NextResponse.json({ ok: false, error: "license_wrong", message: "เลขใบประกอบวิชาชีพไม่ถูกต้อง" }, { status: 403 }); }
    return NextResponse.json({ ok: true, expiresAt: setUnlockCookie(user) });
  });
}
export async function DELETE() { return handle(async () => { clearUnlockCookie(); return NextResponse.json({ ok: true }); }); }
export async function GET() { return handle(async (user) => NextResponse.json({ ok: true, unlockedUntil: unlockExpiry(user) })); }
