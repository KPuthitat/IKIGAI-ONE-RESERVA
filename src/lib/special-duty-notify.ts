// ตำแหน่งงานค่าตอบแทนพิเศษ — LINE messages. Each person is messaged individually and the
// card never carries any other staff member's name or booking.

import { sendLinePush, type LineFlexMessage } from "./line";
import { getPlatformChannel } from "./messaging-channels";

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

export function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}
export function thaiMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${TH_MONTHS[m - 1]} ${y + 543}`;
}

export function bookingOpenFlex(args: { branchName: string; yearMonth: string; closeDate: string | null; url: string }): LineFlexMessage {
  const title = `เปิดจองตำแหน่งงานค่าตอบแทนพิเศษ เดือน${thaiMonth(args.yearMonth)}`;
  const lines = [
    `ตารางงานประจำเดือนได้เผยแพร่แล้ว ท่านสามารถเลือกวันที่ต้องการรับตำแหน่งงานค่าตอบแทนพิเศษได้เฉพาะในวันที่ท่านมีตารางทำงาน`,
    ...(args.closeDate ? [`ปิดรับการเลือกวันที่ ${thaiDate(args.closeDate)}`] : [])
  ];
  return {
    type: "flex", altText: `${title} · ${args.branchName}`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "20px", contents: [
        { type: "text", text: "NOKHOOK OS", color: "#d6a14d", size: "xxs", weight: "bold" },
        { type: "text", text: title, color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md" }
      ] },
      body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "20px", contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: "#1a1a2e", wrap: true },
        ...lines.map((t) => ({ type: "text", text: t, size: "sm", color: "#64748b", wrap: true }))
      ] },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", contents: [
        { type: "button", style: "primary", color: "#a06820", action: { type: "uri", label: "เลือกวันที่ต้องการ", uri: args.url } }
      ] }
    }
  };
}

/** Push one flex message to each recipient separately. Returns how many were accepted. */
export async function pushIndividually(recipients: Array<string | null>, flex: LineFlexMessage): Promise<number> {
  const token = getPlatformChannel()?.channel_token?.trim();
  if (!token) return 0;
  let sent = 0;
  for (const to of recipients) {
    if (!to) continue;
    try { if ((await sendLinePush(token, { to, messages: [flex] })).ok) sent++; } catch (e) { console.warn("[special-duty] push failed", e); }
  }
  return sent;
}

export function schedulePublishedFlex(args: { branchName: string; yearMonth: string; days: Array<{ positionName: string; date: string }>; url: string }): LineFlexMessage {
  const title = `ตารางตำแหน่งงานค่าตอบแทนพิเศษ เดือน${thaiMonth(args.yearMonth)}`;
  return {
    type: "flex", altText: `${title} · ${args.branchName}`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "20px", contents: [
        { type: "text", text: "NOKHOOK OS", color: "#d6a14d", size: "xxs", weight: "bold" },
        { type: "text", text: title, color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md" }
      ] },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "20px", contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: "#1a1a2e", wrap: true },
        { type: "text", text: "วันที่ท่านได้รับตำแหน่งงานค่าตอบแทนพิเศษ", size: "sm", color: "#64748b", wrap: true },
        ...args.days.slice(0, 12).map((d) => ({ type: "text", text: `${thaiDate(d.date)} · ${d.positionName}`, size: "sm", color: "#1a1a2e", wrap: true })),
        ...(args.days.length > 12 ? [{ type: "text", text: `และอีก ${args.days.length - 12} วัน ดูรายละเอียดทั้งหมดในระบบ`, size: "xs", color: "#64748b", wrap: true }] : [])
      ] },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", contents: [
        { type: "button", style: "primary", color: "#a06820", action: { type: "uri", label: "ดูตารางของฉัน", uri: args.url } }
      ] }
    }
  };
}
