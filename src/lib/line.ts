// LINE Messaging API helper — push messages to customer หรือ staff
// LINE Notify ปิดบริการตั้งแต่ 31 มี.ค. 2025 จึงต้องใช้ Messaging API แทน
// Free tier: 200 push messages/เดือน ต่อ channel (เพียงพอกับ ~120 bookings × 2 reminders)

import { getDb, type Branch, type Booking } from "./db";

type LinePushPayload = {
  to: string;
  messages: Array<{ type: "text"; text: string }>;
};

export async function sendLinePush(
  channelToken: string,
  payload: LinePushPayload
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelToken}`
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text };
    }
    return { ok: true, status: res.status };
  } catch (e: unknown) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export function customerReminderMessage(b: Booking, branchName: string): string {
  return [
    `🍽️ แจ้งเตือนการจองโต๊ะ`,
    `ร้าน: ${branchName}`,
    `ชื่อ: ${b.customer_name}`,
    `จำนวน: ${b.party_size} ที่นั่ง`,
    `วันที่: ${formatThaiDate(b.booking_date)} เวลา ${b.booking_time}`,
    "",
    `ทีมงานพร้อมต้อนรับคุณค่ะ 🙏`,
    `หากต้องการยกเลิก กรุณาแจ้งล่วงหน้าผ่าน LINE นี้`
  ].join("\n");
}

export function customerConfirmedMessage(b: Booking, branchName: string): string {
  return [
    `✅ ยืนยันการจองโต๊ะ`,
    `ร้าน: ${branchName}`,
    `ชื่อ: ${b.customer_name}`,
    `จำนวน: ${b.party_size} ที่นั่ง`,
    `วันที่: ${formatThaiDate(b.booking_date)} เวลา ${b.booking_time}`,
    "",
    `เราจะส่งแจ้งเตือนอีกครั้งก่อนถึงเวลาจองค่ะ`
  ].join("\n");
}

export function staffReminderMessage(b: Booking, tableLabel: string | null): string {
  return [
    `🔔 มีจองโต๊ะใกล้ถึงเวลา`,
    `ลูกค้า: ${b.customer_name} (${b.customer_phone})`,
    `จำนวน: ${b.party_size} ที่นั่ง`,
    `เวลา: ${b.booking_time}`,
    `โต๊ะ: ${tableLabel ?? "ยังไม่ได้กำหนด"}`,
    b.notes ? `หมายเหตุ: ${b.notes}` : ""
  ].filter(Boolean).join("\n");
}

export function staffNewBookingMessage(b: Booking): string {
  return [
    `🆕 มีการจองใหม่`,
    `ลูกค้า: ${b.customer_name} (${b.customer_phone})`,
    `จำนวน: ${b.party_size} ที่นั่ง`,
    `วันที่: ${formatThaiDate(b.booking_date)} ${b.booking_time}`,
    b.source ? `ที่มา: ${b.source}` : ""
  ].filter(Boolean).join("\n");
}

function formatThaiDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-");
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${parseInt(y, 10) + 543}`;
}

export async function notifyCustomer(
  branch: Branch, booking: Booking, type: "created" | "reminder"
): Promise<void> {
  const db = getDb();
  if (!branch.line_channel_token || !booking.line_user_id) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "customer", "skipped",
      !branch.line_channel_token ? "no channel token" : "no line_user_id");
    return;
  }
  const text = type === "created"
    ? customerConfirmedMessage(booking, branch.name)
    : customerReminderMessage(booking, branch.name);
  const res = await sendLinePush(branch.line_channel_token, {
    to: booking.line_user_id,
    messages: [{ type: "text", text }]
  });
  db.prepare(
    "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
  ).run(booking.id, type, "customer", res.ok ? "sent" : "failed", res.error ?? null);
}

export async function notifyStaff(
  branch: Branch, booking: Booking, tableLabel: string | null,
  type: "created" | "reminder"
): Promise<void> {
  const db = getDb();
  if (!branch.line_channel_token || !branch.staff_line_user_ids) return;
  let staffIds: string[] = [];
  try {
    staffIds = JSON.parse(branch.staff_line_user_ids);
  } catch {
    return;
  }
  if (staffIds.length === 0) return;
  const text = type === "created"
    ? staffNewBookingMessage(booking)
    : staffReminderMessage(booking, tableLabel);
  for (const uid of staffIds) {
    const res = await sendLinePush(branch.line_channel_token, {
      to: uid, messages: [{ type: "text", text }]
    });
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "staff", res.ok ? "sent" : "failed", res.error ?? null);
  }
}
