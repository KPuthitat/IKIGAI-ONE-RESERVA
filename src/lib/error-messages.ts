// Human-readable display for API error responses (cognitive-ergonomics pass,
// owner 2026-06-16). A user must NEVER see a raw snake_case error code like
// "already_hired" or "approval_chain_not_configured". Resolution order:
//   1. the server's own `message` field (often a full Thai instruction),
//   2. a Thai mapping of common cross-cutting codes,
//   3. a caller-supplied fallback (or a generic Thai message).
//
// Route-specific codes are still best served by a server `message` or an i18n
// key at the call site; this is the safety net so nothing leaks a raw code.
//
// Client-safe: pure, no server-only imports.

const GENERIC = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";

// Frequently-returned codes shared across many routes.
const CODE_TH: Record<string, string> = {
  unauthenticated: "เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่",
  forbidden: "คุณไม่มีสิทธิ์ทำรายการนี้",
  invalid_body: "ข้อมูลไม่ครบหรือไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  invalid_id: "ไม่พบรายการที่ต้องการ",
  not_found: "ไม่พบข้อมูล",
  user_not_found: "ไม่พบบัญชีพนักงาน",
  rate_limited: "ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
  no_fields: "ไม่มีข้อมูลที่เปลี่ยนแปลง",
  wrong_pin: "PIN ไม่ถูกต้อง",
  pin_required: "กรุณากรอก PIN เพื่อยืนยัน",
  no_pin: "คุณยังไม่ได้ตั้ง PIN — ตั้งที่หน้าโปรไฟล์ก่อน",
  no_pin_set: "คุณยังไม่ได้ตั้ง PIN — ตั้งที่หน้าโปรไฟล์ก่อน"
};

type ApiErrorShape = { message?: unknown; error?: unknown } | null | undefined;

/** Best human-readable Thai string for an API error response — server
 *  `message` → known-code map → caller fallback → generic. Never returns a
 *  raw snake_case error code. */
export function humanizeApiError(res: ApiErrorShape, fallback: string = GENERIC): string {
  if (res && typeof res.message === "string" && res.message.trim()) {
    return res.message;
  }
  const code = res && typeof res.error === "string" ? res.error : "";
  if (code && CODE_TH[code]) return CODE_TH[code];
  return fallback;
}
