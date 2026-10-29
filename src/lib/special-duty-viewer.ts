import type { SessionUser } from "./auth";
import type { Viewer } from "./special-duty-access";

export function viewerOf(user: SessionUser): Viewer {
  return {
    userId: user.id,
    role: user.role === "super_admin" ? "super_admin" : user.role === "admin" ? "admin" : "staff",
    branchIds: user.branches.map((b) => b.id),
    adminBranchIds: user.adminBranchIds,
    department: (user as { department?: string | null }).department
  };
}

export const RULE_TEXT: Record<string, string> = {
  month_off: "เดือนนี้ยังไม่เปิดใช้ตำแหน่งงานค่าตอบแทนพิเศษ",
  roster_not_published: "ตารางงานประจำเดือนยังไม่เผยแพร่",
  booking_not_open: "ยังไม่เปิดให้เลือกวัน",
  booking_closed: "ปิดรับการเลือกวันแล้ว",
  not_in_branch: "ท่านไม่ได้สังกัดสาขานี้",
  self_booking_disqualified: "ท่านไม่สามารถเลือกวันเองได้ในเดือนนี้ เนื่องจากขาดงานตำแหน่งนี้ครบตามเกณฑ์ในเดือนก่อน",
  position_invalid: "ตำแหน่งงานไม่ถูกต้อง",
  date_outside_month: "วันที่อยู่นอกเดือนที่เลือก",
  date_in_past: "ไม่สามารถเลือกวันที่ผ่านมาแล้ว",
  not_in_roster: "ท่านไม่มีตารางทำงานในวันที่เลือก",
  group_not_eligible: "ตำแหน่งนี้ไม่เปิดให้กลุ่มงานของท่าน",
  on_leave: "ท่านมีการลาที่อนุมัติแล้วในวันที่เลือก",
  below_minimum_days: "ต้องเลือกให้ครบจำนวนวันขั้นต่ำของตำแหน่งนี้",
  too_many_per_day: "ท่านเลือกตำแหน่งในวันเดียวกันเกินจำนวนที่กำหนด",
  slot_taken: "มีผู้เลือกวันดังกล่าวไปแล้ว กรุณาเลือกวันอื่น",
  not_open_for_assignment: "วันดังกล่าวยังไม่เปิดให้มอบหมาย"
};

export const EVIDENCE_TEXT: Record<string, string> = {
  not_found: "ไม่พบรายการ",
  forbidden: "ท่านไม่ใช่ผู้ปฏิบัติงานของวันนี้",
  wrong_stage: "ยังไม่อยู่ในช่วงที่ส่งหลักฐานได้",
  too_early: "ส่งหลักฐานได้ตั้งแต่วันที่ปฏิบัติงานเป็นต้นไป",
  deadline_passed: "เกินกำหนดส่งหลักฐานแล้ว กรุณาแจ้งผู้จัดการ",
  wrong_status: "รายการนี้อยู่ในสถานะที่ทำรายการไม่ได้",
  not_present: "ไม่พบการลงเวลาเข้างานปกติของวันนั้น ตำแหน่งงานค่าตอบแทนพิเศษนับได้เฉพาะวันที่มาทำงานปกติ",
  photos_required: "กรุณาถ่ายภาพพื้นที่ที่ทำความสะอาดอย่างน้อยหนึ่งภาพ",
  too_many_photos: "ส่งภาพได้ไม่เกินจำนวนที่กำหนด",
  photo_bad_format: "ไฟล์ภาพไม่ถูกต้อง",
  days_must_match: "งานที่เลือกส่งพร้อมกัน ต้องเป็นวันเดียวกันและสาขาเดียวกัน",
  photo_too_large: "ไฟล์ภาพใหญ่เกินไป",
  no_people_not_confirmed: "กรุณายืนยันว่าในภาพไม่มีบุคคลปรากฏอยู่",
  note_required: "กรุณาระบุเหตุผล",
  substitute_invalid: "ผู้ที่เลือกไม่สามารถแทนได้ (ต้องอยู่ในสาขา ตรงกับกลุ่มงานที่กำหนด มีตารางทำงานในวันนั้น และไม่ลา)",
  substitute_same_person: "ผู้แทนต้องเป็นคนละคนกับผู้ที่ขาด",
  substitute_busy: "ผู้ที่เลือกมีตำแหน่งในวันนั้นครบจำนวนที่กำหนดแล้ว"
};

export const SWAP_TEXT: Record<string, string> = {
  not_found: "ไม่พบรายการ",
  forbidden: "ท่านไม่มีสิทธิ์ทำรายการนี้",
  wrong_stage: "สลับวันได้หลังประกาศตารางแล้วและยังไม่สิ้นสุดเดือนเท่านั้น",
  same_person: "ต้องสลับกับผู้อื่น",
  day_not_swappable: "วันที่เลือกสลับไม่ได้แล้ว (มีการปฏิบัติงาน ส่งหลักฐาน ขาด หรือมีผู้แทนแล้ว)",
  too_late: "เลยกำหนดแจ้งล่วงหน้าแล้ว กรุณาแจ้งก่อนวันที่ปฏิบัติงานตามจำนวนวันที่กำหนด",
  pair_invalid: "ไม่สามารถสลับวันคู่นี้ได้",
  already_pending: "มีคำขอสลับของวันนี้ที่รอดำเนินการอยู่แล้ว",
  wrong_status: "คำขอนี้อยู่ในสถานะที่ทำรายการไม่ได้",
  note_required: "กรุณาระบุเหตุผล",
  not_eligible: "สลับไม่ได้ เพราะอีกฝ่ายหรือท่านไม่มีตารางทำงานในวันนั้น ลา อยู่นอกกลุ่มงานที่กำหนด หรือมีตำแหน่งในวันนั้นครบแล้ว"
};
