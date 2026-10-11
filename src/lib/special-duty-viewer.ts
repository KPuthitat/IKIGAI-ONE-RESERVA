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
