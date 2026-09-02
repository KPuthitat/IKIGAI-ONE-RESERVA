// LINE notification when someone is invited to an executive meeting
// (owner 2026-09-02). On invite, each new invitee gets a Flex card with a button
// that opens the staff ประชุมผู้บริหาร page — where they join and record the
// minutes. Fire-and-forget: skips users without line_user_id, never throws.

import { getDb } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush, type LineMessage } from "./line";
import { MEETING_FEE_PER_HOUR } from "./exec-meetings";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const STAFF_MEETING_URL = `${PUBLIC_BASE}/staff/persona/exec-meetings`;

function dateLabelTh(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
}

function inviteFlex(title: string, ymd: string): LineMessage {
  return {
    type: "flex",
    altText: `เชิญประชุม: ${title} (${dateLabelTh(ymd)})`,
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "text", text: "เชิญเข้าร่วมประชุมผู้บริหาร", weight: "bold", size: "sm", color: "#a06820" },
          { type: "text", text: title, weight: "bold", size: "lg", wrap: true, color: "#281a0e" },
          { type: "text", text: `วันที่ ${dateLabelTh(ymd)}`, size: "sm", color: "#8a7761" },
          { type: "text", text: "กดปุ่มด้านล่างเพื่อเข้าสู่ระบบ แล้วกดเข้าร่วมการประชุม และบันทึกรายงานการประชุมส่งเข้าระบบทุกครั้ง", size: "xs", color: "#8a7761", wrap: true, margin: "md" },
          { type: "text", text: `เพื่อให้ระบบคำนวณเบี้ยประชุมให้ ชั่วโมงละ ${MEETING_FEE_PER_HOUR} บาท (คิดตามจำนวนนาที)`, size: "xs", color: "#8a7761", wrap: true, margin: "sm" }
        ]
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "lg", paddingTop: "md",
        contents: [
          { type: "separator", color: "#e6ddce" },
          { type: "button", style: "primary", color: "#a06820", height: "md", margin: "md",
            action: { type: "uri", label: "เข้าสู่ระบบ", uri: STAFF_MEETING_URL } },
          { type: "text", text: "เข้าร่วม · บันทึกรายงาน · รับเบี้ยประชุม", size: "xxs", color: "#a8977f", align: "center" }
        ]
      }
    }
  };
}

export async function notifyMeetingInvitees(meetingId: number, userIds: number[]): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return;
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) return;
  const token = platform.channel_token;

  const db = getDb();
  const m = db.prepare("SELECT title, meeting_date FROM exec_meetings WHERE id = ?")
    .get(meetingId) as { title: string; meeting_date: string } | undefined;
  if (!m) return;
  const flex = inviteFlex(m.title, m.meeting_date);

  const rows = db.prepare(
    `SELECT line_user_id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as Array<{ line_user_id: string | null }>;
  for (const r of rows) {
    if (!r.line_user_id?.trim()) continue;
    try {
      const res = await sendLinePush(token, { to: r.line_user_id, messages: [flex] });
      if (!res.ok) console.warn("exec-meeting invite push failed", res.error);
    } catch (e) {
      console.warn("exec-meeting invite push threw", e);
    }
  }
}
