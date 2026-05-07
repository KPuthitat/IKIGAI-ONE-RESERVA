// LINE Messaging API helper — push messages to customer หรือ staff
// LINE Notify ปิดบริการตั้งแต่ 31 มี.ค. 2025 จึงต้องใช้ Messaging API แทน
// Free tier: 200 push messages/เดือน ต่อ channel (เพียงพอกับ ~120 bookings × 2 reminders)

import { getDb, type Branch, type Booking } from "./db";

// LINE message kinds we use. Loose typing is intentional — Flex contents are
// large JSON blobs and the API spec already documents the shape.
type LineTextMessage = { type: "text"; text: string };
type LineFlexMessage = { type: "flex"; altText: string; contents: unknown };
type LineMessage = LineTextMessage | LineFlexMessage;

type LinePushPayload = {
  to: string;
  messages: LineMessage[];
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

// ── PERSONA: clock-in confirmation Flex card ─────────────────────────

export type ClockInCardArgs = {
  displayName: string;
  clockInIsoTs: string;        // ISO timestamp of the clock-in event
  branchName: string;
  // Branch lunch settings (may be null = ไม่มีพักกลางวันวันนี้)
  lunchStart: string | null;   // 'HH:MM'
  lunchEnd: string | null;     // 'HH:MM'
  hasLunchToday: boolean;      // false → ข้ามแสดงพักกลางวัน
};

function hhmmFromIso(iso: string): string {
  // Convert UTC ISO → Bangkok HH:MM
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(11, 16);
}

function addMinutesHHMM(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const oh = Math.floor(wrapped / 60);
  const om = wrapped % 60;
  return `${String(oh).padStart(2, "0")}:${String(om).padStart(2, "0")}`;
}

function diffMinutesHHMM(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

/**
 * Compute the expected clock-out time:
 *   = clock-in + 8 hours of work + lunch-break duration (if any).
 * Same labor-law assumption as the payroll engine: 8 hours real work per day.
 */
function computeClockOut(clockInHHMM: string, args: ClockInCardArgs): string {
  let total = 8 * 60; // 8 hours of work
  if (args.hasLunchToday && args.lunchStart && args.lunchEnd) {
    const breakMin = diffMinutesHHMM(args.lunchStart, args.lunchEnd);
    if (breakMin > 0) total += breakMin;
  }
  return addMinutesHHMM(clockInHHMM, total);
}

/** Build a LINE Flex bubble confirming a successful clock-in. */
export function personaClockInFlex(args: ClockInCardArgs): LineFlexMessage {
  const inHHMM = hhmmFromIso(args.clockInIsoTs);
  const outHHMM = computeClockOut(inHHMM, args);
  const todayStr = formatThaiDate(
    new Date(new Date(args.clockInIsoTs).getTime() + 7 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
  );

  // Lunch row — only if branch has lunch break today
  const lunchRow = (args.hasLunchToday && args.lunchStart && args.lunchEnd) ? {
    type: "box", layout: "horizontal", spacing: "sm", contents: [
      { type: "text", text: "พักกลางวัน", size: "sm", color: "#888888", flex: 4 },
      { type: "text", text: `${args.lunchStart} – ${args.lunchEnd}`, size: "sm", color: "#222222", flex: 5, weight: "bold", align: "end" }
    ]
  } : null;

  const bodyRows = [
    {
      type: "box", layout: "horizontal", spacing: "sm", contents: [
        { type: "text", text: "เวลาเข้างาน", size: "sm", color: "#888888", flex: 4 },
        { type: "text", text: inHHMM, size: "sm", color: "#222222", flex: 5, weight: "bold", align: "end" }
      ]
    },
    ...(lunchRow ? [lunchRow] : []),
    {
      type: "box", layout: "horizontal", spacing: "sm", contents: [
        { type: "text", text: "เวลาเลิกงาน", size: "sm", color: "#888888", flex: 4 },
        { type: "text", text: outHHMM, size: "sm", color: "#222222", flex: 5, weight: "bold", align: "end" }
      ]
    }
  ];

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "vertical", spacing: "xs",
      backgroundColor: "#10b981",
      paddingAll: "16px",
      contents: [
        { type: "text", text: "✓ บันทึกเวลาเข้างานเรียบร้อย", color: "#ffffff", weight: "bold", size: "md" },
        { type: "text", text: todayStr, color: "#d1fae5", size: "xs" }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "16px",
      contents: [
        { type: "text", text: args.displayName, weight: "bold", size: "lg", color: "#222222", wrap: true },
        { type: "text", text: args.branchName, size: "xs", color: "#888888" },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: bodyRows }
      ]
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "12px",
      contents: [
        { type: "text", text: "ขอให้มีวันทำงานที่ดีนะคะ ✨", size: "xs", color: "#888888", align: "center", wrap: true }
      ]
    }
  };

  return {
    type: "flex",
    altText: `เข้างานเรียบร้อย ${inHHMM} · เลิก ${outHHMM}`,
    contents: bubble
  };
}

// ── Lunch-break helper: is lunch break active for a given branch + date? ──

/** Returns true if the branch's lunch break applies to the given Bangkok date. */
export function branchLunchAppliesOn(branch: Branch, bkkDate: string): boolean {
  if (!branch.lunch_break_start || !branch.lunch_break_end) return false;
  // Check exception list
  if (branch.no_lunch_break_dates) {
    try {
      const exceptions = JSON.parse(branch.no_lunch_break_dates) as string[];
      if (Array.isArray(exceptions) && exceptions.includes(bkkDate)) return false;
    } catch { /* ignore malformed */ }
  }
  // Check weekday list (default = every day if list is missing)
  if (branch.lunch_break_weekdays) {
    try {
      const days = JSON.parse(branch.lunch_break_weekdays) as number[];
      if (Array.isArray(days) && days.length > 0) {
        const dow = new Date(`${bkkDate}T00:00:00Z`).getUTCDay();
        if (!days.includes(dow)) return false;
      }
    } catch { /* ignore malformed */ }
  }
  return true;
}

/** Push a clock-in confirmation card to a staff member, fire-and-forget.
 *  Logs success/failure to notification_log. Silent on missing line_user_id
 *  or missing channel token (just records 'skipped'). */
export async function pushClockInCard(args: {
  userId: number;
  displayName: string;
  branch: Branch;
  clockInIsoTs: string;
}): Promise<void> {
  const db = getDb();
  const u = db.prepare("SELECT line_user_id FROM users WHERE id = ?").get(args.userId) as
    | { line_user_id: string | null } | undefined;

  if (!args.branch.line_channel_token || !u?.line_user_id) {
    // No-op: not configured for this user. We don't insert into
    // notification_log because it's keyed to bookings (booking_id NOT NULL).
    return;
  }

  const bkkDate = new Date(new Date(args.clockInIsoTs).getTime() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const hasLunchToday = branchLunchAppliesOn(args.branch, bkkDate);

  const flex = personaClockInFlex({
    displayName: args.displayName,
    clockInIsoTs: args.clockInIsoTs,
    branchName: args.branch.name,
    lunchStart: args.branch.lunch_break_start,
    lunchEnd: args.branch.lunch_break_end,
    hasLunchToday
  });

  await sendLinePush(args.branch.line_channel_token, {
    to: u.line_user_id,
    messages: [flex]
  });
  // Note: we intentionally don't await error logging here — clock-in must
  // never be blocked or rolled back by a LINE API hiccup.
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
