// ตำแหน่งงานค่าตอบแทนพิเศษ — the daily job (owner 2026-10-11). Called from /api/cron every
// few minutes, so every message is claimed once in special_duty_alerts (UNIQUE branch,
// month, kind, key) and a re-run changes nothing.
//
//  • closes booking windows that ended and tells the managers how many days are still open
//  • flushes the alerts the roster hooks queued (slot released, nobody eligible that day)
//  • from 09:00: reminds the performer the day before, and on the last day to send evidence
//  • from 09:00: one digest a day to each branch's managers (evidence waiting, evidence
//    missing after the deadline, open days, swap requests) and owner alerts to the owner
//  • deletes evidence photos older than the retention period
// A message is only marked as sent when it went out (or there was nobody to send it to),
// so a missing LINE channel never silently burns the day.

import { getDb } from "./db";
import type { LineFlexMessage } from "./line";
import { cfgNum } from "./special-duty";
import { sweepEvidence } from "./special-duty-evidence";
import { closeDueBookings, openDays } from "./special-duty-fill";
import { dutyOwnerAlerts } from "./special-duty-payout";
import { noticeFlex, pushIndividually, thaiDate, thaiMonth } from "./special-duty-notify";
import { markAlertsNotified, pendingAlerts } from "./special-duty-roster";
import { managerLineIds } from "./special-duty-swap";

export type PushFn = (recipients: Array<string | null>, flex: LineFlexMessage) => Promise<number>;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const baseUrl = () => (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");

export type DailyResult = { closed: number; messages: number; swept: number };

export async function runSpecialDutyDaily(args: { today: string; hhmm: string; push?: PushFn }): Promise<DailyResult> {
  const db = getDb();
  const push = args.push ?? pushIndividually;
  const res: DailyResult = { closed: 0, messages: 0, swept: 0 };
  const morning = args.hhmm >= "09:00";

  /** Send once. `send` returns how many went out; claimed when ≥1 went out or when it had nobody to tell. */
  const once = async (branchId: number, ym: string, kind: string, key: string, recipients: Array<string | null>, flex: LineFlexMessage): Promise<void> => {
    if (db.prepare("SELECT 1 FROM special_duty_alerts WHERE branch_id = ? AND year_month = ? AND kind = ? AND dedupe_key = ?").get(branchId, ym, kind, key)) return;
    const real = recipients.filter((r): r is string => !!r);
    let sent = 0;
    if (real.length > 0) sent = await push(real, flex);
    if (real.length > 0 && sent === 0) return;                 // channel not ready → try again on the next run
    db.prepare("INSERT OR IGNORE INTO special_duty_alerts (branch_id, year_month, kind, dedupe_key, payload_json, created_at, notified_at) VALUES (?,?,?,?,?,?,?)")
      .run(branchId, ym, kind, key, null, new Date().toISOString(), new Date().toISOString());
    res.messages += sent;
  };
  const branchName = (id: number) => (db.prepare("SELECT name FROM branches WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";

  // 1. auto-close booking windows, tell the managers what is left to fill
  for (const c of closeDueBookings(args.today)) {
    res.closed++;
    const open = openDays(c.branchId, c.yearMonth).length;
    await once(c.branchId, c.yearMonth, "booking_closed", "closed", managerLineIds(c.branchId),
      noticeFlex({ title: `ปิดรับการเลือกวัน เดือน${thaiMonth(c.yearMonth)}`, lines: [branchName(c.branchId), `ปิดรับการเลือกวันแล้ว ยังมีวันที่ว่าง ${open} วัน กรุณาจัดวันที่ว่างและประกาศตาราง`], url: `${baseUrl()}/admin/persona/special-duty?month=${c.yearMonth}`, button: "จัดวันที่ว่าง" }));
  }

  // 2. alerts queued by the roster hooks → one message per branch
  const branches = (db.prepare("SELECT DISTINCT branch_id AS b FROM special_duty_months WHERE enabled = 1").all() as Array<{ b: number }>).map((r) => r.b);
  for (const b of branches) {
    const pend = pendingAlerts(b).filter((a) => a.kind === "slot_released" || a.kind === "coverage_gap");
    if (pend.length === 0) continue;
    const lines = pend.slice(0, 10).map((a) => {
      const p = a.payload as { positionName?: string; date?: string };
      return `${a.kind === "slot_released" ? "วันว่างจากการเปลี่ยนตาราง" : "ไม่มีผู้ที่รับได้"}: ${p.positionName ?? ""} ${p.date ? thaiDate(p.date) : ""}`;
    });
    if (pend.length > 10) lines.push(`และอีก ${pend.length - 10} รายการ`);
    const ym = pend[0].yearMonth;
    const recipients = managerLineIds(b);
    const real = recipients.length;
    let sent = 0;
    if (real > 0) sent = await push(recipients, noticeFlex({ title: "แจ้งเตือนตำแหน่งงานค่าตอบแทนพิเศษ", lines: [branchName(b), ...lines], url: `${baseUrl()}/admin/persona/special-duty?month=${ym}`, button: "เปิดดู" }));
    if (real === 0 || sent > 0) { markAlertsNotified(pend.map((a) => a.id)); res.messages += sent; }
  }

  if (morning) {
    // 3. reminders to the person doing the duty
    const dutyRows = (date: string) => db.prepare(`
      SELECT d.id, p.branch_id AS b, p.year_month AS ym, p.name AS pname, d.status, COALESCE(d.performer_user_id, d.user_id) AS uid, u.line_user_id AS line
        FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id JOIN users u ON u.id = COALESCE(d.performer_user_id, d.user_id)
        JOIN special_duty_months m ON m.branch_id = p.branch_id AND m.year_month = p.year_month
       WHERE d.duty_date = ? AND d.status IN ('booked','assigned','covered') AND m.enabled = 1 AND m.status IN ('special_published','in_progress')
    `).all(date) as Array<{ id: number; b: number; ym: string; pname: string; status: string; uid: number; line: string | null }>;
    const group = (rows: ReturnType<typeof dutyRows>) => { const m = new Map<string, typeof rows>(); for (const r of rows) m.set(`${r.b}|${r.ym}|${r.uid}`, [...(m.get(`${r.b}|${r.ym}|${r.uid}`) ?? []), r]); return m; };
    const tomorrow = addDays(args.today, 1);
    for (const rows of group(dutyRows(tomorrow)).values()) {
      const f = rows[0];
      await once(f.b, f.ym, "reminder_day", `${f.uid}:${tomorrow}`, [f.line],
        noticeFlex({ title: "พรุ่งนี้ท่านมีตำแหน่งงานค่าตอบแทนพิเศษ", lines: [branchName(f.b), `${thaiDate(tomorrow)} · ${rows.map((r) => r.pname).join(", ")}`, "เมื่อทำเสร็จให้ถ่ายภาพพื้นที่ทำงาน (ไม่มีบุคคลในภาพ) แล้วส่งหลักฐานในระบบ"], url: `${baseUrl()}/staff/persona/special-duty?month=${f.ym}`, button: "เปิดระบบ" }));
    }
    // the last day to send evidence is each branch's own setting
    const dutyBranches = (db.prepare("SELECT DISTINCT branch_id AS b FROM special_duty_months WHERE enabled = 1 AND status IN ('special_published','in_progress')").all() as Array<{ b: number }>).map((r) => r.b);
    for (const bId of dutyBranches) {
      const lastDay = addDays(args.today, -cfgNum("evidence_deadline_days", bId));
      for (const rows of group(dutyRows(lastDay).filter((r) => r.b === bId)).values()) {
        const f = rows[0];
        await once(f.b, f.ym, "evidence_due", `${f.uid}:${lastDay}`, [f.line],
          noticeFlex({ title: "วันนี้เป็นวันสุดท้ายในการส่งหลักฐาน", lines: [branchName(f.b), `${thaiDate(lastDay)} · ${rows.map((r) => r.pname).join(", ")}`, "ถ้าไม่ส่งภายในวันนี้ วันดังกล่าวจะไม่ได้รับค่าตอบแทน"], url: `${baseUrl()}/staff/persona/special-duty?month=${f.ym}`, button: "ส่งหลักฐาน" }));
      }
    }

    // 4. one digest a day per branch for the managers + owner alerts
    const months = db.prepare("SELECT branch_id AS b, year_month AS ym, status FROM special_duty_months WHERE enabled = 1 AND status IN ('booking_closed','filling','special_published','in_progress')").all() as Array<{ b: number; ym: string; status: string }>;
    const owners = (db.prepare("SELECT line_user_id AS l FROM users WHERE role = 'super_admin' AND status = 'active' AND line_user_id IS NOT NULL").all() as Array<{ l: string }>).map((r) => r.l);
    for (const m of months) {
      const deadline = addDays(args.today, -cfgNum("evidence_deadline_days", m.b) - 1);
      const waiting = (db.prepare("SELECT COUNT(*) n FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE p.branch_id = ? AND p.year_month = ? AND d.status = 'submitted'").get(m.b, m.ym) as { n: number }).n;
      const missing = (db.prepare("SELECT COUNT(*) n FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE p.branch_id = ? AND p.year_month = ? AND d.status IN ('booked','assigned','covered') AND d.duty_date <= ?").get(m.b, m.ym, deadline) as { n: number }).n;
      const swaps = (db.prepare("SELECT COUNT(*) n FROM special_duty_swaps WHERE branch_id = ? AND year_month = ? AND status = 'pending_manager'").get(m.b, m.ym) as { n: number }).n;
      const openCount = ["booking_closed", "filling"].includes(m.status) ? openDays(m.b, m.ym).length : 0;
      const lines: string[] = [];
      if (waiting > 0) lines.push(`หลักฐานรอตรวจ ${waiting} วัน`);
      if (missing > 0) lines.push(`ไม่มีการส่งหลักฐานหลังพ้นกำหนด ${missing} วัน (ตรวจและบันทึกขาด หรือมอบผู้ปฏิบัติแทน)`);
      if (swaps > 0) lines.push(`คำขอสลับวันรออนุมัติ ${swaps} รายการ`);
      if (openCount > 0) lines.push(`วันที่ยังว่าง ${openCount} วัน`);
      if (lines.length > 0)
        await once(m.b, m.ym, "digest", args.today, managerLineIds(m.b),
          noticeFlex({ title: `สรุปตำแหน่งงานค่าตอบแทนพิเศษ เดือน${thaiMonth(m.ym)}`, lines: [branchName(m.b), ...lines], url: `${baseUrl()}/admin/persona/special-duty?month=${m.ym}`, button: "เปิดหน้าผู้จัดการ" }));
      if (["special_published", "in_progress"].includes(m.status)) {
        const alerts = dutyOwnerAlerts(m.b, m.ym);
        if (alerts.length > 0)
          await once(m.b, m.ym, "owner_alert", alerts.map((a) => a.text).join("|"), owners,
            noticeFlex({ title: `ข้อควรตรวจสอบ ตำแหน่งงานค่าตอบแทนพิเศษ เดือน${thaiMonth(m.ym)}`, lines: [branchName(m.b), ...alerts.map((a) => a.text)], url: `${baseUrl()}/admin/persona/special-duty?month=${m.ym}`, button: "เปิดดู" }));
      }
    }
  }

  // 5. retention
  res.swept = sweepEvidence(args.today);
  return res;
}
