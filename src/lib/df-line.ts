// Doctor-Fee LINE cards (owner 2026-09-13) — DM a Flex card to ONE doctor's
// personal LINE (users.line_user_id) via the IKIGAI OS platform OA, exactly like
// the จ้อจี้/revshare partner cards but per-doctor. Two cards: a daily DF
// heads-up and a weekly payout summary. A guarantee (การันตี) doctor's weekly
// card shows the guarantee payout (not plain DF).

import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";

type FlexMsg = { type: "flex"; altText: string; contents: unknown };

const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";

function kv(label: string, value: string, opts?: { color?: string; bold?: boolean; size?: string }): unknown {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: opts?.size ?? "sm", color: "#666666", flex: 5, wrap: true },
      { type: "text", text: value, size: opts?.size ?? "sm", color: opts?.color ?? "#1a1a2e", weight: opts?.bold ? "bold" : "regular", align: "end", flex: 4 }
    ]
  };
}
const sep = { type: "separator", margin: "md", color: "#eeeeee" };

function header(title: string, subtitle: string): unknown {
  return {
    type: "box", layout: "vertical", backgroundColor: "#0e2724", paddingAll: "16px", spacing: "xs",
    contents: [
      { type: "text", text: "IKIGAI OS · ค่าตอบแทนแพทย์", size: "xxs", color: "#7fd1bd" },
      { type: "text", text: title, size: "lg", weight: "bold", color: "#ffffff" },
      { type: "text", text: subtitle, size: "xs", color: "#a9cfc6" }
    ]
  };
}
function footer(note: string): unknown {
  return {
    type: "box", layout: "vertical", paddingAll: "10px",
    contents: [{ type: "text", text: note, size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }]
  };
}

// ── Daily DF card (owner 2026-09-13/14: สรุปรายวัน + แจกแจงรหัส + ยอดสะสม) ──
export type DfDailyCard = {
  doctorName: string; clinicName: string; dateLabel: string;
  perCode: Array<{ code: string; share: number; bills: number }>;
  patients: number; doctorCount: number; dayShare: number;
  weekLabel: string; weekAccum: number; monthLabel: string; monthAccum: number;
};
export function dfDoctorDailyFlex(d: DfDailyCard): FlexMsg {
  const body: unknown[] = [
    { type: "text", text: d.doctorName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `คลินิก: ${d.clinicName}`, size: "xxs", color: "#999999", wrap: true },
    sep,
    { type: "text", text: "รายการค่าตอบแทน (DF) วันนี้", size: "xs", color: "#888888" }
  ];
  if (d.perCode.length === 0) {
    body.push({ type: "text", text: "— ไม่มีรายการที่คิด DF —", size: "sm", color: "#999999" });
  } else {
    for (const c of d.perCode) body.push(kv(`[${c.code}] · ${c.bills} บิล`, baht(c.share)));
  }
  if (d.doctorCount > 1) {
    body.push({ type: "text", text: `แบ่งกับแพทย์ ${d.doctorCount} ท่านในเวรวันนี้ (หารเท่ากัน)`, size: "xxs", color: "#999999", wrap: true });
  }
  body.push(kv("ตรวจคนไข้วันนี้", `${d.patients.toLocaleString("th-TH")} คน`));
  body.push(sep);
  body.push(kv("ค่าตอบแทน (DF) ของท่านวันนี้", baht(d.dayShare), { bold: true, color: "#0f6e56", size: "md" }));
  body.push(sep);
  body.push({ type: "text", text: "ยอดสะสม", size: "xs", color: "#888888" });
  body.push(kv(`สัปดาห์นี้ (${d.weekLabel})`, baht(d.weekAccum), { bold: true }));
  body.push(kv(`เดือนนี้ (${d.monthLabel})`, baht(d.monthAccum), { bold: true }));
  return {
    type: "flex",
    altText: `สรุปค่าตอบแทนแพทย์ (DF) ประจำวัน ${d.dateLabel} · ${baht(d.dayShare)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปค่าตอบแทนแพทย์ (DF)", `ประจำวัน · ${d.dateLabel}`),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("ยอดสะสมจะสรุปยอดจ่ายจริงอีกครั้งในรอบจ่ายรายสัปดาห์")
    }
  };
}

// ── Weekly DF card (owner 2026-09-13: สรุปรายสัปดาห์) ──
export type DfWeeklyCard = {
  doctorName: string; clinicName: string; weekLabel: string; payDateLabel: string;
  workedDays: number;
  grossFee: number; whtRate: number; whtAmount: number; netFee: number;
  // Guarantee (การันตี) breakdown — present only for a guarantee doctor.
  isGuarantee: boolean; guaranteeHours: number; guaranteeAmount: number; dfEarned: number;
  deficitBefore: number; deficitAfter: number;
};
export function dfDoctorWeeklyFlex(d: DfWeeklyCard): FlexMsg {
  const body: unknown[] = [
    { type: "text", text: d.doctorName, weight: "bold", size: "lg", wrap: true },
    { type: "text", text: `คลินิก: ${d.clinicName}`, size: "xxs", color: "#999999", wrap: true },
    sep
  ];

  if (d.isGuarantee) {
    body.push(kv("การันตี (เรท × ชม.ตามเวร)", `${baht(d.guaranteeAmount)} · ${d.guaranteeHours.toLocaleString("th-TH", { maximumFractionDigits: 1 })} ชม.`));
    body.push(kv("DF ที่ทำได้จริง", baht(d.dfEarned)));
    if (d.dfEarned >= d.guaranteeAmount && d.deficitBefore > 0) {
      body.push(kv("คืนยอดที่คลินิกออกให้ก่อนหน้า", "−" + baht(Math.min(d.dfEarned - d.guaranteeAmount, d.deficitBefore)), { color: "#854f0b" }));
    } else if (d.dfEarned < d.guaranteeAmount) {
      body.push(kv("คลินิกออกส่วนต่างให้", "+" + baht(d.guaranteeAmount - d.dfEarned), { color: "#0f6e56" }));
    }
    body.push(kv("ยอดที่จ่ายสัปดาห์นี้ (ก่อนหักภาษี)", baht(d.grossFee), { bold: true }));
    if (d.deficitAfter > 0) {
      body.push({ type: "text", text: `ยกยอดที่คลินิกออกให้สะสม ${baht(d.deficitAfter)} (จะหักคืนเมื่อ DF เกินการันตี)`, size: "xxs", color: "#854f0b", wrap: true });
    }
  } else {
    body.push(kv("วันเวรที่มียอด", `${d.workedDays} วัน`));
    body.push(kv("ค่าตอบแทน (DF) ก่อนหักภาษี", baht(d.grossFee), { bold: true }));
  }

  if (d.whtAmount > 0) {
    body.push(kv(`หักภาษี ณ ที่จ่าย ${(d.whtRate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}%`, "−" + baht(d.whtAmount), { color: "#a32d2d" }));
  }
  body.push(sep);
  body.push({
    type: "box", layout: "vertical", margin: "md", contents: [
      { type: "text", text: `โอนสุทธิ · จ่ายวันจันทร์ที่ ${d.payDateLabel}`, size: "xs", color: "#888888", wrap: true },
      { type: "text", text: baht(d.netFee), size: "xxl", weight: "bold", color: "#0f6e56" }
    ]
  });

  return {
    type: "flex",
    altText: `สรุปค่าตอบแทนแพทย์ (DF) ประจำสัปดาห์ ${d.weekLabel} · โอนสุทธิ ${baht(d.netFee)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปค่าตอบแทนแพทย์ (DF)", `ประจำสัปดาห์ · ${d.weekLabel}`),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("เอกสารแจ้งเตือนภายใน ไม่ใช่เอกสารทางภาษี")
    }
  };
}

/** DM a Flex card to one doctor's personal LINE via the platform OA. */
export async function notifyDoctorDf(lineUserId: string, flex: FlexMsg): Promise<{ ok: boolean; error?: string }> {
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, error: "platform_oa_not_configured" };
  const res = await sendLinePush(token, { to: lineUserId, messages: [flex] });
  return { ok: res.ok, error: res.error };
}
