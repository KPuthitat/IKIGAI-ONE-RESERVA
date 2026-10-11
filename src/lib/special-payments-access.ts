import type { SessionUser } from "./auth";
import { getDb } from "./db";
import type { PaymentErrorCode } from "./special-payments";

/** The admin may record for a person only when they share one of the admin's branches (owner: any). */
export function canPayUser(admin: SessionUser, userId: number): boolean {
  if (admin.role === "super_admin") return true;
  if (!admin.adminBranchIds.length) return false;
  const ph = admin.adminBranchIds.map(() => "?").join(",");
  return !!getDb().prepare(`SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id IN (${ph}) LIMIT 1`).get(userId, ...admin.adminBranchIds);
}

export const PAYMENT_ERROR_TH: Record<PaymentErrorCode | "pin_required" | "no_pin" | "wrong_pin" | "forbidden" | "invalid_body", string> = {
  user_invalid: "ไม่พบพนักงานที่เลือก",
  user_not_active: "พนักงานคนนี้ไม่ได้อยู่ในสถานะที่รับเงินผ่านระบบเงินเดือนได้ (พ้นสภาพหรือปิดบัญชีแล้ว)",
  amount_invalid: "จำนวนเงินไม่ถูกต้อง",
  reason_required: "กรุณาระบุเหตุผล",
  date_invalid: "วันที่ไม่ถูกต้อง",
  date_in_future: "ไม่สามารถบันทึกรายการล่วงหน้าได้ กรุณาเลือกวันที่ในวันนี้หรือก่อนหน้า",
  period_finalized: "รอบเงินเดือนของวันที่เลือกปิดยอดแล้ว ไม่สามารถเพิ่มหรือยกเลิกรายการได้",
  line_reviewed: "รายการเงินเดือนของพนักงานในรอบนั้นถูกกดตรวจแล้ว กรุณายกเลิกการตรวจก่อน",
  advance_not_available: "ไม่สามารถคำนวณวงเงินเบิกล่วงหน้าได้ เนื่องจากพนักงานไม่มีเงินเดือนหรืออัตราค่าจ้างรายชั่วโมงที่ตั้งไว้",
  advance_exceeds_limit: "จำนวนเงินเกินวงเงินที่เบิกล่วงหน้าได้",
  not_found: "ไม่พบรายการ",
  already_voided: "รายการนี้ถูกยกเลิกไปแล้ว",
  pin_required: "กรุณาใส่ PIN",
  no_pin: "ยังไม่ได้ตั้ง PIN",
  wrong_pin: "PIN ไม่ถูกต้อง",
  forbidden: "ไม่มีสิทธิ์",
  invalid_body: "ข้อมูลไม่ครบถ้วน"
};
