// Annual check-up — shared plumbing for the clinical routes and pages (phase 4). Server only.
// Every handler goes through handle(): session → gateway call → Thai error text. Authorisation itself lives in the gateway
// (annual-checkup-db.ts) and the triggers; this file only turns refusals into answers and carries the licence-unlock cookie.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, requireUser, type SessionUser } from "./auth";
import { isAnnualCheckupForbidden, isAnnualCheckupInvalid, isRecorderEligible } from "./annual-checkup-db";
import { UNLOCK_COOKIE, UNLOCK_MINUTES, makeUnlockToken, readUnlockToken } from "./annual-checkup-session";

export const ERROR_TEXT: Record<string, string> = {
  unauthenticated: "กรุณาเข้าสู่ระบบใหม่",
  not_recorder: "ท่านไม่มีสิทธิ์ลงผลตรวจสุขภาพ",
  not_approver: "ต้องเป็นแพทย์ผู้อนุมัติผลเท่านั้น",
  license_not_unlocked: "กรุณาปลดล็อกด้วยเลขใบประกอบวิชาชีพก่อน",
  super_admin_only: "เฉพาะเจ้าของระบบ",
  not_allowed: "ท่านไม่มีสิทธิ์ดูข้อมูลนี้",
  db_refused: "ฐานข้อมูลไม่อนุญาตรายการนี้ (สิทธิ์หรือสถานะของผลไม่ถูกต้อง)",
  order_waived: "รายการนี้งดตรวจ ลงผลไม่ได้",
  result_locked: "ผลนี้ตรวจสอบแล้ว แก้ได้ทางฉบับแก้ไขเท่านั้น",
  external_lab_needs_file: "รายการส่งแล็บนอกต้องแนบไฟล์ผลจากแล็บ",
  bad_interpretation: "ผลแปลไม่ถูกต้อง", bad_value: "ค่าที่กรอกไม่ถูกต้อง",
  reason_required: "กรุณาระบุเหตุผล", name_required: "กรุณาใส่ชื่อ",
  not_draft: "ผลนี้ไม่ได้อยู่ในสถานะร่าง", not_locked: "ผลนี้ยังเป็นร่าง แก้ไขได้โดยตรง ไม่ต้องทำฉบับแก้ไข",
  result_empty: "ยังไม่มีค่าหรือไฟล์ให้ตรวจสอบ", no_conclusion: "ต้องบันทึกสรุปผลของแพทย์ก่อนเปิดผล",
  not_all_verified: "ยังมีรายการที่ยังไม่ได้ตรวจสอบ", nothing_to_release: "ไม่มีรายการที่ต้องเปิดผล",
  conclusion_released: "สรุปผลที่เปิดให้พนักงานดูแล้วแก้ไม่ได้",
  order_not_found: "ไม่พบรายการตรวจ", result_not_found: "ไม่พบผล", subject_not_found: "ไม่พบผู้เข้าตรวจ", test_not_found: "ไม่พบรายการตรวจนี้", round_not_found: "ไม่พบรอบ"
};

/** Run a handler for the signed-in user; gateway refusals become 403 / 422 with Thai text. */
export async function handle(fn: (user: SessionUser) => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated", message: ERROR_TEXT.unauthenticated }, { status: 401 });
  try { return await fn(user); }
  catch (e) {
    if (isAnnualCheckupForbidden(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? ERROR_TEXT.not_allowed }, { status: e.code === "unauthenticated" ? 401 : 403 });
    if (isAnnualCheckupInvalid(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}

/** A page for clinical staff: the signed-in user must be eligible right now, otherwise they are sent back. */
export function requireClinicalUser(): SessionUser {
  const u = requireUser();
  if (!isRecorderEligible(u.id)) redirect("/staff?error=forbidden");
  return u;
}

// ── licence unlock (signed cookie, 30 minutes) ──
export function unlockExpiry(user: SessionUser): number | null {
  return readUnlockToken(cookies().get(UNLOCK_COOKIE)?.value, user.id);
}
export const isUnlocked = (user: SessionUser): boolean => unlockExpiry(user) !== null;
export function setUnlockCookie(user: SessionUser): number {
  cookies().set(UNLOCK_COOKIE, makeUnlockToken(user.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: UNLOCK_MINUTES * 60 });
  return Date.now() + UNLOCK_MINUTES * 60_000;
}
export function clearUnlockCookie(): void {
  cookies().set(UNLOCK_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

// A licence number is short, so wrong guesses are limited: 5 in 10 minutes per person (in memory; a restart clears it, which is fine).
const attempts = new Map<number, number[]>();
export function licenseAttemptsLeft(userId: number, now = Date.now()): number {
  const recent = (attempts.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
  attempts.set(userId, recent);
  return Math.max(0, 5 - recent.length);
}
export function noteWrongLicense(userId: number, now = Date.now()): void { attempts.set(userId, [...(attempts.get(userId) ?? []), now]); }
