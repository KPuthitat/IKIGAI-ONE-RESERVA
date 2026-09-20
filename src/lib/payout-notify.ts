// Notify staff on LINE when their payroll or service-charge payout is marked
// PAID (owner 2026-09-20). One personal message per person via the platform
// (IKIGAI OS) OA, with NO amount — just "it's been paid, check your slip".
//
// Best-effort by design: every entry point swallows its own errors so a LINE
// hiccup can never fail the payout action, and people without a bound LINE
// account are silently skipped. sendLinePush already no-ops outside production
// (its dev guard), so this is safe to call from tests/CI too.

import { getDb } from "./db";
import { getPlatformChannel } from "./messaging-channels";
import { sendLinePush } from "./line";
import { computeMonthlySvcSummary, computeCompanySvcSummary } from "./service-charge";
import { thMonthLabel } from "./th-month";
import { roundLabel } from "./revshare";

type Recipient = { userId: number; lineUserId: string };

const APP_HINT = "ตรวจสอบรายละเอียดได้ในแอป IKIGAI OS";

// Yield to the event loop so the caller's `void notify…()` returns immediately
// and the payout HTTP response flushes BEFORE the (synchronous, roster-heavy) SVC
// recompute and the LINE sends run. Without this, an `async` body runs inline up
// to its first real await, blocking the response on the 1-vCPU droplet.
const deferPastResponse = () => new Promise<void>((res) => setImmediate(res));

/** Which of `userIds` have a LINE account bound (others can't be reached). */
export function boundLineUsers(userIds: number[]): Recipient[] {
  const ids = [...new Set(userIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  return getDb().prepare(
    `SELECT id AS userId, line_user_id AS lineUserId FROM users
     WHERE id IN (${ids.map(() => "?").join(",")})
       AND line_user_id IS NOT NULL AND line_user_id != ''`
  ).all(...ids) as Recipient[];
}

/** Fire a plain-text LINE to each recipient via the platform OA, concurrently.
 *  Never throws; returns delivery counts. */
async function pushTextToUsers(recipients: Recipient[], text: string): Promise<{ sent: number; failed: number }> {
  if (!recipients.length) return { sent: 0, failed: 0 };
  const token = getPlatformChannel()?.channel_token;
  if (!token) return { sent: 0, failed: recipients.length };
  let sent = 0, failed = 0;
  const results = await Promise.allSettled(
    recipients.map((r) => sendLinePush(token, { to: r.lineUserId, messages: [{ type: "text", text }] }))
  );
  for (const res of results) {
    if (res.status === "fulfilled" && res.value.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

/** Staff in a payroll period get told their pay was disbursed (no amount). */
export async function notifyPayrollPeriodPaid(periodId: number): Promise<void> {
  try {
    await deferPastResponse();
    const db = getDb();
    const period = db.prepare(
      "SELECT cycle, period_start, period_end FROM payroll_periods WHERE id = ?"
    ).get(periodId) as { cycle: string; period_start: string; period_end: string } | undefined;
    if (!period) return;
    // net_pay > 0: someone whose net is exactly 0 got nothing disbursed, so
    // there's nothing to announce to them.
    const userIds = (db.prepare(
      "SELECT DISTINCT user_id FROM payroll_lines WHERE period_id = ? AND net_pay > 0"
    ).all(periodId) as Array<{ user_id: number }>).map((r) => r.user_id);
    const recipients = boundLineUsers(userIds);
    if (!recipients.length) return;
    // Monthly salary reads as a month; a weekly round reads as its date span.
    const periodLabel = period.cycle === "monthly"
      ? `ประจำเดือน${thMonthLabel(period.period_end.slice(0, 7))}`
      : `งวด ${roundLabel(period.period_start, period.period_end)}`;
    const text =
      "แจ้งการจ่ายค่าตอบแทน\n\n" +
      `ค่าตอบแทน (เงินเดือน) ${periodLabel} ได้ดำเนินการจ่ายเรียบร้อยแล้ว\n\n` +
      `${APP_HINT} · เมนู “ค่าตอบแทน”`;
    await pushTextToUsers(recipients, text);
  } catch (e) {
    console.error("[payout-notify] payroll:", (e as Error).message);
  }
}

async function notifySvc(recipientUserIds: number[], yearMonth: string): Promise<void> {
  const recipients = boundLineUsers(recipientUserIds);
  if (!recipients.length) return;
  const text =
    "แจ้งการจ่ายเซอร์วิสชาร์จ\n\n" +
    `ส่วนแบ่งเซอร์วิสชาร์จ ประจำเดือน${thMonthLabel(yearMonth)} ได้ดำเนินการจ่ายเรียบร้อยแล้ว\n\n` +
    `${APP_HINT} · เมนู “เซอร์วิสชาร์จ”`;
  await pushTextToUsers(recipients, text);
}

/** Staff who received SVC at a branch this month get told it was disbursed. */
export async function notifySvcBranchPaid(branchId: number, yearMonth: string): Promise<void> {
  try {
    await deferPastResponse();
    const rows = computeMonthlySvcSummary(branchId, yearMonth).rows;
    await notifySvc(rows.filter((r) => r.netPayout > 0).map((r) => r.userId), yearMonth);
  } catch (e) {
    console.error("[payout-notify] svc-branch:", (e as Error).message);
  }
}

/** Company-wide SVC payout: notify everyone who received a share this month. */
export async function notifySvcCompanyPaid(companyId: number, yearMonth: string): Promise<void> {
  try {
    await deferPastResponse();
    // Company mark_paid is only permitted once every participating branch is
    // finalized (it then pays them all together), so every earner in the
    // company summary was in fact disbursed this run.
    const rows = computeCompanySvcSummary(companyId, yearMonth).rows;
    await notifySvc(rows.filter((r) => r.netPayout > 0).map((r) => r.userId), yearMonth);
  } catch (e) {
    console.error("[payout-notify] svc-company:", (e as Error).message);
  }
}
