// LINE notification when someone is invited to an executive meeting
// (owner 2026-09-02). On invite, each new invitee gets a Flex card with a button
// that opens the staff ประชุมผู้บริหาร page — where they join and record the
// minutes. Fire-and-forget: skips users without line_user_id, never throws.

import { getDb } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush, type LineMessage } from "./line";
import { MEETING_FEE_PER_HOUR, parseAgendaTopics } from "./exec-meetings";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const STAFF_MEETING_URL = `${PUBLIC_BASE}/staff/persona/exec-meetings`;

function dateLabelTh(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
}

// Thai has no spaces, so LINE wraps long runs at word boundaries — which reads
// raggedy and can split a phrase like "(คิดตามจำนวนนาที)" mid-way. WORD JOINER
// (U+2060, zero-width) glues a phrase so it never splits; NBSP keeps visible
// spaces (e.g. in "200 บาท") from becoming break points. Copy is kept short and
// split into separate lines so each wraps cleanly on its own.
const WJ = "\u2060";
const NBSP = "\u00A0";
const feeLabel = `ชั่วโมงละ${NBSP}${MEETING_FEE_PER_HOUR}${NBSP}บาท`;
const feeNote = `(คิดตาม${WJ}จำนวน${WJ}นาที)`;

// วาระที่ตั้งไว้ล่วงหน้า — shown on the card so invitees can prepare (owner
// 2026-09-02). Each topic is a numbered line; blank list renders nothing.
function agendaBlock(topics: string[]): Record<string, unknown>[] {
  if (topics.length === 0) return [];
  return [
    { type: "text", text: "วาระการประชุม", weight: "bold", size: "xs", color: "#a06820", margin: "lg" },
    ...topics.map((t, i) => ({
      type: "box", layout: "baseline", spacing: "sm", margin: "sm",
      contents: [
        { type: "text", text: `${i + 1}.`, size: "sm", color: "#a8977f", flex: 0 },
        { type: "text", text: t, size: "sm", color: "#4a3f30", wrap: true }
      ]
    }))
  ];
}

function inviteFlex(title: string, ymd: string, topics: string[]): LineMessage {
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
          ...agendaBlock(topics),
          { type: "separator", color: "#efe7d9", margin: "lg" },
          { type: "text", text: "กดเข้าสู่ระบบ แล้วกดเข้าร่วมประชุม", size: "sm", color: "#4a3f30", wrap: true, margin: "lg" },
          { type: "text", text: "บันทึกรายงานการประชุมส่งเข้าระบบทุกครั้ง", size: "sm", color: "#4a3f30", wrap: true, margin: "sm" },
          {
            type: "box", layout: "baseline", margin: "lg", spacing: "sm",
            contents: [
              { type: "text", text: "เบี้ยประชุม", size: "xs", color: "#8a7761", flex: 0 },
              { type: "text", text: feeLabel, size: "md", weight: "bold", color: "#a06820", align: "end" }
            ]
          },
          { type: "text", text: feeNote, size: "xxs", color: "#a8977f", align: "end" }
        ]
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "lg", paddingTop: "md",
        contents: [
          { type: "separator", color: "#e6ddce" },
          { type: "button", style: "primary", color: "#a06820", height: "md", margin: "md",
            action: { type: "uri", label: "เข้าสู่ระบบ", uri: STAFF_MEETING_URL } }
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
  const m = db.prepare("SELECT title, meeting_date, agenda_topics FROM exec_meetings WHERE id = ?")
    .get(meetingId) as { title: string; meeting_date: string; agenda_topics: string | null } | undefined;
  if (!m) return;
  const flex = inviteFlex(m.title, m.meeting_date, parseAgendaTopics(m.agenda_topics));

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
