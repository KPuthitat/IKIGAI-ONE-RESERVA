// Mounjaro LINE notifications. Pushes to the employee's own LINE via the
// IKIGAI OS platform OA (น้องฮูก). Best-effort: never throws into the
// request path. Only the real-time doctor-reply notification is wired in
// this phase; scheduled reminders (injection / next-visit / weekly log)
// are a cron follow-up.

import { getDb } from "./db";
import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";

async function pushToEmployee(lineUserId: string, text: string): Promise<void> {
  const token = getPlatformChannel()?.channel_token ?? null;
  if (!token) return;
  await sendLinePush(token, { to: lineUserId, messages: [{ type: "text", text }] });
}

/** Notify the employee that the doctor invited them to the program. */
export async function notifyEmployeeInvited(employeeId: number): Promise<void> {
  try {
    const row = getDb().prepare("SELECT line_user_id FROM users WHERE id = ?")
      .get(employeeId) as { line_user_id: string | null } | undefined;
    if (!row?.line_user_id) return;
    await pushToEmployee(
      row.line_user_id,
      "แพทย์ได้ส่งคำเชิญให้คุณเข้าร่วมโครงการควบคุมน้ำหนัก\n\nกรุณาเปิดพอร์ทัล IKIGAI OS → สุขภาพพนักงาน → โครงการควบคุมน้ำหนัก เพื่อยืนยันการเข้าร่วม"
    );
  } catch { /* best-effort */ }
}

/** Notify the attending doctor that the employee confirmed their invitation. */
export async function notifyDoctorEmployeeConfirmed(employeeId: number): Promise<void> {
  try {
    const row = getDb().prepare(`
      SELECT doc.line_user_id AS doctor_line,
             emp.display_name AS employee_name, emp.title_prefix AS employee_prefix
      FROM mounjaro_enrollments e
      JOIN users doc ON doc.id = e.invited_by_doctor_id
      JOIN users emp ON emp.id = e.employee_id
      WHERE e.employee_id = ? AND e.employee_confirmed_at IS NOT NULL
    `).get(employeeId) as {
      doctor_line: string | null; employee_name: string; employee_prefix: string | null;
    } | undefined;
    if (!row?.doctor_line) return;
    const who = `${row.employee_prefix ? row.employee_prefix + " " : ""}${row.employee_name}`;
    await pushToEmployee(
      row.doctor_line,
      `${who} ยืนยันรับคำเชิญเข้าร่วมโครงการควบคุมน้ำหนักแล้ว\n\nกรุณาเปิด IKIGAI OS → โครงการควบคุมน้ำหนัก (แพทย์) เพื่อทำ Baseline`
    );
  } catch { /* best-effort */ }
}

/** Notify the employee that the doctor replied to their self-log. */
export async function notifySelfLogReply(selfLogId: number): Promise<void> {
  try {
    const row = getDb().prepare(`
      SELECT u.line_user_id AS line_user_id
      FROM mounjaro_self_logs sl
      JOIN mounjaro_enrollments e ON e.id = sl.enrollment_id
      JOIN users u ON u.id = e.employee_id
      WHERE sl.id = ?
    `).get(selfLogId) as { line_user_id: string | null } | undefined;
    if (!row?.line_user_id) return;
    await pushToEmployee(
      row.line_user_id,
      "แพทย์ได้ตอบบันทึกอาการของคุณในโครงการควบคุมน้ำหนักแล้ว — เปิดดูในพอร์ทัล IKIGAI OS"
    );
  } catch { /* best-effort */ }
}

const ACTION_TH: Record<string, string> = {
  withdraw: "ขอออกจากโครงการ",
  erase: "ขอลบข้อมูลออกจากพอร์ทัล"
};

/** Notify the attending doctor that an employee filed a withdraw/erase
 *  request that needs approval (owner 2026-06-05). Best-effort. */
export async function notifyDoctorPendingAction(
  employeeId: number, action: "withdraw" | "erase"
): Promise<void> {
  try {
    const row = getDb().prepare(`
      SELECT doc.line_user_id AS doctor_line,
             emp.display_name AS employee_name, emp.title_prefix AS employee_prefix
      FROM mounjaro_enrollments e
      JOIN mounjaro_patients p ON p.enrollment_id = e.id AND p.deleted_at IS NULL
      JOIN users doc ON doc.id = p.attending_doctor_id
      JOIN users emp ON emp.id = e.employee_id
      WHERE e.employee_id = ?
    `).get(employeeId) as {
      doctor_line: string | null; employee_name: string; employee_prefix: string | null;
    } | undefined;
    if (!row?.doctor_line) return;
    const who = `${row.employee_prefix ? row.employee_prefix + " " : ""}${row.employee_name}`;
    await pushToEmployee(
      row.doctor_line,
      `มีคำขอรออนุมัติในโครงการควบคุมน้ำหนัก\nผู้ป่วย: ${who}\nคำขอ: ${ACTION_TH[action]}\n\nเปิดอนุมัติในพอร์ทัล IKIGAI OS → ดูแลผู้ป่วย (แพทย์)`
    );
  } catch { /* best-effort */ }
}

/** Notify the employee of the doctor's decision on their withdraw/erase
 *  request. Best-effort. */
export async function notifyEmployeeActionDecision(
  employeeId: number, action: "withdraw" | "erase", decision: "approve" | "reject"
): Promise<void> {
  try {
    const row = getDb().prepare("SELECT line_user_id FROM users WHERE id = ?")
      .get(employeeId) as { line_user_id: string | null } | undefined;
    if (!row?.line_user_id) return;
    const verdict = decision === "approve"
      ? `แพทย์อนุมัติคำขอ${ACTION_TH[action]}แล้ว`
      : `แพทย์ยังไม่อนุมัติคำขอ${ACTION_TH[action]} — กรุณาติดต่อแพทย์เพื่อสอบถามเพิ่มเติม`;
    await pushToEmployee(row.line_user_id, `${verdict} (โครงการควบคุมน้ำหนัก)`);
  } catch { /* best-effort */ }
}
