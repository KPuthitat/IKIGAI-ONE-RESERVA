// Annual check-up — the LINE notice sent when a person's results are released (phase 5). The card says only that the results are
// ready: no value, no verdict, no test name. A person without LINE gets nothing (the recorders see a names-only list instead).
import { countAwaitingDoctor, listApproverLineIds, listPendingNotifications, markNotified } from "./annual-checkup-db";
import { sendLinePush, type LineFlexMessage } from "./line";
import { getPlatformChannel } from "./messaging-channels";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
export const RESULT_PAGE = "/staff/health/annual";

export function resultsReadyCard(): LineFlexMessage {
  return {
    type: "flex",
    altText: "ผลตรวจสุขภาพประจำปีของท่านพร้อมแล้ว",
    contents: {
      type: "bubble", size: "kilo",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "18px",
        contents: [{ type: "text", text: "NOKHOOK OS · PERSONA", color: "#e9c88b", size: "xxs", weight: "bold" }]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "18px", spacing: "md",
        contents: [
          { type: "text", text: "ผลตรวจสุขภาพประจำปีของท่านพร้อมแล้ว", weight: "bold", size: "md", wrap: true, color: "#281a0e" },
          { type: "text", text: "เปิดดูได้ในพอร์ทัล โดยยืนยันตัวตนด้วยรหัส PIN ของท่าน", size: "sm", wrap: true, color: "#6b7280" }
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "14px",
        contents: [{ type: "button", style: "primary", color: "#a06820", action: { type: "uri", label: "เปิดดูผล", uri: `${PUBLIC_BASE}${RESULT_PAGE}` } }]
      }
    }
  };
}

/** Tell everyone whose results were released and not yet announced. Safe to call on every cron ping (notified_at stops repeats). */
export async function notifyReleasedResults(): Promise<number> {
  const token = getPlatformChannel()?.channel_token ?? null;
  if (!token) return 0;
  let sent = 0;
  for (const p of listPendingNotifications(30)) {
    try {
      const r = await sendLinePush(token, { to: p.line_user_id, messages: [resultsReadyCard()] });
      if (r.ok) { markNotified(p.conclusion_id); sent++; }
    } catch { /* try again on the next ping */ }
  }
  return sent;
}

// ── "results are waiting for the doctor" (phase 7) ──
// One card to the approving doctors when a recorder sends results over. It carries only a count and a link: no name, no value, no test.
export function doctorWaitingCard(count: number, roundId: number): LineFlexMessage {
  return {
    type: "flex",
    altText: `มีผลตรวจสุขภาพประจำปีรอแพทย์ตรวจสอบ ${count} คน`,
    contents: {
      type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "18px", contents: [{ type: "text", text: "NOKHOOK OS · PERSONA", color: "#e9c88b", size: "xxs", weight: "bold" }] },
      body: {
        type: "box", layout: "vertical", paddingAll: "18px", spacing: "md",
        contents: [
          { type: "text", text: `ผลตรวจสุขภาพประจำปีรอแพทย์ตรวจสอบ ${count} คน`, weight: "bold", size: "md", wrap: true, color: "#281a0e" },
          { type: "text", text: "เปิดรายการ ปลดล็อกด้วยเลขใบอนุญาต แล้วตรวจสอบและเปิดผลได้", size: "sm", wrap: true, color: "#6b7280" }
        ]
      },
      footer: { type: "box", layout: "vertical", paddingAll: "14px", contents: [{ type: "button", style: "primary", color: "#a06820", action: { type: "uri", label: "เปิดรายการรอตรวจสอบ", uri: `${PUBLIC_BASE}/staff/health/annual-checkup/${roundId}` } }] }
    }
  };
}

let lastDoctorNotice = 0;
/** Tell the doctors, at most once every 10 minutes (in memory), how many people are waiting. Best-effort: never throws into the request. */
export async function notifyDoctorsAwaiting(roundId: number, now = Date.now()): Promise<number> {
  try {
    if (now - lastDoctorNotice < 10 * 60_000) return 0;
    const count = countAwaitingDoctor(roundId);
    const token = getPlatformChannel()?.channel_token ?? null;
    if (count === 0 || !token) return 0;
    let sent = 0;
    for (const to of listApproverLineIds()) {
      const r = await sendLinePush(token, { to, messages: [doctorWaitingCard(count, roundId)] });
      if (r.ok) sent++;
    }
    if (sent > 0) lastDoctorNotice = now;
    return sent;
  } catch { return 0; }
}
export const resetDoctorNoticeThrottle = (): void => { lastDoctorNotice = 0; };
