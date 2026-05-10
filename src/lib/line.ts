// LINE Messaging API helper — push messages to customer หรือ staff
// LINE Notify ปิดบริการตั้งแต่ 31 มี.ค. 2025 จึงต้องใช้ Messaging API แทน
// Free tier: 200 push messages/เดือน ต่อ channel (เพียงพอกับ ~120 bookings × 2 reminders)

import { getDb, type Branch, type Booking } from "./db";
import { getChannelByCode } from "./messaging-channels";

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

type Lang = "th" | "en";

function formatThaiDate(yyyymmdd: string): string {
  // Full Thai month names (no abbreviations) so the Flex card reads
  // formally — short forms like "พ.ค." can feel like a quick draft on
  // a customer-facing booking confirmation.
  const [y, m, d] = yyyymmdd.split("-");
  const months = [
    "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
    "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"
  ];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${parseInt(y, 10) + 543}`;
}

function formatEnglishDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${parseInt(y, 10)}`;
}

function localDate(yyyymmdd: string, lang: Lang): string {
  return lang === "en" ? formatEnglishDate(yyyymmdd) : formatThaiDate(yyyymmdd);
}

// Tiny inline i18n for Flex card strings — keeps the dictionary local to the
// file so we don't pull the whole UI translation set just for a few labels.
const FLEX_STRINGS: Record<Lang, Record<string, string>> = {
  th: {
    confirmTitle: "ยืนยันการจองโต๊ะ",
    reminderTitle: "แจ้งเตือนการจองโต๊ะ",
    labelName: "ชื่อผู้จอง",
    labelPartySize: "จำนวน",
    labelDate: "วันที่",
    labelTime: "เวลา",
    labelRef: "เลขที่จอง",
    labelPhone: "เบอร์โทร",
    labelTable: "โต๊ะ",
    labelSource: "ที่มา",
    labelNotes: "หมายเหตุ",
    seatsUnit: "ที่นั่ง",
    tableNotAssigned: "ยังไม่ได้กำหนด",
    btnViewRestaurant: "ดูข้อมูลร้าน",
    btnEditBooking: "ปรับเปลี่ยน / ยกเลิกการจอง",
    btnCancelCall: "ยกเลิกการจอง",
    btnMenu: "เมนูอาหาร",
    btnOpenAdmin: "เข้าสู่ระบบ",
    cancelHint: 'หรือพิมพ์ "ยกเลิก #{ref}" ในแชทนี้เพื่อยกเลิก (ก่อนถึงเวลาจอง 2 ชั่วโมง)',
    qrCaption: "ให้พนักงานสแกนคิวอาร์โค้ดเมื่อถึงร้าน\nเพื่อยืนยันการจอง",
    staffNewBooking: "มีการจองใหม่",
    staffReminder: "ใกล้ถึงเวลาจอง",
    staffPendingReview: "รายการจองผ่านระบบ",
    cancelledTitle: "การจองถูกยกเลิก",
    labelReason: "เหตุผล",
    noReasonGiven: "ทางร้านไม่ได้ระบุเหตุผล — โปรดติดต่อร้านโดยตรง",
    btnCallRestaurant: "ติดต่อเรา",
    noContactPhoneHint: "หากต้องการสอบถามเพิ่มเติม กรุณาติดต่อร้านผ่านแชท LINE นี้"
  },
  en: {
    confirmTitle: "Reservation Confirmed",
    reminderTitle: "Reservation Reminder",
    labelName: "Booked by",
    labelPartySize: "Guests",
    labelDate: "Date",
    labelTime: "Time",
    labelRef: "Booking ref",
    labelPhone: "Phone",
    labelTable: "Table",
    labelSource: "Source",
    labelNotes: "Notes",
    seatsUnit: "guests",
    tableNotAssigned: "not assigned",
    btnViewRestaurant: "View restaurant",
    btnEditBooking: "Modify / cancel booking",
    btnCancelCall: "Cancel booking",
    btnMenu: "Menu",
    btnOpenAdmin: "Sign in",
    cancelHint: 'Or reply "cancel #{ref}" in this chat (up to 2 hours before booking time)',
    qrCaption: "Show this QR to staff on arrival\nto confirm your booking",
    staffNewBooking: "New reservation",
    staffReminder: "Reservation coming up",
    staffPendingReview: "New booking via system",
    cancelledTitle: "Booking cancelled",
    labelReason: "Reason",
    noReasonGiven: "No reason given — please contact the restaurant directly",
    btnCallRestaurant: "Contact us",
    noContactPhoneHint: "For questions, please reply in this LINE chat"
  }
};

function fx(lang: Lang, key: keyof (typeof FLEX_STRINGS)["th"]): string {
  return FLEX_STRINGS[lang][key] ?? FLEX_STRINGS.th[key];
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
  bookingRef: string | null;    // 'R20260500001' — preferred over numeric id when set
  customerName: string;
  partySize: number;
  bookingDate: string;          // YYYY-MM-DD
  bookingTime: string;          // HH:MM
  notes: string | null;
  publicBaseUrl: string;        // e.g., 'https://ikigaimedihealth.com'
  kind: "created" | "reminder";
  lang: Lang;
  /** Restaurant contact phone (branches.contact_phone). Used for the
   *  "ติดต่อเรา" tel: button on the Flex card so customers can call to
   *  modify or cancel a booking. When null, the button is hidden. */
  contactPhone?: string | null;
  /** Optional menu URL — when set, an "เมนูอาหาร / Menu" button is added.
   *  Label is hardcoded per language so it changes when the customer
   *  flips language toggle; admin only configures the link. */
  menuUrl?: string | null;
};

export type StaffBookingCardArgs = {
  branchName: string;
  bookingId: number;
  bookingRef: string | null;    // shown on the card if available
  customerName: string;
  customerPhone: string;
  partySize: number;
  bookingDate: string;          // YYYY-MM-DD
  bookingTime: string;          // HH:MM
  tableLabel: string | null;
  notes: string | null;
  source: string | null;
  publicBaseUrl: string;
  kind: "created" | "reminder" | "pending_review";
  lang: Lang;                   // language for the staff alert (defaults to th in caller)
};

/** Build a public HTTPS URL for a QR-code PNG that encodes the given target.
 *
 * Uses api.qrserver.com (free, no key, HTTPS, generous rate limit). LINE
 * downloads the PNG once and caches it server-side, so a busy restaurant
 * doesn't end up hammering the third-party with every push. We request a
 * 400×400 source so the QR remains crisp when LINE renders it inside the
 * Flex bubble (the actual rendered size is roughly 200 px). Margin 10
 * keeps the quiet zone scannable on phone screens. */
function buildQrUrl(target: string): string {
  const encoded = encodeURIComponent(target);
  return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=${encoded}`;
}

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
  const titleText = isReminder ? fx(args.lang, "reminderTitle") : fx(args.lang, "confirmTitle");
  const iconText = isReminder ? "🔔" : "✓";
  const dateStr = localDate(args.bookingDate, args.lang);

  // Public-facing ref ('R20260500001') is what the customer + staff
  // identify the booking by. Fall back to numeric id only for legacy rows
  // that pre-date the ref_no column (shouldn't happen post-backfill).
  const refDisplay = args.bookingRef ?? String(args.bookingId);
  const bodyRows = [
    kvRow(fx(args.lang, "labelName"), args.customerName),
    kvRow(fx(args.lang, "labelPartySize"), `${args.partySize} ${fx(args.lang, "seatsUnit")}`),
    kvRow(fx(args.lang, "labelDate"), dateStr),
    kvRow(fx(args.lang, "labelTime"), args.bookingTime),
    kvRow(fx(args.lang, "labelRef"), `#${refDisplay}`, { valueColor: COLOR_BRAND, valueWeight: "bold" })
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
        // QR section — staff scan this when the customer arrives. The QR
        // resolves to /r/<ref> which renders a one-tap "mark seated"
        // page. Generated by api.qrserver.com (free HTTPS QR service);
        // LINE caches the image after first download so repeat sends don't
        // hit the third-party every time.
        {
          type: "box", layout: "vertical", spacing: "xs", margin: "md",
          contents: [
            {
              type: "image",
              url: buildQrUrl(`${args.publicBaseUrl}/r/${refDisplay}`),
              aspectRatio: "1:1",
              aspectMode: "fit",
              size: "xxl",
              align: "center"
            },
            {
              type: "text",
              text: fx(args.lang, "qrCaption"),
              size: "xxs", color: COLOR_TEXT_MUTED, wrap: true, align: "center"
            }
          ]
        }
        // The chat-cancel hint ("หรือพิมพ์ ยกเลิก #ref...") was removed
        // — both that path and the URL-edit path proved unreliable in
        // production. Customers cancel by tapping the tel: button in
        // the footer to talk to admin directly.
      ]
    },
    footer: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "0px",
      spacing: "sm",
      contents: [
        // Primary CTA — tap to call the restaurant. Customers who need
        // to modify or cancel just dial in directly. tel: number is
        // stripped of non-digits so dashed/spaced numbers from settings
        // still dial cleanly.
        // Tap to call the restaurant. Label says "ยกเลิกการจอง" because
        // that's the most common reason a customer reaches out after
        // booking — and admin handles the cancellation policy on the
        // call (e.g. the 2-hour-advance rule). Opening the dialer with
        // the contact phone pre-loaded.
        ...(args.contactPhone ? [{
          type: "button",
          style: "primary",
          color: COLOR_BRAND,
          height: "sm",
          action: {
            type: "uri",
            label: fx(args.lang, "btnCancelCall"),
            uri: `tel:${args.contactPhone.replace(/[^\d+]/g, "")}`
          }
        }] : []),
        // Optional menu CTA — admin only configures the URL per branch.
        ...(args.menuUrl ? [{
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "uri",
            label: fx(args.lang, "btnMenu"),
            uri: args.menuUrl
          }
        }] : []),
        // Fallback — when neither phone nor menu is configured, LINE
        // requires footer.contents to be non-empty if footer is set,
        // so we drop in a static info text instead. Tells the customer
        // to reply in this same chat for changes.
        ...(!args.contactPhone && !args.menuUrl ? [{
          type: "text",
          text: fx(args.lang, "noContactPhoneHint"),
          size: "xxs", color: COLOR_TEXT_MUTED, wrap: true, align: "center"
        }] : [])
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

/** Build a customer-facing Flex card announcing the booking was cancelled
 *  by admin. Includes the reason (preset key or admin-typed free text)
 *  and a tel: button so the customer can call the restaurant in one tap.
 *
 *  Skipped silently if the branch has no contact_phone configured AND the
 *  reason is empty — there's nothing meaningful left to show. */
export type CancelledBookingCardArgs = {
  branchName: string;
  bookingRef: string | null;
  bookingId: number;
  bookingDate: string;
  bookingTime: string;
  partySize: number;
  reason: string | null;          // free text or one of the preset reasons
  contactPhone: string | null;    // for the tel: button (null = no button)
  lang: Lang;
};

export function cancelledBookingFlex(args: CancelledBookingCardArgs): LineFlexMessage {
  const dateStr = localDate(args.bookingDate, args.lang);
  const refDisplay = args.bookingRef ?? String(args.bookingId);
  const titleText = fx(args.lang, "cancelledTitle");
  const reasonLabel = fx(args.lang, "labelReason");
  const noReason = fx(args.lang, "noReasonGiven");

  const bodyRows = [
    kvRow(fx(args.lang, "labelDate"), dateStr),
    kvRow(fx(args.lang, "labelTime"), args.bookingTime),
    kvRow(fx(args.lang, "labelPartySize"), `${args.partySize} ${fx(args.lang, "seatsUnit")}`),
    kvRow(fx(args.lang, "labelRef"), `#${refDisplay}`, { valueColor: COLOR_TEXT_MUTED })
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
            { type: "text", text: "✕", color: "#fca5a5", size: "lg", weight: "bold", flex: 0 },
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
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: bodyRows },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // Reason block — emphasized so the customer reads it. Falls back
        // to a polite "no reason given" label if admin cancelled without
        // picking one (preset and free-text both pass through verbatim).
        {
          type: "box", layout: "vertical", spacing: "xs", margin: "md",
          contents: [
            { type: "text", text: reasonLabel, size: "xs", color: COLOR_LABEL },
            {
              type: "text",
              text: args.reason?.trim() || noReason,
              size: "sm", color: COLOR_TEXT_DARK, wrap: true, weight: "bold"
            }
          ]
        }
      ]
    },
    footer: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "0px",
      spacing: "sm",
      contents: args.contactPhone
        ? [
            // tel: URI scheme triggers the dialer on mobile when the user
            // taps the button — works in LINE in-app browser too.
            {
              type: "button",
              style: "primary",
              color: COLOR_BRAND,
              height: "sm",
              action: {
                type: "uri",
                label: `${fx(args.lang, "btnCallRestaurant")} ${args.contactPhone}`,
                uri: `tel:${args.contactPhone.replace(/[^\d+]/g, "")}`
              }
            }
          ]
        : [
            // No phone configured — show a static info text instead of
            // an empty footer (looks cleaner in chat preview).
            {
              type: "text",
              text: fx(args.lang, "noContactPhoneHint"),
              size: "xxs", color: COLOR_TEXT_MUTED, wrap: true, align: "center"
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

/** Push the cancellation Flex card to the customer. Fire-and-forget. */
export async function notifyCustomerCancelled(
  branch: Branch, booking: Booking
): Promise<void> {
  const db = getDb();
  const token = resolveBranchToken(branch);
  if (!token || !booking.line_user_id) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, "cancelled", "customer", "skipped",
      !token ? "no channel token" : "no line_user_id");
    return;
  }
  const lang: Lang = booking.lang === "en" ? "en" : "th";
  const flex = cancelledBookingFlex({
    branchName: branch.name,
    bookingRef: booking.ref_no,
    bookingId: booking.id,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    partySize: booking.party_size,
    reason: booking.cancel_reason,
    contactPhone: branch.contact_phone,
    lang
  });
  const res = await sendLinePush(token, {
    to: booking.line_user_id,
    messages: [flex]
  });
  db.prepare(
    "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
  ).run(booking.id, "cancelled", "customer", res.ok ? "sent" : "failed", res.error ?? null);
}

/** Build a staff-facing Flex card alerting them to a booking. */
export function staffBookingFlex(args: StaffBookingCardArgs): LineFlexMessage {
  const isReminder = args.kind === "reminder";
  const isPending = args.kind === "pending_review";
  const titleText = isReminder
    ? fx(args.lang, "staffReminder")
    : isPending
      ? fx(args.lang, "staffPendingReview")
      : fx(args.lang, "staffNewBooking");
  const iconText = isReminder ? "🔔" : isPending ? "⏳" : "🆕";
  const dateStr = localDate(args.bookingDate, args.lang);

  const bodyRows = [
    kvRow(fx(args.lang, "labelName"), args.customerName),
    kvRow(fx(args.lang, "labelPhone"), args.customerPhone),
    kvRow(fx(args.lang, "labelPartySize"), `${args.partySize} ${fx(args.lang, "seatsUnit")}`),
    kvRow(
      isReminder ? fx(args.lang, "labelTime") : fx(args.lang, "labelDate"),
      isReminder ? args.bookingTime : `${dateStr} ${args.bookingTime}`
    ),
    kvRow(fx(args.lang, "labelTable"), args.tableLabel ?? fx(args.lang, "tableNotAssigned"),
      args.tableLabel ? undefined : { valueColor: "#dc2626", valueWeight: "bold" }),
    ...(args.source ? [kvRow(fx(args.lang, "labelSource"), args.source)] : []),
    kvRow(fx(args.lang, "labelRef"), `#${args.bookingRef ?? args.bookingId}`,
      { valueColor: COLOR_BRAND, valueWeight: "bold" })
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
          { type: "text", text: fx(args.lang, "labelNotes"), size: "xs", color: COLOR_LABEL, margin: "sm" },
          { type: "text", text: args.notes, size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "xs" }
        ] : [])
      ]
    },
    // Footer removed — every variation of the "open admin" / "sign in"
    // button kept failing inside LINE's in-app browser (auth redirect
    // chain doesn't follow through, cookies don't persist, etc.). The
    // notification card body itself has all the info staff needs to
    // glance at; if they want to act, they open the admin URL in their
    // own bookmarked browser. Less surface area, fewer broken paths.
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

/** Resolve the LINE channel token for a branch, preferring messaging_channels
 *  (new) and falling back to the legacy branches.line_channel_token column.
 *  Returns null if neither has a value. */
function resolveBranchToken(branch: Branch): string | null {
  const ch = getChannelByCode(branch.slug);
  if (ch?.channel_token) return ch.channel_token;
  return branch.line_channel_token ?? null;
}

/** Send a plain-text acknowledgement to the customer that their booking
 *  request was received and is awaiting admin confirmation. Used in the
 *  two-step customer flow — no Flex card or QR is sent at this stage,
 *  because the table hasn't been assigned yet. The full Flex card with
 *  QR is pushed later by `notifyCustomer(..., "created")` when admin
 *  clicks "Confirm and notify". */
export async function notifyCustomerPending(
  branch: Branch, booking: Booking
): Promise<void> {
  const db = getDb();
  const token = resolveBranchToken(branch);
  if (!token || !booking.line_user_id) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, "pending_review", "customer", "skipped",
      !token ? "no channel token" : "no line_user_id");
    return;
  }
  const lang: Lang = booking.lang === "en" ? "en" : "th";
  const dateStr = localDate(booking.booking_date, lang);
  const ref = booking.ref_no ?? String(booking.id);
  // Tail line varies by whether admin configured a contact phone for the
  // branch. With phone: customer can call directly. Without: generic.
  const phoneTail = branch.contact_phone
    ? (lang === "en"
        ? `If you don't receive it, please contact ${branch.contact_phone}`
        : `หากไม่ได้รับการยืนยัน กรุณาติดต่อได้ที่หมายเลข ${branch.contact_phone}`)
    : (lang === "en"
        ? "If you don't receive it, please call the restaurant"
        : "หากไม่ได้รับการยืนยัน กรุณาโทรติดต่อร้าน");
  const text = lang === "en"
    ? `Booking request received #${ref}\n${dateStr} ${booking.booking_time} · ${booking.party_size} guests\n\nAdmin will send your booking confirmation via LINE during business hours.\n${phoneTail}`
    : `ได้รับคำขอจอง #${ref}\n${dateStr} ${booking.booking_time} · ${booking.party_size} ที่นั่ง\n\nแอดมินจะส่งข้อความยืนยันการจองให้ทางไลน์ภายในเวลาทำการ\n${phoneTail}`;
  const res = await sendLinePush(token, {
    to: booking.line_user_id,
    messages: [{ type: "text", text }]
  });
  db.prepare(
    "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
  ).run(booking.id, "pending_review", "customer", res.ok ? "sent" : "failed", res.error ?? null);
}

export async function notifyCustomer(
  branch: Branch, booking: Booking, type: "created" | "reminder"
): Promise<void> {
  const db = getDb();
  const token = resolveBranchToken(branch);
  if (!token || !booking.line_user_id) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "customer", "skipped",
      !token ? "no channel token" : "no line_user_id");
    return;
  }
  // Resolve the language to render the card in: customer's selection at
  // booking time (booking.lang), falling back to Thai. The 'en' literal is
  // defensive — anything else stored becomes Thai too.
  const cardLang: Lang = booking.lang === "en" ? "en" : "th";
  const flex = customerBookingFlex({
    branchName: branch.name,
    branchSlug: branch.slug,
    bookingId: booking.id,
    bookingRef: booking.ref_no,
    customerName: booking.customer_name,
    partySize: booking.party_size,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    notes: booking.notes,
    publicBaseUrl: getPublicBaseUrl(),
    kind: type,
    lang: cardLang,
    contactPhone: branch.contact_phone,
    menuUrl: branch.extra_button_url
  });
  const res = await sendLinePush(token, {
    to: booking.line_user_id,
    messages: [flex]
  });
  db.prepare(
    "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
  ).run(booking.id, type, "customer", res.ok ? "sent" : "failed", res.error ?? null);
}

export async function notifyStaff(
  branch: Branch, booking: Booking, tableLabel: string | null,
  type: "created" | "reminder" | "pending_review"
): Promise<void> {
  const db = getDb();
  const token = resolveBranchToken(branch);
  if (!token) return;

  // Staff cards default to Thai (the team's working language). If we add
  // per-staff language preference later we can plumb it through here.
  const flex = staffBookingFlex({
    branchName: branch.name,
    bookingId: booking.id,
    bookingRef: booking.ref_no,
    customerName: booking.customer_name,
    customerPhone: booking.customer_phone,
    partySize: booking.party_size,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    tableLabel,
    notes: booking.notes,
    source: booking.source,
    publicBaseUrl: getPublicBaseUrl(),
    kind: type,
    lang: "th"
  });

  const logSent = (target: string, ok: boolean, err: string | null) => {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "staff", ok ? "sent" : "failed", err ?? `target=${target}`);
  };

  // Preferred path — push once to the staff group. 1 message reaches all
  // members + counts as 1 against the LINE quota regardless of group
  // size, so this scales much better than per-user push.
  if (branch.staff_group_id) {
    const res = await sendLinePush(token, {
      to: branch.staff_group_id,
      messages: [flex]
    });
    logSent("group", res.ok, res.error ?? null);
    return;
  }

  // Fallback — legacy per-user push for branches that haven't moved to
  // the group flow yet. Each user costs 1 push.
  if (!branch.staff_line_user_ids) return;
  let staffIds: string[] = [];
  try {
    staffIds = JSON.parse(branch.staff_line_user_ids);
  } catch {
    return;
  }
  if (staffIds.length === 0) return;
  for (const uid of staffIds) {
    const res = await sendLinePush(token, {
      to: uid, messages: [flex]
    });
    logSent("user", res.ok, res.error ?? null);
  }
}

// ── PERSONA: shift handover Flex cards ────────────────────────────────
//
// One Flex card per submission, pushed to the branch's staff group so
// the team sees "เปิดกะ / ปิดกะ / รายงาน" summaries inline. The card
// just renders the submitted data — no buttons (none of the staff Flex
// buttons have ever worked reliably in LINE in-app browser, and the
// data is glanceable as-is).

export type ShiftOpenCardArgs = {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD
  openerName: string;
  yesterdayClosingAmount: number | null;
  morningDrawerAmount: number | null;
  // Dynamic checklist — labels come straight from admin's configured
  // shift_checklist_items rows. Empty array is valid (no checklist).
  // Each entry has 3 effective states:
  //   - checked: true              → done ✓
  //   - checked: false, note: set  → skipped-on-purpose 📝 (with reason)
  //   - checked: false, note: null → not done ✗ (red flag)
  checklist: Array<{ label: string; checked: boolean; note: string | null }>;
};

export function shiftOpenFlex(args: ShiftOpenCardArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const fmtBaht = (n: number | null) =>
    n == null ? "—" : `${n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} บาท`;

  const checklistRows = args.checklist;
  const hasChecklist = checklistRows.length > 0;
  // Bucket each row into one of 3 states. "incomplete" only counts
  // rows that are neither done nor skipped-with-reason — those are
  // the ones admin needs to chase. Skipped-with-note rows are
  // shown distinctly so the note can be read inline.
  const doneCount = checklistRows.filter((it) => it.checked).length;
  const skippedCount = checklistRows.filter((it) => !it.checked && !!it.note?.trim()).length;
  const incompleteCount = checklistRows.filter((it) => !it.checked && !it.note?.trim()).length;
  const allDone = hasChecklist && doneCount === checklistRows.length;

  // Summary line — color + wording shifts based on which buckets are
  // non-zero. "All done" wins, then "incomplete > 0" (red flag),
  // otherwise it's just skipped-with-notes (amber, informational).
  const summary = allDone
    ? { text: "✓ เช็คลิสต์ครบทุกข้อ", color: "#059669" }
    : incompleteCount > 0
      ? {
          text: skippedCount > 0
            ? `⚠ ยังไม่ได้ทำ ${incompleteCount} ข้อ · ข้ามวันนี้ ${skippedCount} ข้อ — กรุณาตรวจสอบ`
            : `⚠ มี ${incompleteCount} ข้อยังไม่เสร็จ — กรุณาตรวจสอบ`,
          color: "#dc2626"
        }
      : {
          text: `ทำแล้ว ${doneCount} ข้อ · ข้ามวันนี้ ${skippedCount} ข้อ (มีหมายเหตุ)`,
          color: "#b45309"
        };

  // Single checklist row — a horizontal box with the status icon at
  // flex:0 and the label at flex:1 with wrap:true. Long Thai labels
  // wrap to multi-line cleanly without LINE truncating with "..."
  // (which the previous "${icon} ${label}" single-text approach did
  // on narrower devices).
  const checklistItemBox = (it: { label: string; checked: boolean; note: string | null }) => {
    const note = it.note?.trim();
    const skipped = !it.checked && !!note;
    const icon = it.checked ? "✓" : skipped ? "📝" : "✗";
    const iconColor = it.checked ? "#059669" : skipped ? "#b45309" : "#dc2626";
    const labelColor = it.checked ? COLOR_TEXT_DARK : skipped ? "#475569" : "#dc2626";
    const rowBox: Record<string, unknown> = {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        {
          type: "text", text: icon,
          flex: 0, size: "sm", weight: "bold",
          color: iconColor
        },
        {
          type: "text", text: it.label,
          flex: 1, size: "xs", wrap: true,
          color: labelColor,
          weight: it.checked ? "regular" : "bold"
        }
      ]
    };
    if (skipped && note) {
      // Wrap row + note vertically so the note hangs under the label
      // and doesn't fight the icon column for horizontal space.
      return {
        type: "box", layout: "vertical", spacing: "xs",
        contents: [
          rowBox,
          {
            type: "text",
            text: `↳ ${note}`,
            size: "xxs",
            color: "#b45309",
            wrap: true,
            margin: "none"
          }
        ]
      };
    }
    return rowBox;
  };

  const bubble = {
    // "mega" gives the body extra horizontal room so long Thai
    // checklist labels wrap to fewer lines. "kilo" was tight on
    // narrow phones and contributed to the truncation issue.
    type: "bubble",
    size: "mega",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: COLOR_INK_700,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA · เปิดกะ", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "เช็คลิสต์เปิดกะ", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "box", layout: "vertical", spacing: "sm", margin: "md",
          contents: [
            kvRow("ผู้เปิดกะ", args.openerName),
            kvRow("ยอดปิดกะเมื่อวาน", fmtBaht(args.yesterdayClosingAmount)),
            kvRow("ยอดเปิดกะเช้านี้", fmtBaht(args.morningDrawerAmount),
              { valueColor: COLOR_BRAND, valueWeight: "bold" })
          ]
        },
        ...(hasChecklist ? [
          { type: "separator", margin: "md", color: COLOR_DIVIDER },
          {
            type: "text",
            text: summary.text,
            size: "xs",
            color: summary.color,
            weight: "bold",
            margin: "md",
            wrap: true
          },
          {
            type: "box", layout: "vertical", spacing: "sm", margin: "sm",
            contents: checklistRows.map(checklistItemBox)
          }
        ] : [])
      ]
    },
    styles: {
      header: { backgroundColor: COLOR_INK_700 },
      body: { backgroundColor: "#ffffff" }
    }
  };

  return {
    type: "flex",
    altText: `เช็คลิสต์เปิดกะ ${args.branchName} · ${dateStr} · ${args.openerName}`,
    contents: bubble
  };
}

/** Push a daily report Flex card to the branch's staff group / fallback
 *  user IDs. Mirrors notifyStaff() — group preferred, per-user as
 *  legacy fallback. Fire-and-forget; no logging table for daily reports
 *  (the row in daily_reports already records the submission). */
export async function notifyDailyReport(
  branch: Branch, flex: LineFlexMessage
): Promise<void> {
  const token = resolveBranchToken(branch);
  if (!token) return;
  if (branch.staff_group_id) {
    await sendLinePush(token, {
      to: branch.staff_group_id,
      messages: [flex]
    });
    return;
  }
  if (!branch.staff_line_user_ids) return;
  let staffIds: string[] = [];
  try { staffIds = JSON.parse(branch.staff_line_user_ids); } catch { return; }
  for (const uid of staffIds) {
    await sendLinePush(token, { to: uid, messages: [flex] });
  }
}
