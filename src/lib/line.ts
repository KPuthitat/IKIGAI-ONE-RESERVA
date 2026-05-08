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

// (Legacy text builders for booking events were replaced by Flex cards —
// see customerBookingFlex / staffBookingFlex below. notifyCustomer and
// notifyStaff at the bottom of this file are still the entry points used
// by the API routes + cron job.)

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
  personaUrl: string;          // deep link the action button opens
};

// IKIGAI OS CI palette — keep in sync with tailwind.config.ts
const COLOR_INK_900 = "#0f3460";
const COLOR_INK_700 = "#1a1a2e";
const COLOR_BRAND = "#e94560";
const COLOR_BRAND_LIGHT = "#ff6b85";
const COLOR_TEXT_DARK = "#1a1a2e";
const COLOR_TEXT_MUTED = "#94a3b8";
const COLOR_LABEL = "#64748b";
const COLOR_DIVIDER = "#e2e8f0";

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

/** Build a LINE Flex bubble confirming a successful clock-in.
 *
 * Visual: IKIGAI OS CI palette — ink navy header with brand red-pink accent.
 * The LINE app renders text in LINE Seed Sans TH on Thai devices by default;
 * Flex Messages have no `font` property so we just rely on the system default.
 */
export function personaClockInFlex(args: ClockInCardArgs): LineFlexMessage {
  const inHHMM = hhmmFromIso(args.clockInIsoTs);
  const outHHMM = computeClockOut(inHHMM, args);
  const todayStr = formatThaiDate(
    new Date(new Date(args.clockInIsoTs).getTime() + 7 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
  );

  // ── Time-rows (label : value, label muted, value bold) ──
  function timeRow(label: string, value: string) {
    return {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "text", text: label, size: "sm", color: COLOR_LABEL, flex: 4 },
        { type: "text", text: value, size: "sm", color: COLOR_TEXT_DARK, flex: 5, weight: "bold", align: "end" }
      ]
    };
  }

  const bodyRows: unknown[] = [timeRow("เวลาเข้างาน", inHHMM)];
  if (args.hasLunchToday && args.lunchStart && args.lunchEnd) {
    bodyRows.push(timeRow("พักกลางวัน", `${args.lunchStart} – ${args.lunchEnd}`));
  }
  bodyRows.push(timeRow("เวลาเลิกงาน", outHHMM));

  const bubble = {
    type: "bubble",
    size: "kilo",
    // ── Header: ink navy with IKIGAI OS / PERSONA branding bar ──
    header: {
      type: "box", layout: "vertical",
      backgroundColor: COLOR_INK_700,
      paddingAll: "20px",
      paddingTop: "18px",
      paddingBottom: "18px",
      contents: [
        // Brand bar: "IKIGAI OS" left + "PERSONA" right
        {
          type: "box", layout: "horizontal",
          contents: [
            {
              type: "text", text: "IKIGAI OS",
              color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1
            },
            {
              type: "text", text: "PERSONA",
              color: "#cbd5e1", size: "xxs", align: "end", flex: 1
            }
          ]
        },
        // Title row: bold + checkmark in brand color
        {
          type: "box", layout: "baseline", spacing: "sm", margin: "md",
          contents: [
            { type: "text", text: "✓", color: COLOR_BRAND_LIGHT, size: "lg", weight: "bold", flex: 0 },
            { type: "text", text: "บันทึกเวลาเข้างาน", color: "#ffffff", size: "lg", weight: "bold" }
          ]
        },
        { type: "text", text: todayStr, color: COLOR_TEXT_MUTED, size: "xs", margin: "xs" }
      ]
    },
    // ── Body: name + branch + time table ──
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "20px",
      contents: [
        { type: "text", text: args.displayName, weight: "bold", size: "lg", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: args.branchName, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs" },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: bodyRows }
      ]
    },
    // ── Footer: brand-colored CTA button to PERSONA ──
    footer: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "0px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR_BRAND,
          height: "sm",
          action: {
            type: "uri",
            label: "เปิดระบบ PERSONA",
            uri: args.personaUrl
          }
        }
      ]
    },
    // Subtle bottom-edge accent matching ink-900 (a thin band visible below
    // the footer button on most devices).
    styles: {
      header: { backgroundColor: COLOR_INK_700 },
      body: { backgroundColor: "#ffffff" },
      footer: { backgroundColor: "#ffffff", separator: true, separatorColor: COLOR_DIVIDER }
    }
  };
  // Suppress unused-var warnings for palette tokens not used in this card
  void COLOR_INK_900;

  return {
    type: "flex",
    altText: `บันทึกเวลาเข้างาน ${inHHMM} · เลิก ${outHHMM}`,
    contents: bubble
  };
}

// ── RESERVA: booking confirmation / reminder Flex cards ─────────────

export type CustomerBookingCardArgs = {
  branchName: string;
  branchSlug: string;          // for the "open restaurant" button URL
  bookingId: number;
  customerName: string;
  partySize: number;
  bookingDate: string;          // YYYY-MM-DD
  bookingTime: string;          // HH:MM
  notes: string | null;
  publicBaseUrl: string;        // e.g., 'https://ikigaimedihealth.com'
  kind: "created" | "reminder";
};

export type StaffBookingCardArgs = {
  branchName: string;
  bookingId: number;
  customerName: string;
  customerPhone: string;
  partySize: number;
  bookingDate: string;          // YYYY-MM-DD
  bookingTime: string;          // HH:MM
  tableLabel: string | null;
  notes: string | null;
  source: string | null;
  publicBaseUrl: string;
  kind: "created" | "reminder";
};

/** Two-column kv row helper used by both booking cards. */
function kvRow(label: string, value: string, opts?: { valueColor?: string; valueWeight?: "regular" | "bold" }) {
  return {
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: COLOR_LABEL, flex: 4 },
      {
        type: "text", text: value, size: "sm",
        color: opts?.valueColor ?? COLOR_TEXT_DARK,
        weight: opts?.valueWeight ?? "bold",
        flex: 6, align: "end", wrap: true
      }
    ]
  };
}

/** Build a customer-facing Flex card for a new / upcoming booking. */
export function customerBookingFlex(args: CustomerBookingCardArgs): LineFlexMessage {
  const isReminder = args.kind === "reminder";
  const titleText = isReminder ? "แจ้งเตือนการจองโต๊ะ" : "ยืนยันการจองโต๊ะ";
  const iconText = isReminder ? "🔔" : "✓";
  const dateStr = formatThaiDate(args.bookingDate);

  const bodyRows = [
    kvRow("ชื่อผู้จอง", args.customerName),
    kvRow("จำนวน", `${args.partySize} ที่นั่ง`),
    kvRow("วันที่", dateStr),
    kvRow("เวลา", args.bookingTime),
    kvRow("เลขที่จอง", `#${args.bookingId}`, { valueColor: COLOR_BRAND, valueWeight: "bold" })
  ];

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: COLOR_INK_700,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1 },
            { type: "text", text: "RESERVA", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
          ]
        },
        {
          type: "box", layout: "baseline", spacing: "sm", margin: "md",
          contents: [
            { type: "text", text: iconText, color: COLOR_BRAND_LIGHT, size: "lg", weight: "bold", flex: 0 },
            { type: "text", text: titleText, color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "lg", color: COLOR_TEXT_DARK, wrap: true },
        ...(args.notes ? [{ type: "text", text: args.notes, size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "xs" }] : []),
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: bodyRows },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text",
          text: `พิมพ์ "ยกเลิก #${args.bookingId}" ในแชทนี้เพื่อยกเลิกการจอง`,
          size: "xxs", color: COLOR_TEXT_MUTED, wrap: true, margin: "sm"
        }
      ]
    },
    footer: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "0px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR_BRAND,
          height: "sm",
          action: {
            type: "uri",
            label: "ดูข้อมูลร้าน",
            uri: `${args.publicBaseUrl}/reserva/${args.branchSlug}`
          }
        }
      ]
    },
    styles: {
      header: { backgroundColor: COLOR_INK_700 },
      body: { backgroundColor: "#ffffff" },
      footer: { backgroundColor: "#ffffff", separator: true, separatorColor: COLOR_DIVIDER }
    }
  };

  return {
    type: "flex",
    altText: `${titleText} ${args.branchName} · ${dateStr} ${args.bookingTime}`,
    contents: bubble
  };
}

/** Build a staff-facing Flex card alerting them to a booking. */
export function staffBookingFlex(args: StaffBookingCardArgs): LineFlexMessage {
  const isReminder = args.kind === "reminder";
  const titleText = isReminder ? "ใกล้ถึงเวลาจอง" : "มีการจองใหม่";
  const iconText = isReminder ? "🔔" : "🆕";
  const dateStr = formatThaiDate(args.bookingDate);

  const bodyRows = [
    kvRow("ลูกค้า", args.customerName),
    kvRow("เบอร์โทร", args.customerPhone),
    kvRow("จำนวน", `${args.partySize} ที่นั่ง`),
    kvRow(isReminder ? "เวลา" : "วันที่", isReminder ? args.bookingTime : `${dateStr} ${args.bookingTime}`),
    kvRow("โต๊ะ", args.tableLabel ?? "ยังไม่ได้กำหนด",
      args.tableLabel ? undefined : { valueColor: "#dc2626", valueWeight: "bold" }),
    ...(args.source ? [kvRow("ที่มา", args.source)] : []),
    kvRow("เลขที่จอง", `#${args.bookingId}`, { valueColor: COLOR_BRAND, valueWeight: "bold" })
  ];

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: COLOR_INK_700,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1 },
            { type: "text", text: "RESERVA · STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
          ]
        },
        {
          type: "box", layout: "baseline", spacing: "sm", margin: "md",
          contents: [
            { type: "text", text: iconText, color: COLOR_BRAND_LIGHT, size: "lg", weight: "bold", flex: 0 },
            { type: "text", text: titleText, color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: bodyRows },
        ...(args.notes ? [
          { type: "separator", margin: "md", color: COLOR_DIVIDER },
          { type: "text", text: "หมายเหตุ", size: "xs", color: COLOR_LABEL, margin: "sm" },
          { type: "text", text: args.notes, size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "xs" }
        ] : [])
      ]
    },
    footer: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "0px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR_BRAND,
          height: "sm",
          action: {
            type: "uri",
            label: "เปิดในระบบ",
            uri: `${args.publicBaseUrl}/admin/reserva/bookings`
          }
        }
      ]
    },
    styles: {
      header: { backgroundColor: COLOR_INK_700 },
      body: { backgroundColor: "#ffffff" },
      footer: { backgroundColor: "#ffffff", separator: true, separatorColor: COLOR_DIVIDER }
    }
  };

  return {
    type: "flex",
    altText: `${iconText} ${titleText} · ${args.customerName} · ${args.bookingTime}`,
    contents: bubble
  };
}

/** Resolve the public base URL used to build deep links inside Flex cards.
 *  Reads PUBLIC_BASE_URL env (preferred), falls back to a hardcoded prod
 *  hostname. Used by notifyCustomer / notifyStaff which run in both API
 *  request and cron contexts (cron has no request headers). */
function getPublicBaseUrl(): string {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");  // strip trailing slash
  return "https://ikigaimedihealth.com";
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
 *
 * Channel split:
 *   - The LINE token comes from the PLATFORM OA (IKIGAI OS) — staff-facing
 *     notifications go through one shared OA across all restaurants.
 *   - The branch is only used to source today's lunch-break window + branch
 *     name shown on the card body. (You can still clock in at any branch.)
 *
 * Silent no-op if the platform OA isn't configured yet, or if the staff
 * hasn't bound their LINE userId. Never throws — clock-in must not be
 * blocked or rolled back by a LINE API hiccup.
 */
export async function pushClockInCard(args: {
  userId: number;
  displayName: string;
  branch: Branch;
  platformChannelToken: string;   // from messaging_channels (IKIGAI OS)
  personaUrl: string;             // CTA button target (e.g., '/staff/persona')
  clockInIsoTs: string;
}): Promise<void> {
  const db = getDb();
  const u = db.prepare("SELECT line_user_id FROM users WHERE id = ?").get(args.userId) as
    | { line_user_id: string | null } | undefined;

  if (!u?.line_user_id) return;

  const bkkDate = new Date(new Date(args.clockInIsoTs).getTime() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const hasLunchToday = branchLunchAppliesOn(args.branch, bkkDate);

  const flex = personaClockInFlex({
    displayName: args.displayName,
    clockInIsoTs: args.clockInIsoTs,
    branchName: args.branch.name,
    lunchStart: args.branch.lunch_break_start,
    lunchEnd: args.branch.lunch_break_end,
    hasLunchToday,
    personaUrl: args.personaUrl
  });

  await sendLinePush(args.platformChannelToken, {
    to: u.line_user_id,
    messages: [flex]
  });
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
  const flex = customerBookingFlex({
    branchName: branch.name,
    branchSlug: branch.slug,
    bookingId: booking.id,
    customerName: booking.customer_name,
    partySize: booking.party_size,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    notes: booking.notes,
    publicBaseUrl: getPublicBaseUrl(),
    kind: type
  });
  const res = await sendLinePush(branch.line_channel_token, {
    to: booking.line_user_id,
    messages: [flex]
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
  const flex = staffBookingFlex({
    branchName: branch.name,
    bookingId: booking.id,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    partySize: booking.party_size,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    tableLabel,
    notes: booking.notes,
    source: booking.source,
    publicBaseUrl: getPublicBaseUrl(),
    kind: type
  });
  for (const uid of staffIds) {
    const res = await sendLinePush(branch.line_channel_token, {
      to: uid, messages: [flex]
    });
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "staff", res.ok ? "sent" : "failed", res.error ?? null);
  }
}
