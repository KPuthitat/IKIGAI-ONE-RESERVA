// ประกาศนโยบาย — LINE messages. Each employee is messaged individually (pushIndividually); the
// cards carry the title and topic headings only, the full letter and the acknowledge button
// live on the staff page.
import type { LineFlexMessage } from "./line";

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const TH_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** 'YYYY-MM-DDTHH:MM' (Bangkok local) → "วันพฤหัสบดีที่ 15 ต.ค. 2569 เวลา 14:00 น." */
export function thaiMeetingTime(meetingAt: string): string {
  const [d, t] = meetingAt.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const wd = TH_DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `วัน${wd}ที่ ${day} ${TH_MONTHS[m - 1]} ${y + 543} เวลา ${t} น.`;
}

function card(args: { altText: string; badge: string; title: string; lines: string[]; button: { label: string; url: string } }): LineFlexMessage {
  return {
    type: "flex", altText: args.altText,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#4C2FBF", paddingAll: "20px", contents: [
        { type: "text", text: "NOKHOOK OS", color: "#C9BEF5", size: "xxs", weight: "bold" },
        { type: "text", text: args.badge, color: "#ffffff", size: "xs", margin: "sm" },
        { type: "text", text: args.title, color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md" }
      ] },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "20px", contents: args.lines.map((t) => ({ type: "text", text: t, size: "sm", color: "#475569", wrap: true })) },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", contents: [
        { type: "button", style: "primary", color: "#6B4FD8", action: { type: "uri", label: args.button.label, uri: args.button.url } }
      ] }
    }
  };
}

export function meetingInviteFlex(args: { title: string; meetingAt: string; location: string; purpose: string; url: string }): LineFlexMessage {
  return card({
    altText: `นัดประชุม: ${args.title}`, badge: "ประกาศนัดประชุมพนักงาน", title: args.title,
    lines: [thaiMeetingTime(args.meetingAt), ...(args.location ? [`สถานที่: ${args.location}`] : []), ...(args.purpose ? [args.purpose] : [])],
    button: { label: "ดูรายละเอียด", url: args.url }
  });
}

export function letterFlex(args: { title: string; topics: string[]; ackDeadline: string | null; reminder: boolean; url: string }): LineFlexMessage {
  const shown = args.topics.slice(0, 6);
  return card({
    altText: `${args.reminder ? "เตือน: " : ""}หนังสือแจ้งหลังประชุม: ${args.title}`,
    badge: args.reminder ? "เตือน · ยังไม่ได้กดรับทราบ" : "หนังสือแจ้งหลังประชุม · โปรดกดรับทราบ", title: args.title,
    lines: [
      ...shown.map((t, i) => `${i + 1}. ${t}`),
      ...(args.topics.length > shown.length ? [`และอีก ${args.topics.length - shown.length} หัวข้อ`] : []),
      ...(args.ackDeadline ? [`กรุณากดรับทราบภายใน ${args.ackDeadline.split("-").reverse().join("/")}`] : [])
    ],
    button: { label: "อ่านและกดรับทราบ", url: args.url }
  });
}
