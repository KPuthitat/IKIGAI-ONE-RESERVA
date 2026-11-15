// Annual check-up — what an employee has to do before seeing their own results (phase 5): accept the PDPA notice, then prove it is
// really them with their PIN. Consent text lives in annual_checkup_consent_versions (kept by the super_admin); the PIN is the same
// 4-digit PIN as the time clock. No result is read here — the results themselves come only from the gateway (annual-checkup-db.ts).
import { getDb } from "./db";
import { verifyAdminPin } from "./admin-pin";

export const DEFAULT_CONSENT_BODY = [
  "ผลตรวจสุขภาพประจำปีเป็นข้อมูลส่วนบุคคลที่อ่อนไหวตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562",
  "• ผลตรวจของท่านบันทึกและตรวจสอบโดยเจ้าหน้าที่และแพทย์ของคลินิกเท่านั้น ฝ่ายบุคคลและผู้บริหารเห็นเพียงจำนวนความคืบหน้า ไม่เห็นผลรายบุคคล",
  "• ท่านเห็นได้เฉพาะผลของตนเองหลังแพทย์เปิดผลแล้ว และทุกการเปิดดูข้อมูลของท่านถูกบันทึกไว้ ท่านตรวจสอบได้ที่หน้า \"ใครเปิดดูข้อมูลฉัน\"",
  "• การเปิดดูผลต้องยืนยันตัวตนด้วยรหัส PIN ของท่านทุกครั้ง โปรดอย่าแสดงหน้าจอผลตรวจให้ผู้อื่น",
  "• ข้อความแจ้งเตือนทาง LINE จะบอกเพียงว่าผลพร้อมแล้ว ไม่มีค่าผลตรวจ"
].join("\n");

export type ConsentVersion = { id: number; version: string; body: string };

/** The consent text in force. The first call seeds a default so the page always has something to show. */
export function getActiveConsent(): ConsentVersion {
  const db = getDb();
  const row = db.prepare("SELECT id, version, body FROM annual_checkup_consent_versions WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as ConsentVersion | undefined;
  if (row) return row;
  const id = Number(db.prepare("INSERT INTO annual_checkup_consent_versions (version, body, active) VALUES ('1.0', ?, 1)").run(DEFAULT_CONSENT_BODY).lastInsertRowid);
  return { id, version: "1.0", body: DEFAULT_CONSENT_BODY };
}

export function hasConsented(userId: number): boolean {
  const v = getActiveConsent();
  return !!getDb().prepare("SELECT 1 FROM annual_checkup_consents WHERE user_id = ? AND version = ?").get(userId, v.version);
}
export function recordConsent(userId: number, ip: string | null): void {
  const v = getActiveConsent();
  if (hasConsented(userId)) return;
  getDb().prepare("INSERT INTO annual_checkup_consents (user_id, version, ip) VALUES (?, ?, ?)").run(userId, v.version, ip);
}

/** Publish a new consent text (super_admin only). Everyone is asked again for the new version. */
export function publishConsentVersion(actorId: number, version: string, body: string): void {
  const db = getDb();
  const a = db.prepare("SELECT role, status FROM users WHERE id = ?").get(actorId) as { role: string; status: string } | undefined;
  if (!a || a.role !== "super_admin" || a.status !== "active") throw new Error("super_admin_only");
  const v = version.trim().slice(0, 20), b = body.trim().slice(0, 8000);
  if (!v || !b) throw new Error("empty_consent");
  if (db.prepare("SELECT 1 FROM annual_checkup_consent_versions WHERE version = ?").get(v)) throw new Error("version_exists");
  db.transaction(() => {
    db.prepare("UPDATE annual_checkup_consent_versions SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE active = 1").run();
    db.prepare("INSERT INTO annual_checkup_consent_versions (version, body, active) VALUES (?, ?, 1)").run(v, b);
  })();
}

// PIN guesses are limited: 5 wrong in 10 minutes per person (in memory; a restart clears it).
const attempts = new Map<number, number[]>();
export const pinAttemptsLeft = (userId: number, now = Date.now()): number => {
  const recent = (attempts.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
  attempts.set(userId, recent);
  return Math.max(0, 5 - recent.length);
};
export type PinCheck = "ok" | "wrong" | "no_pin" | "too_many";
export function checkViewPin(userId: number, pin: string, now = Date.now()): PinCheck {
  if (pinAttemptsLeft(userId, now) === 0) return "too_many";
  const r = verifyAdminPin(userId, pin);
  if (r.ok) { attempts.delete(userId); return "ok"; }
  if (r.reason === "no_pin") return "no_pin";
  attempts.set(userId, [...(attempts.get(userId) ?? []), now]);
  return "wrong";
}
