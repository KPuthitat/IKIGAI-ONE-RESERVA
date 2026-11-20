// Annual check-up — shared plumbing for the clinical routes and pages (phase 4). Server only.
// Every handler goes through handle(): session → gateway call → Thai error text. Authorisation itself lives in the gateway
// (annual-checkup-db.ts) and the triggers; this file only turns refusals into answers and carries the licence-unlock cookie.
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, requireUser, type SessionUser } from "./auth";
import { isAnnualCheckupForbidden, isAnnualCheckupInvalid, isRecorderEligible } from "./annual-checkup-db";
import { promises as fs } from "fs";
import path from "path";
import { UNLOCK_COOKIE, UNLOCK_MINUTES, makeUnlockToken, readUnlockToken, VIEW_COOKIE, VIEW_MINUTES, makeViewToken, readViewToken, CLINIC_COOKIE, CLINIC_MINUTES, makeClinicToken, readClinicToken } from "./annual-checkup-session";

export const ERROR_TEXT: Record<string, string> = { pin_required: "กรุณายืนยันด้วยรหัส PIN ก่อนเข้าส่วนคลินิก (ครบเวลาแล้วต้องกรอกใหม่)",
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
  consent_required: "กรุณายอมรับข้อตกลงการคุ้มครองข้อมูลก่อน", pin_wrong: "รหัส PIN ไม่ถูกต้อง", no_pin: "ท่านยังไม่ได้ตั้งรหัส PIN กรุณาตั้งรหัสที่หน้าลงเวลาก่อน", too_many: "กรอกผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่", view_locked: "กรุณายืนยันตัวตนด้วย PIN ก่อนดูผล", not_released: "ผลของผู้เข้าตรวจรายนี้ยังไม่ถูกเปิด",
  kit_no_taken: "เลขชุดนี้ถูกใช้แล้วในรอบนี้", bad_kit_no: "เลขชุดใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข . _ - ไม่เกิน 30 ตัว", not_checked_in: "ยังไม่ได้เช็กอิน กรุณาเช็กอินก่อนผ่านสถานี", station_not_needed: "สถานีนี้ไม่อยู่ในรายการตรวจของคนนี้",
  not_all_recorded: "ยังลงผลไม่ครบทุกรายการ จึงส่งให้แพทย์ไม่ได้", queue_not_found: "ไม่พบคิวนี้ (QR ไม่ถูกต้อง)", queue_no_taken: "ลำดับนี้มีผู้ใช้แล้วในรอบนี้", bad_queue_no: "ลำดับต้องเป็นเลขจำนวนเต็มตั้งแต่ 1",
  order_not_found: "ไม่พบรายการตรวจ", result_not_found: "ไม่พบผล", subject_not_found: "ไม่พบผู้เข้าตรวจ", test_not_found: "ไม่พบรายการตรวจนี้", round_not_found: "ไม่พบรอบ"
};

/** Run a handler for the signed-in user; gateway refusals become 403 / 422 with Thai text. */
export async function handle(fn: (user: SessionUser) => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated", message: ERROR_TEXT.unauthenticated }, { status: 401 });
  try { return await fn(user); }
  catch (e) {
    if (isAnnualCheckupForbidden(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? ERROR_TEXT.not_allowed }, { status: e.code === "unauthenticated" ? 401 : 403 });
    if (isAnnualCheckupInvalid(e)) return NextResponse.json({ ok: false, error: e.code, message: e.message !== e.code ? e.message : (ERROR_TEXT[e.code] ?? e.code) }, { status: 422 });
    throw e;
  }
}

/** The PIN page itself: eligibility only (no PIN window yet). */
export function requireClinicalEligible(): SessionUser {
  const u = requireUser();
  if (!isRecorderEligible(u.id)) redirect("/staff?error=forbidden");
  return u;
}

/**
 * A page for clinical staff: the signed-in user must be eligible right now AND have typed their PIN within the last 20 minutes; otherwise they
 * are sent to the PIN page (and nothing about other people is rendered). Owner 2026-11-21.
 */
export function requireClinicalUser(): SessionUser {
  const u = requireClinicalEligible();
  if (!isClinicOpen(u)) {
    const path = headers().get("x-pathname") ?? "";
    redirect(`/staff/health/annual-checkup/pin${path.startsWith("/staff/health/annual-checkup") ? `?next=${encodeURIComponent(path)}` : ""}`);
  }
  return u;
}

// ── the clinic window (PIN → signed cookie, 20 minutes) ──
export function clinicExpiry(user: SessionUser): number | null { return readClinicToken(cookies().get(CLINIC_COOKIE)?.value, user.id); }
export const isClinicOpen = (user: SessionUser): boolean => clinicExpiry(user) !== null;
export function setClinicCookie(user: SessionUser): number {
  cookies().set(CLINIC_COOKIE, makeClinicToken(user.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: CLINIC_MINUTES * 60 });
  return Date.now() + CLINIC_MINUTES * 60_000;
}
export function clearClinicCookie(): void {
  cookies().set(CLINIC_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

/** Like handle(), for the clinical API routes: refused with 403 "pin_required" until the clinician has typed their PIN (the window above). */
export async function handleClinical(fn: (user: SessionUser) => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  return handle((user) => {
    if (!isClinicOpen(user)) return NextResponse.json({ ok: false, error: "pin_required", message: ERROR_TEXT.pin_required }, { status: 403 });
    return fn(user);
  });
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

// ── the employee's own viewing window (consent + PIN → signed cookie, 15 minutes) ──
export function viewExpiry(user: SessionUser): number | null { return readViewToken(cookies().get(VIEW_COOKIE)?.value, user.id); }
export const isViewOpen = (user: SessionUser): boolean => viewExpiry(user) !== null;
export function setViewCookie(user: SessionUser): number {
  cookies().set(VIEW_COOKIE, makeViewToken(user.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: VIEW_MINUTES * 60 });
  return Date.now() + VIEW_MINUTES * 60_000;
}
export function clearViewCookie(): void {
  cookies().set(VIEW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

// ── private files ──
const DATA_ROOT = process.env.HEALTH_DATA_ROOT ?? path.join(process.cwd(), "data", "health");
/** Stream a stored file, never leaving the health data folder. */
export async function serveStoredFile(rel: string, mime: string): Promise<NextResponse> {
  const full = path.resolve(DATA_ROOT, rel);
  if (!full.startsWith(path.resolve(DATA_ROOT) + path.sep)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  try {
    const buf = await fs.readFile(full);
    return new NextResponse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { headers: { "Content-Type": mime, "Content-Disposition": "inline", "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ ok: false, error: "file_missing" }, { status: 404 }); }
}
