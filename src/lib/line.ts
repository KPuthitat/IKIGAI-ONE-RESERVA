// LINE Messaging API helper — push messages to customer หรือ staff
// LINE Notify ปิดบริการตั้งแต่ 31 มี.ค. 2025 จึงต้องใช้ Messaging API แทน
// Free tier: 200 push messages/เดือน ต่อ channel (เพียงพอกับ ~120 bookings × 2 reminders)

import {
  getDb,
  getSystemSettings,
  type Branch,
  type Booking,
  type BookingOccasion,
  type AttendanceRow
} from "./db";
import { getChannelByCode, getPlatformChannel } from "./messaging-channels";
import { decryptSecret } from "./secret-vault";
import { nameWithPrefix } from "./name";

// LINE message kinds we use. Loose typing is intentional — Flex contents are
// large JSON blobs and the API spec already documents the shape.
type LineTextMessage = { type: "text"; text: string };
type LineFlexMessage = { type: "flex"; altText: string; contents: unknown };
export type LineMessage = LineTextMessage | LineFlexMessage;

type LinePushPayload = {
  to: string;
  messages: LineMessage[];
};

export async function sendLinePush(
  channelToken: string,
  payload: LinePushPayload
): Promise<{ ok: boolean; status: number; error?: string }> {
  // Dev safety guard: local dev runs against a copy of the prod DB, which
  // carries REAL production LINE channel tokens and ~15 employees bound by
  // line_user_id. Without this, any dev code path that reaches a push (cron
  // digests, booking/leave/OT/discipline/recruita notifications, etc.) would
  // message real people from localhost. Skip the real API call outside
  // production unless the dev explicitly opts in with LINE_DEV_SEND=1.
  if (process.env.NODE_ENV !== "production" && process.env.LINE_DEV_SEND !== "1") {
    console.warn(
      `[line] DEV GUARD — skipped LINE push to ${payload.to} ` +
        `(${payload.messages.length} msg). Set LINE_DEV_SEND=1 in .env to send for real.`
    );
    return { ok: true, status: 200 };
  }
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
      // Translate the most common LINE failure (monthly free-tier
      // quota exhaustion, HTTP 429) into a stable error code admin
      // UIs can recognise. The raw LINE response is "monthly limit"
      // text that looks like a system bug to non-technical owners —
      // surfacing a tagged code lets us show humanised copy + a
      // direct link to the LINE OA Manager instead.
      if (res.status === 429 && /monthly limit/i.test(text)) {
        return {
          ok: false,
          status: 429,
          error: "monthly_quota_exceeded"
        };
      }
      return { ok: false, status: res.status, error: text };
    }
    return { ok: true, status: res.status };
  } catch (e: unknown) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// Reply to a webhook event using its replyToken. Reply messages are FREE — they
// do NOT count against the LINE OA monthly push quota (owner 2026-06-30: bill
// cards stopped after the push quota ran out). Token is single-use + short-lived
// (~1 min), so use it promptly and fall back to push if it fails/expires.
export async function sendLineReply(
  channelToken: string,
  replyToken: string,
  messages: LineMessage[]
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (process.env.NODE_ENV !== "production" && process.env.LINE_DEV_SEND !== "1") {
    console.warn(`[line] DEV GUARD — skipped LINE reply (${messages.length} msg). Set LINE_DEV_SEND=1 to send for real.`);
    return { ok: true, status: 200 };
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${channelToken}` },
      body: JSON.stringify({ replyToken, messages })
    });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return { ok: true, status: res.status };
  } catch (e: unknown) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// Show LINE's built-in loading animation in a 1:1 chat (the "…" dots) while the
// bot is busy — FREE, doesn't count as a message. Lets a slow step (bill OCR)
// feel responsive (owner 2026-06-30: "อ่านนานมาก"). 1:1 only; best-effort.
export async function showLineLoading(
  channelToken: string,
  chatId: string,
  seconds = 20
): Promise<void> {
  if (process.env.NODE_ENV !== "production" && process.env.LINE_DEV_SEND !== "1") return;
  // loadingSeconds must be 5–60 in steps of 5.
  const loadingSeconds = Math.min(60, Math.max(5, Math.round(seconds / 5) * 5));
  try {
    await fetch("https://api.line.me/v2/bot/chat/loading", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${channelToken}` },
      body: JSON.stringify({ chatId, loadingSeconds })
    });
  } catch { /* best-effort — never block the bill flow on the spinner */ }
}

/** Download a message's binary content (image/file) from LINE's data API.
 *  Used by the ACCOUNTA bill-ingest webhook to pull a bill photo a staff
 *  member sent to the OA. Returns bytes + mime, or null on any failure.
 *  This is a GET (not a push) so it is NOT gated by the LINE_DEV_SEND guard;
 *  in dev there are no real signed webhooks to trigger it anyway. */
export async function downloadLineContent(
  channelToken: string,
  messageId: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const res = await fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      { headers: { Authorization: `Bearer ${channelToken}` } }
    );
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim() || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) return null;
    return { buffer, mime };
  } catch {
    return null;
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
    labelFoodAllergy: "อาหารที่แพ้",
    seatsUnit: "ที่นั่ง",
    tableNotAssigned: "ยังไม่ได้กำหนด",
    btnViewRestaurant: "ดูข้อมูลร้าน",
    btnEditBooking: "ปรับเปลี่ยน / ยกเลิกการจอง",
    btnCancelCall: "ยกเลิกการจอง",
    btnMenu: "เมนูอาหาร",
    btnOpenAdmin: "เข้าสู่ระบบ",
    cancelHint: 'หรือพิมพ์ "ยกเลิก #{ref}" ในแชทนี้เพื่อยกเลิก (ก่อนถึงเวลาจอง 2 ชั่วโมง)',
    qrCaption: "ให้พนักงานสแกนคิวอาร์โค้ดเมื่อถึงร้าน\nเพื่อยืนยันการจอง",
    redemptionCodeLabel: "รหัสยืนยัน",
    redemptionEligibleTitle: "ลูกค้าใหม่รับฟรี! ไอติม 1 ลูก",
    redemptionEligibleHint: "ยื่นรหัสนี้ให้พนักงานที่ร้านภายใน 6 ชั่วโมงหลังเวลาที่จอง",
    redemptionClaimedTitle: "รับไอติมแล้ว ขอบคุณที่มาทาน",
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
    labelFoodAllergy: "Food allergy",
    seatsUnit: "guests",
    tableNotAssigned: "not assigned",
    btnViewRestaurant: "View restaurant",
    btnEditBooking: "Modify / cancel booking",
    btnCancelCall: "Cancel booking",
    btnMenu: "Menu",
    btnOpenAdmin: "Sign in",
    cancelHint: 'Or reply "cancel #{ref}" in this chat (up to 2 hours before booking time)',
    qrCaption: "Show this QR to staff on arrival\nto confirm your booking",
    redemptionCodeLabel: "Verification code",
    redemptionEligibleTitle: "New customer perk — 1 free ice cream",
    redemptionEligibleHint: "Show this code to staff within 6 hours of your booking time",
    redemptionClaimedTitle: "Ice cream claimed — thanks for visiting!",
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
  /** Optional branch CI hex for the header background. */
  headerColor?: string | null;
};

// IKIGAI OS CI palette — keep in sync with tailwind.config.ts
const COLOR_INK_900 = "#4e351f";
const COLOR_INK_700 = "#281a0e";
const COLOR_BRAND = "#a06820";
const COLOR_BRAND_LIGHT = "#d6a14d";
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

  const headerColor = args.headerColor || COLOR_INK_700;

  const bubble = {
    type: "bubble",
    size: "giga",
    // ── Header: branch CI colour (falls back to ink navy) with
    // IKIGAI OS / PERSONA branding bar ──
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
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
      header: { backgroundColor: headerColor },
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

// ── ACCOUNTA: bill verify card (owner 2026-06-27) ───────────────────
// On a LINE bill upload, OCR now only matches the 13-digit tax id (→ผู้จำหน่าย
// from the master) and reads the ยอด. This card asks the sender to eyeball
// those two fields and tap ถูกต้อง / ไม่ตรง — the answer is recorded on the
// draft for the admin. Nothing is committed to the ledger from this card.

export type AccountaBillVerifyArgs = {
  expenseId: number;           // draft id the postback buttons act on
  senderName: string;          // already prefixed staff name
  vendorName: string | null;   // matched master vendor (null = ไม่พบ → รอแอดมิน)
  amount: number | null;       // OCR'd ยอดรวม (null = อ่านไม่ออก)
  billDate: string | null;     // YYYY-MM-DD or null
  taxId?: string | null;       // 13-digit เลขผู้เสียภาษี OCR read (optional)
  formUrl?: string | null;     // tokenised link to the detail form (optional)
};

export function accountaBillVerifyFlex(args: AccountaBillVerifyArgs): LineFlexMessage {
  const baht = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label: string, value: string, strong?: boolean, muted?: boolean) => ({
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: COLOR_LABEL, flex: 4, wrap: true },
      {
        type: "text", text: value, size: "sm",
        color: muted ? COLOR_TEXT_MUTED : strong ? COLOR_BRAND : COLOR_TEXT_DARK,
        weight: "bold", flex: 6, align: "end", wrap: true
      }
    ]
  });

  const rows: unknown[] = [
    row("ผู้จำหน่าย", args.vendorName ?? "— ไม่พบ (รอแอดมินระบุ) —", false, args.vendorName == null),
    row("ยอดรวม", args.amount != null ? `${baht(args.amount)} บาท` : "— อ่านไม่ออก —", true)
  ];
  if (args.billDate) rows.push(row("วันที่บิล", args.billDate));
  if (args.taxId) rows.push(row("เลขผู้เสียภาษี", args.taxId));

  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical", backgroundColor: COLOR_INK_700, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1 },
            { type: "text", text: "ACCOUNTA", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
          ]
        },
        {
          type: "box", layout: "baseline", spacing: "sm", margin: "md",
          contents: [
            { type: "text", text: "?", color: COLOR_BRAND_LIGHT, size: "lg", weight: "bold", flex: 0 },
            { type: "text", text: "ตรวจสอบบิล", color: "#ffffff", size: "lg", weight: "bold" }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        { type: "text", text: args.senderName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: rows },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text",
          text: args.formUrl
            ? "กด“กรอก/แก้ไขรายละเอียด” เพื่อเลือกประเภทเอกสาร + ใส่ยอด/ภาษี แล้วส่งให้แอดมินตรวจ"
            : "ผู้จำหน่ายกับยอดตรงกับบิลไหมครับ?",
          size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "sm"
        }
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
      contents: [
        ...(args.formUrl ? [{
          type: "button", style: "primary", height: "sm", color: COLOR_BRAND,
          action: { type: "uri", label: "กรอก/แก้ไขรายละเอียด", uri: args.formUrl }
        }] : []),
        {
          type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            {
              type: "button", style: "secondary", height: "sm", flex: 1,
              action: { type: "postback", label: "ไม่ตรง", data: `acct_bill_fix=${args.expenseId}`, displayText: "บิลนี้ไม่ตรง" }
            },
            {
              type: "button", style: args.formUrl ? "secondary" : "primary", height: "sm", flex: 1, ...(args.formUrl ? {} : { color: COLOR_BRAND }),
              action: { type: "postback", label: "ถูกต้อง", data: `acct_bill_ok=${args.expenseId}`, displayText: "ยืนยันว่าถูกต้อง" }
            }
          ]
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
    altText: args.amount != null ? `ตรวจสอบบิล · ${baht(args.amount)} บาท` : "ตรวจสอบบิล (รอตรวจ)",
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
  /** Optional header background hex — branch CI shows on the card
   *  customers see in their LINE chat. Falls back to default ink. */
  headerColor?: string | null;
  /** 6-char verification code printed below the QR so the customer
   *  can read it aloud if scanning fails. Null = legacy row that
   *  pre-dates the verification feature. */
  verificationCode?: string | null;
  /** Free-ice-cream redemption state. When 'eligible' a small banner
   *  appears under the QR with the perk description. When 'claimed'
   *  / 'expired' the banner reflects that. NULL = legacy row. */
  redemptionStatus?: "eligible" | "claimed" | "expired" | "not_eligible" | null;
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
  // Food allergies / dietary restrictions. Rendered with a stronger
  // visual treatment (rose accent + 🍽️) so staff catches it ahead of
  // serving — even when notes is empty. Null = no allergy info given.
  foodAllergy: string | null;
  source: string | null;
  /** Special occasion the customer flagged on the booking form. Drives
   *  a prominent badge on the staff card so the team can prepare (e.g.
   *  birthday plate, quiet table for a business meeting). Null = no
   *  occasion was specified. */
  occasion: BookingOccasion | null;
  publicBaseUrl: string;
  kind: "created" | "reminder" | "pending_review";
  lang: Lang;                   // language for the staff alert (defaults to th in caller)
  /** See CustomerBookingCardArgs headerColor. */
  headerColor?: string | null;
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
      // wrap:true on the label too — without it, long Thai labels like
      // "ยอดปิดกะเมื่อวาน" got truncated to "ยอดปิดกะเมื..." on
      // narrower devices because the column width is fixed by flex
      // weights regardless of value length.
      { type: "text", text: label, size: "sm", color: COLOR_LABEL, flex: 4, wrap: true },
      {
        type: "text", text: value, size: "sm",
        color: opts?.valueColor ?? COLOR_TEXT_DARK,
        weight: opts?.valueWeight ?? "bold",
        flex: 6, align: "end", wrap: true
      }
    ]
  };
}

/** Localised display label + emoji for a booking occasion. Shared by
 *  the staff Flex card and any future customer-facing reference. Falls
 *  back to a generic "special occasion" line if the enum drifts and we
 *  see a value we don't recognise — keeps the card from breaking. */
function occasionDisplay(
  occasion: BookingOccasion,
  lang: Lang
): { emoji: string; label: string } {
  const TH: Record<BookingOccasion, { emoji: string; label: string }> = {
    birthday:    { emoji: "🎂", label: "วันเกิด" },
    anniversary: { emoji: "💑", label: "วันครบรอบ" },
    business:    { emoji: "🤝", label: "ประชุมงาน" },
    date:        { emoji: "💕", label: "เดท" },
    family:      { emoji: "👨‍👩‍👧", label: "รวมครอบครัว" },
    friends:     { emoji: "🍽", label: "พบเพื่อน" },
    celebration: { emoji: "✨", label: "ฉลองโอกาสพิเศษ" },
    other:       { emoji: "✨", label: "โอกาสพิเศษ" }
  };
  const EN: Record<BookingOccasion, { emoji: string; label: string }> = {
    birthday:    { emoji: "🎂", label: "Birthday" },
    anniversary: { emoji: "💑", label: "Anniversary" },
    business:    { emoji: "🤝", label: "Business meeting" },
    date:        { emoji: "💕", label: "Date" },
    family:      { emoji: "👨‍👩‍👧", label: "Family gathering" },
    friends:     { emoji: "🍽", label: "Friends gathering" },
    celebration: { emoji: "✨", label: "Celebration" },
    other:       { emoji: "✨", label: "Special occasion" }
  };
  return (lang === "en" ? EN : TH)[occasion]
    ?? { emoji: "✨", label: lang === "en" ? "Special occasion" : "โอกาสพิเศษ" };
}

/** Build the Flex sub-block that surfaces the customer's occasion on
 *  the staff card. Amber accent (warm, not alarming) — distinct from
 *  the rose-red allergy block so staff don't confuse "prepare cake"
 *  with "watch out, allergy". Returns an array of Flex blocks so the
 *  caller can `...spread` it conditionally; empty array = no occasion. */
function occasionStaffBlock(
  occasion: BookingOccasion,
  lang: Lang
): Record<string, unknown>[] {
  const d = occasionDisplay(occasion, lang);
  return [
    { type: "separator", margin: "md", color: "#fde68a" },
    {
      type: "text",
      text: `${d.emoji} ${lang === "en" ? "Special occasion" : "โอกาสพิเศษ"}`,
      size: "xs", color: "#b45309", weight: "bold", margin: "sm"
    },
    {
      type: "text",
      text: d.label,
      size: "sm", color: "#78350f", weight: "bold", wrap: true, margin: "xs"
    }
  ];
}

/** Build a customer-facing Flex card for a new / upcoming booking. */
export function customerBookingFlex(args: CustomerBookingCardArgs): LineFlexMessage {
  const isReminder = args.kind === "reminder";
  const titleText = isReminder ? fx(args.lang, "reminderTitle") : fx(args.lang, "confirmTitle");
  const iconText = isReminder ? "🔔" : "✓";
  const dateStr = localDate(args.bookingDate, args.lang);
  const headerColor = args.headerColor || COLOR_INK_700;

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
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
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
            },
            // Verification code — printed in large monospaced-ish text
            // so the customer can read it aloud if scanning fails. Both
            // sides (customer Flex + staff /r page) show the same string
            // so staff visually confirms a match before approving.
            ...(args.verificationCode ? [
              { type: "separator", margin: "md", color: COLOR_DIVIDER },
              {
                type: "text",
                text: fx(args.lang, "redemptionCodeLabel"),
                size: "xxs", color: COLOR_LABEL, align: "center", margin: "md"
              },
              {
                type: "text",
                text: args.verificationCode,
                size: "xxl", color: COLOR_TEXT_DARK, align: "center",
                weight: "bold", margin: "xs"
              }
            ] : []),
            // Free-ice-cream banner — only shown for first-time
            // customers (status 'eligible'). 'claimed' shows a thank-
            // you stub; 'expired' / 'not_eligible' show nothing so we
            // don't dangle a perk the customer can't redeem.
            ...(args.redemptionStatus === "eligible" ? [
              {
                type: "box", layout: "vertical", spacing: "xs",
                margin: "md", paddingAll: "12px",
                backgroundColor: "#fff7ed", cornerRadius: "8px",
                borderWidth: "1px", borderColor: "#fdba74",
                contents: [
                  {
                    type: "text",
                    text: fx(args.lang, "redemptionEligibleTitle"),
                    size: "sm", color: "#9a3412", weight: "bold",
                    wrap: true, align: "center"
                  },
                  {
                    type: "text",
                    text: fx(args.lang, "redemptionEligibleHint"),
                    size: "xxs", color: "#9a3412", wrap: true,
                    align: "center", margin: "xs"
                  }
                ]
              }
            ] : []),
            ...(args.redemptionStatus === "claimed" ? [
              {
                type: "box", layout: "vertical",
                margin: "md", paddingAll: "12px",
                backgroundColor: "#ecfdf5", cornerRadius: "8px",
                borderWidth: "1px", borderColor: "#86efac",
                contents: [
                  {
                    type: "text",
                    text: fx(args.lang, "redemptionClaimedTitle"),
                    size: "sm", color: "#065f46", weight: "bold",
                    wrap: true, align: "center"
                  }
                ]
              }
            ] : [])
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
      header: { backgroundColor: headerColor },
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
  /** Optional branch CI hex for the header background. */
  headerColor?: string | null;
};

export function cancelledBookingFlex(args: CancelledBookingCardArgs): LineFlexMessage {
  const dateStr = localDate(args.bookingDate, args.lang);
  const refDisplay = args.bookingRef ?? String(args.bookingId);
  const titleText = fx(args.lang, "cancelledTitle");
  const reasonLabel = fx(args.lang, "labelReason");
  const noReason = fx(args.lang, "noReasonGiven");
  const headerColor = args.headerColor || COLOR_INK_700;

  const bodyRows = [
    kvRow(fx(args.lang, "labelDate"), dateStr),
    kvRow(fx(args.lang, "labelTime"), args.bookingTime),
    kvRow(fx(args.lang, "labelPartySize"), `${args.partySize} ${fx(args.lang, "seatsUnit")}`),
    kvRow(fx(args.lang, "labelRef"), `#${refDisplay}`, { valueColor: COLOR_TEXT_MUTED })
  ];

  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
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
      header: { backgroundColor: headerColor },
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
    lang,
    headerColor: branch.brand_color
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
  const headerColor = args.headerColor || COLOR_INK_700;

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
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
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
        // Occasion badge — placed BEFORE food allergy so staff see the
        // celebration cue first (it changes how they prep the table)
        // while the allergy block still wins on serving-time attention
        // via its rose-red treatment. Null occasion = block omitted.
        ...(args.occasion ? occasionStaffBlock(args.occasion, args.lang) : []),
        ...(args.foodAllergy ? [
          { type: "separator", margin: "md", color: "#fecdd3" },
          {
            type: "text",
            text: `🍽️ ${fx(args.lang, "labelFoodAllergy")}`,
            size: "xs", color: "#b91c1c", weight: "bold", margin: "sm"
          },
          {
            type: "text",
            text: args.foodAllergy,
            size: "sm", color: "#7f1d1d", weight: "bold", wrap: true, margin: "xs"
          }
        ] : []),
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
      header: { backgroundColor: headerColor },
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
}): Promise<{ ok: boolean; status: number; error?: string; skipped?: "no_line_user_id" }> {
  // Return shape: same as sendLinePush() with an extra `skipped`
  // discriminator when we deliberately skip (no userId bound). Auto-
  // flow at clock-in time does fire-and-forget so it ignores this
  // return; the admin resend endpoint inspects it to give the user
  // a real success/failure toast.
  const db = getDb();
  const u = db.prepare("SELECT line_user_id FROM users WHERE id = ?").get(args.userId) as
    | { line_user_id: string | null } | undefined;

  if (!u?.line_user_id) {
    return { ok: false, status: 0, skipped: "no_line_user_id" };
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
    hasLunchToday,
    personaUrl: args.personaUrl
  });

  return sendLinePush(args.platformChannelToken, {
    to: u.line_user_id,
    messages: [flex]
  });
}

/** Resolve the LINE channel token for a branch, preferring messaging_channels
 *  (new) and falling back to the legacy branches.line_channel_token column.
 *  Returns null if neither has a value. messaging_channels rows are
 *  decrypted automatically; the legacy column is run through
 *  decryptSecret too so values written after the 2026-05 vault rollout
 *  also work. */
function resolveBranchToken(branch: Branch): string | null {
  const ch = getChannelByCode(branch.slug);
  if (ch?.channel_token) return ch.channel_token;
  return decryptSecret(branch.line_channel_token) ?? null;
}

/** Personalised reply per occasion — bilingual.
 *
 *  Returned text is appended as a SECOND text bubble after the generic
 *  "request received" message. Two bubbles instead of one big text body
 *  on purpose: LINE renders each text message as its own chat bubble,
 *  so the occasion message reads like a warm follow-up rather than
 *  admin boilerplate (peak-end rule — last bubble shapes the memory of
 *  the booking touch).
 *
 *  Templates are hand-crafted, hardcoded, and intentionally generic
 *  across the two brand restaurants (NAMA PASTA / HYPOPLARAEMIA) so we
 *  don't tie copy to a specific tone yet. When you want per-branch
 *  customization, add a JSON `occasion_messages` column on branches and
 *  fall back here when the row's missing. Keep these defaults around
 *  as the always-safe fallback — empty branch config still gets warm
 *  copy.
 *
 *  Returns null when occasion is null/unknown so callers can skip the
 *  extra message entirely (don't send "no special occasion" text — it
 *  would feel robotic). */
function occasionReplyText(
  occasion: BookingOccasion | null | undefined,
  lang: Lang
): string | null {
  if (!occasion) return null;
  const TH: Record<BookingOccasion, string> = {
    birthday:
      "🎂 ขอบคุณที่เลือกเรามาฉลองวันเกิด — ทีมงานจะเตรียมต้อนรับอย่างพิเศษ ถ้ามีรายละเอียดเพิ่ม (ชื่อบนเค้ก, รสที่ไม่ทาน, ของเซอร์ไพรส์) ตอบกลับมาได้เลยครับ",
    anniversary:
      "💑 ขอบคุณที่เลือกเป็นพื้นที่ของช่วงเวลาสำคัญ — เราจะจัดโต๊ะในมุมที่อบอุ่นและเป็นส่วนตัวให้ บอกได้เลยถ้าต้องการให้พิเศษกว่านี้",
    business:
      "🤝 รับทราบครับ — เราจะจัดโต๊ะในมุมที่คุยงานสะดวก เสียงรบกวนน้อย และพร้อมเสิร์ฟตรงเวลา ถ้ามีลูกค้าหรือพาร์ทเนอร์มาด้วย แจ้งจำนวนล่วงหน้าได้",
    date:
      "💕 ขอบคุณที่เลือกเรา — เราจะจัดบรรยากาศที่ผ่อนคลายและเป็นส่วนตัวไว้ให้ ถ้าต้องการเซอร์ไพรส์ใดเป็นพิเศษ ส่งข้อความบอกได้เลยครับ",
    family:
      "👨‍👩‍👧 ขอบคุณที่เลือกเรารวมครอบครัว — เราจะจัดโต๊ะที่นั่งสบาย คุยกันสะดวก เสิร์ฟพร้อมกันให้ครบทุกคน",
    friends:
      "🍽 ดีใจที่ได้เป็นพื้นที่นัดเจอกันของคุณ — เราจะจัดโต๊ะให้พร้อมพูดคุย อาหารเสิร์ฟพร้อมกันให้ครบทุกที่นั่ง",
    celebration:
      "✨ ขอบคุณที่เลือกเรามาฉลอง — บอกทีมงานได้เลยถ้าต้องการให้เตรียมเซอร์ไพรส์ใดเป็นพิเศษ",
    other:
      "✨ ขอบคุณที่เลือกเราในโอกาสพิเศษนี้ — ถ้ามีรายละเอียดที่ต้องการให้เตรียม บอกทีมงานได้เสมอครับ"
  };
  const EN: Record<BookingOccasion, string> = {
    birthday:
      "🎂 Thank you for choosing us to celebrate the birthday — we'll prepare a warm welcome. Reply with any details (name on cake, food preferences, surprises you'd like) and we'll take care of it.",
    anniversary:
      "💑 Thank you for letting us be part of this important moment — we'll arrange a warm and private corner for you. Let us know if you'd like us to make it even more special.",
    business:
      "🤝 Noted — we'll set up a quieter table that's good for conversation, with on-time service. Feel free to share the number of guests or partners joining in advance.",
    date:
      "💕 Thank you for choosing us — we'll have a relaxed, private setting ready. If you'd like us to prepare any specific surprise, just message us.",
    family:
      "👨‍👩‍👧 Thank you for choosing us for your family gathering — we'll set up a comfortable table where everyone can chat and be served together.",
    friends:
      "🍽 Glad to be your meet-up spot — we'll set the table for easy conversation and serve everyone at the same time.",
    celebration:
      "✨ Thank you for celebrating with us — let us know if there's a particular surprise we can prepare.",
    other:
      "✨ Thank you for choosing us for this special occasion — feel free to tell us any details you'd like us to prepare."
  };
  return (lang === "en" ? EN : TH)[occasion];
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
  // Per-branch audience toggle — admin can mute this kind from settings.
  if (!branch.notify_customer_pending) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, "pending_review", "customer", "skipped", "pref_off");
    return;
  }
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
  // Append occasion-specific warm follow-up as a second bubble when
  // customer picked one. Two bubbles read as personal — one big merged
  // text body would look like admin boilerplate.
  const messages: LineMessage[] = [{ type: "text", text }];
  const occasionText = occasionReplyText(booking.occasion, lang);
  if (occasionText) {
    messages.push({ type: "text", text: occasionText });
  }
  const res = await sendLinePush(token, {
    to: booking.line_user_id,
    messages
  });
  db.prepare(
    "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
  ).run(booking.id, "pending_review", "customer", res.ok ? "sent" : "failed", res.error ?? null);
}

export async function notifyCustomer(
  branch: Branch, booking: Booking, type: "created" | "reminder"
): Promise<void> {
  const db = getDb();
  // Per-branch audience toggle — admin can mute reminder / created
  // independently from the messaging settings card.
  const prefOn = type === "reminder"
    ? !!branch.notify_customer_reminder
    : !!branch.notify_customer_created;
  if (!prefOn) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "customer", "skipped", "pref_off");
    return;
  }
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
    menuUrl: branch.extra_button_url,
    headerColor: branch.brand_color,
    verificationCode: booking.verification_code,
    redemptionStatus: booking.redemption_status
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
  // Per-branch audience toggle — admin can mute any of the three staff
  // kinds independently. staff_reminder defaults OFF (set in schema) so
  // existing branches stop getting time-to-arrive group spam without
  // any extra opt-in.
  const prefOn =
    type === "reminder" ? !!branch.notify_staff_reminder :
    type === "pending_review" ? !!branch.notify_staff_pending :
    !!branch.notify_staff_created;
  if (!prefOn) {
    db.prepare(
      "INSERT INTO notification_log (booking_id, type, audience, status, error) VALUES (?,?,?,?,?)"
    ).run(booking.id, type, "staff", "skipped", "pref_off");
    return;
  }
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
    foodAllergy: booking.food_allergy,
    source: booking.source,
    occasion: booking.occasion,
    publicBaseUrl: getPublicBaseUrl(),
    kind: type,
    lang: "th",
    headerColor: branch.brand_color
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
  // Optional is_child + description fields propagate from admin rows.
  // kind='section' rows render as non-interactive group headers; the
  // Flex layer skips them from the done/skipped/incomplete summary
  // counts since the staff has no answer to give for them.
  checklist: Array<{
    label: string;
    checked: boolean;
    note: string | null;
    is_child?: boolean;
    kind?: string;
    description?: string | null;
  }>;
  /** Headline amounts featured above the checklist body — admin
   *  marks amount rows with is_headline_amount. Stack ordered by
   *  display_order; first one renders biggest. Empty/omitted = no
   *  headline block. */
  headlines?: Array<{ label: string; amount: string }>;
  /** True when this submission replaces a previously-submitted (and
   *  admin-unlocked) report for the same (branch, type, date). The
   *  card header gets a "ฉบับแก้ไข" chip so reviewers know they're
   *  looking at a revision. */
  isRevision?: boolean;
  /** Optional header background hex (e.g. '#e94560'). Falls back to
   *  the default IKIGAI ink colour when null/undefined. Lets each
   *  branch flag its identity in the cross-branch staff group. */
  headerColor?: string | null;
};

// Small reusable chip rendered above the card title when a report
// is a revision (staff re-submitted after admin unlocked the
// original). Wrap the text in a box so we can give it a real
// background — LINE Flex `text` doesn't accept backgroundColor
// directly, only `box` does. Returns null when not a revision so
// callers can splice it conditionally.
function revisionChip(isRevision?: boolean): Record<string, unknown> | null {
  if (!isRevision) return null;
  return {
    type: "box", layout: "vertical",
    backgroundColor: "#fde68a",
    cornerRadius: "4px",
    paddingAll: "2px",
    paddingStart: "8px",
    paddingEnd: "8px",
    margin: "sm",
    contents: [
      {
        type: "text",
        text: "✏ ฉบับแก้ไข",
        color: "#78350f",
        size: "xxs",
        weight: "bold"
      }
    ]
  };
}

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
  // Section rows are non-interactive headers, so they get filtered
  // out of every bucket — staff has no answer to give for them.
  const answerableRows = checklistRows.filter((it) => it.kind !== "section");
  const doneCount = answerableRows.filter((it) => it.checked).length;
  const skippedCount = answerableRows.filter((it) => !it.checked && !!it.note?.trim()).length;
  const incompleteCount = answerableRows.filter((it) => !it.checked && !it.note?.trim()).length;
  const allDone = answerableRows.length > 0 && doneCount === answerableRows.length;

  // Summary line — color + wording shifts based on which buckets are
  // non-zero. "All done" wins, then "incomplete > 0" (red flag, asks
  // supervisor to double-check), otherwise it's just skipped-with-notes
  // (amber, informational).
  const supervisorWarning =
    "Check list ก่อนเริ่มงานยังไม่ครบถ้วน ให้หัวหน้างานตรวจสอบอีกครั้ง";
  const summary = allDone
    ? { text: "✓ Check list ครบทุกข้อ", color: "#059669" }
    : incompleteCount > 0
      ? {
          text: skippedCount > 0
            ? `⚠ ${supervisorWarning} (ยังไม่ได้ทำ ${incompleteCount} ข้อ · ข้ามวันนี้ ${skippedCount} ข้อ)`
            : `⚠ ${supervisorWarning}`,
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
  const checklistItemBox = (it: { label: string; checked: boolean; note: string | null; kind?: string }) => {
    // 'section' row renders as a small-caps group header with no
    // icon/checkbox. Same treatment used on the staff form so the
    // card reads consistently with what the staff just filled in.
    if (it.kind === "section") {
      return {
        type: "text",
        text: it.label,
        size: "xxs",
        weight: "bold",
        color: COLOR_TEXT_MUTED,
        margin: "md",
        wrap: true
      };
    }
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

  const headerColor = args.headerColor || COLOR_INK_700;

  const bubble = {
    // 2026-05-27: all Flex bubbles bumped to "giga" (was "mega")
    // for consistent full-width presentation across every notification
    // surface. Owner direction — long Thai labels were still wrapping
    // awkwardly on narrow phones at the mega size; giga fixes it
    // uniformly and matches the existing shift / approval / summary
    // cards that were already giga.
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "Check list ก่อนเริ่มงาน", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "20px",
      contents: [
        ...(revisionChip(args.isRevision) ? [revisionChip(args.isRevision) as Record<string, unknown>] : []),
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "box", layout: "vertical", spacing: "sm", margin: "md",
          contents: [
            kvRow("ผู้เปิดกะ", args.openerName),
            kvRow("ยอดเงินปิดกะเมื่อวาน", fmtBaht(args.yesterdayClosingAmount), { valueWeight: "bold" }),
            kvRow("ยอดเงินเปิดกะเช้านี้", fmtBaht(args.morningDrawerAmount),
              { valueColor: COLOR_BRAND, valueWeight: "bold" })
          ]
        },
        ...(headlineFlexBlock(args.headlines ?? [])
          ? [headlineFlexBlock(args.headlines ?? []) as Record<string, unknown>]
          : []),
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
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };

  return {
    type: "flex",
    altText: `Check list ก่อนเริ่มงาน ${args.branchName} · ${dateStr} · ${args.openerName}`,
    contents: bubble
  };
}

// ── PERSONA: shift_close + readiness Flex cards ──────────────────────
//
// Mirror shiftOpenFlex's structure so admin sees consistent visuals
// across the 4 report types. Each card uses the same header bar
// (IKIGAI OS · PERSONA • STAFF), summarizes the type-specific data,
// and lists the checklist with the same 3-state rendering (done /
// skipped-with-note / not-done) plus an incomplete-counter.

/** Shared checklist body block — 3-state rendering + summary line.
 *  Returns the Flex contents to splice into a body box.
 *
 *  Each entry can carry `is_child` to signal "this row is a sub-item
 *  of the previous parent" — renderer indents it with a leading
 *  spacer and a slightly smaller font so the visual hierarchy on the
 *  LINE card matches the admin's tree in the editor. */
function checklistFlexBlock(
  checklist: Array<{
    label: string;
    checked: boolean;
    note: string | null;
    is_child?: boolean;
    kind?: string;
    description?: string | null;
  }>
): unknown[] {
  if (checklist.length === 0) return [];
  // Section rows are non-interactive headers — exclude them from
  // every count bucket so "ครบทุกข้อ" really means every answerable
  // row was answered, not "every row including the headers".
  const answerable = checklist.filter((it) => it.kind !== "section");
  const doneCount = answerable.filter((it) => it.checked).length;
  const skippedCount = answerable.filter((it) => !it.checked && !!it.note?.trim()).length;
  const incompleteCount = answerable.filter((it) => !it.checked && !it.note?.trim()).length;
  const allDone = answerable.length > 0 && doneCount === answerable.length;

  const supervisorWarning =
    "Check list ยังไม่ครบถ้วน ให้หัวหน้างานตรวจสอบอีกครั้ง";
  const summary = allDone
    ? { text: "✓ Check list ครบทุกข้อ", color: "#059669" }
    : incompleteCount > 0
      ? {
          text: skippedCount > 0
            ? `⚠ ${supervisorWarning} (ยังไม่ได้ทำ ${incompleteCount} ข้อ · ข้ามวันนี้ ${skippedCount} ข้อ)`
            : `⚠ ${supervisorWarning}`,
          color: "#dc2626"
        }
      : {
          text: `ทำแล้ว ${doneCount} ข้อ · ข้ามวันนี้ ${skippedCount} ข้อ (มีหมายเหตุ)`,
          color: "#b45309"
        };

  const itemBox = (it: {
    label: string;
    checked: boolean;
    note: string | null;
    is_child?: boolean;
    kind?: string;
    description?: string | null;
  }) => {
    // Section header — same uppercase muted-grey treatment as the
    // staff form, no icon, no checkbox. Indent slightly for children.
    if (it.kind === "section") {
      return {
        type: "text",
        text: it.label,
        size: "xxs",
        weight: "bold",
        color: COLOR_TEXT_MUTED,
        margin: "md",
        wrap: true,
        ...(it.is_child ? { paddingStart: "20px" } : {})
      };
    }
    const note = it.note?.trim();
    const description = it.description?.trim();
    const skipped = !it.checked && !!note;
    const isChild = !!it.is_child;
    // Child rows: prefix with " ↳" so even monochrome rendering keeps
    // the hierarchy. Top-level rows show their checkbox icon as-is.
    const icon = isChild ? "↳" : (it.checked ? "✓" : skipped ? "📝" : "✗");
    const iconColor = isChild
      ? COLOR_TEXT_MUTED
      : (it.checked ? "#059669" : skipped ? "#b45309" : "#dc2626");
    const labelColor = it.checked ? COLOR_TEXT_DARK : skipped ? "#475569" : "#dc2626";
    const rowBox: Record<string, unknown> = {
      type: "box", layout: "horizontal", spacing: "sm",
      // Indent the entire child row by adding left padding via a
      // small leading filler. Keeps the icon + label aligned within
      // the indented column.
      ...(isChild ? { paddingStart: "20px" } : {}),
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
          weight: it.checked && !isChild ? "regular" : "bold"
        }
      ]
    };
    // Show the note line whenever a note is present. Two distinct
    // cases benefit:
    //   • checked + note  → text-input item where the staff filled in
    //                        a value (P5c). Without this line the card
    //                        would say "✓ ยอดเงินคงเหลือ" but never
    //                        show the actual amount.
    //   • !checked + note → legacy "skipped with reason" case.
    // The icon already disambiguates which case it is (📝 vs ↳).
    // Below the row we may stack: description (admin's small help
     // text, when set) and/or note (staff's typed value / skip reason).
     // Both align under the label using a paddingStart wrapper box —
     // paddingStart isn't valid on `text` directly.
    const extras: Record<string, unknown>[] = [];
    const labelPadStart = isChild ? "40px" : "20px";
    if (description) {
      extras.push({
        type: "box",
        layout: "vertical",
        paddingStart: labelPadStart,
        contents: [
          {
            type: "text",
            text: description,
            size: "xxs",
            color: COLOR_TEXT_MUTED,
            wrap: true,
            margin: "none"
          }
        ]
      });
    }
    if (note) {
      // Show the note line whenever a note is present. Two cases:
      //   • checked + note  → text/amount item the staff filled in
      //   • !checked + note → legacy "skipped with reason" case.
      // The leading icon (📝 vs ↳) already disambiguates.
      extras.push({
        type: "box",
        layout: "vertical",
        paddingStart: labelPadStart,
        contents: [
          {
            type: "text",
            text: `↳ ${note}`,
            size: "xxs",
            color: skipped ? "#b45309" : COLOR_TEXT_DARK,
            wrap: true,
            margin: "none"
          }
        ]
      });
    }
    if (extras.length === 0) return rowBox;
    return {
      type: "box", layout: "vertical", spacing: "xs",
      contents: [rowBox, ...extras]
    };
  };

  return [
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
      contents: checklist.map(itemBox)
    }
  ];
}

export type ShiftCloseCardArgs = {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD
  closerName: string;
  closingDrawerAmount: number | null;
  /** Service charge collected today — only relevant when the branch
   *  has require_service_charge ON. Rendered as a headline figure at
   *  the top of the body (2026-05-28 — was a kvRow before, owner
   *  asked for the 3 default money fields to be visually prominent
   *  like the custom is_headline_amount items). null when the branch
   *  doesn't collect SVC or staff didn't fill it. */
  serviceChargeAmount?: number | null;
  /** Daily sales revenue (ASCENDA feed) — added 2026-05-28 as a
   *  headline figure on the close report. null when the branch has
   *  require_daily_revenue OFF or staff skipped it. With the channel
   *  model (2026-06-22) this equals the sum of `channels`. */
  dailyRevenue?: number | null;
  /** Per-channel sales breakdown (owner 2026-06-22). Rendered as a
   *  section under the red-box total: each channel + amount (credit ones
   *  tagged), then a เงินเข้าจริง / ค้างชำระ split. Omit/empty = no block. */
  channels?: Array<{ name: string; amount: number; isCredit?: boolean }>;
  /** Progress toward the day's sales target (owner 2026-07-11) — a small
   *  bar under the headline showing ยอดขายวันนี้ as a % of the daily target
   *  (monthly target ÷ days in month). Omit/null when the branch has no
   *  monthly target set, so the block is skipped. */
  salesTarget?: {
    dailyTarget: number;   // baht
    todaySales: number;    // baht
    pct: number;           // todaySales/dailyTarget × 100, one decimal, can exceed 100
  } | null;
  // Same shape as ShiftOpenCardArgs.checklist — see that doc block.
  // Optional is_child + description fields propagate from admin rows
  // and are tolerated here so callers can pass a single normalized
  // shape across all three Flex builders without TS excess-property
  // tripping on fresh object literals.
  checklist: Array<{
    label: string;
    checked: boolean;
    note: string | null;
    is_child?: boolean;
    kind?: string;
    description?: string | null;
  }>;
  /** Headline amounts featured above the checklist body — admin
   *  marks amount rows with is_headline_amount. Stack ordered by
   *  display_order; first one renders biggest. Empty/omitted = no
   *  headline block. */
  headlines?: Array<{ label: string; amount: string }>;
  isRevision?: boolean;
  /** See readinessFlex / shiftOpenFlex headerColor. */
  headerColor?: string | null;
  /** Per-branch override (2026-05-30): admin's choice of which of
   *  the three default money fields render in the red headline box.
   *  Missing or undefined keys default to true (= keep including) so
   *  callers that don't pass the override behave the same as before.
   *  Fields excluded here STILL appear in the checklist body — they
   *  just don't get the dramatic red treatment. */
  defaultFieldPrimary?: {
    closingDrawer?: boolean;
    serviceCharge?: boolean;
    dailyRevenue?: boolean;
  };
  /** Per-branch label override + display order (extends 2026-05-30
   *  beyond the boolean toggle). Each entry: label is the wording
   *  shown in the headline; order is small positive int (lower
   *  renders first). Missing entries fall back to the hardcoded
   *  defaults below: ยอดเงินปิดงาน / เซอร์วิสชาร์จวันนี้ / ยอดขายวันนี้
   *  at orders 1/2/3. */
  defaultFieldConfig?: {
    closingDrawer?: { label?: string | null; order?: number };
    serviceCharge?: { label?: string | null; order?: number };
    dailyRevenue?: { label?: string | null; order?: number };
  };
};

export function shiftCloseFlex(args: ShiftCloseCardArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const headerColor = args.headerColor || COLOR_INK_700;

  // Default-figure headlines (2026-05-28). Owner direction: the 3
  // mandatory money fields (closing drawer / service charge / daily
  // revenue) should appear as headline figures at the top of the
  // report — same visual treatment as the custom is_headline_amount
  // items below them. Build a synthetic headline array from the three
  // values when each is present, then concat with any admin-defined
  // headlines from the checklist. Order = closing → SVC → revenue →
  // custom headlines (so the most important number — closing drawer —
  // renders biggest at the top).
  // Apply the per-branch override: if defaultFieldPrimary.<field> is
  // explicitly false, skip pushing it into the headline array.
  // Undefined/missing → push (legacy default). The fields are still
  // shown to the user; they just appear inside the regular checklist
  // body rendered by the form, not here.
  const labelCfg = args.defaultFieldConfig ?? {};
  const fmtBaht = (n: number | null | undefined) =>
    n == null ? "—" : `${n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} บาท`;

  // Fixed layout (owner 2026-06-09): only (D) ยอดขายวันนี้ gets the
  // prominent red box. (A) ยอดเงินปิดกะวันนี้ + (C) เซอร์วิสชาร์จวันนี้ render
  // as bold rows below (added to the info group). Custom is_headline_amount
  // items keep the red box after ยอดขาย. Labels still honour overrides.
  const closingLabel = labelCfg.closingDrawer?.label?.trim() || "ยอดเงินปิดกะวันนี้";
  const svcLabel = labelCfg.serviceCharge?.label?.trim() || "เซอร์วิสชาร์จวันนี้";
  const dailyHeadlines: Array<{ label: string; amount: string }> = [];
  if (args.dailyRevenue != null) {
    dailyHeadlines.push({
      label: labelCfg.dailyRevenue?.label?.trim() || "ยอดขายวันนี้",
      amount: args.dailyRevenue.toLocaleString("th-TH", {
        minimumFractionDigits: 0, maximumFractionDigits: 2
      })
    });
  }
  const mergedHeadlines = [...dailyHeadlines, ...(args.headlines ?? [])];

  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "Check list หลังเลิกงาน", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        ...(revisionChip(args.isRevision) ? [revisionChip(args.isRevision) as Record<string, unknown>] : []),
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // Just the submitter — closing/SVC/revenue moved into the
        // headline block below per owner direction 2026-05-28 so the
        // 3 default money fields share the same prominent visual
        // treatment as custom is_headline_amount checklist items.
        {
          type: "box", layout: "vertical", spacing: "sm", margin: "md",
          contents: [
            kvRow("ผู้ส่งรายการ", args.closerName),
            ...(args.closingDrawerAmount != null
              ? [kvRow(closingLabel, fmtBaht(args.closingDrawerAmount), { valueWeight: "bold" })]
              : []),
            ...(args.serviceChargeAmount != null
              ? [kvRow(svcLabel, fmtBaht(args.serviceChargeAmount), { valueWeight: "bold" })]
              : [])
          ]
        },
        ...(headlineFlexBlock(mergedHeadlines)
          ? [headlineFlexBlock(mergedHeadlines) as Record<string, unknown>]
          : []),
        ...(salesTargetBarBlock(args.salesTarget)
          ? [salesTargetBarBlock(args.salesTarget) as Record<string, unknown>]
          : []),
        ...(channelBreakdownBlock(args.channels)
          ? [channelBreakdownBlock(args.channels) as Record<string, unknown>]
          : []),
        ...checklistFlexBlock(args.checklist)
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };
  return {
    type: "flex",
    altText: `Check list หลังเลิกงาน ${args.branchName} · ${dateStr} · ${args.closerName}`,
    contents: bubble
  };
}

export type ReadinessCardArgs = {
  branchName: string;
  reportDate: string;
  reporterName: string;
  /** Slot label — "รอบเช้า" / "รอบบ่าย". */
  slotLabel: string;
  /** Slot time HH:MM — admin-configured per branch, shown next to slotLabel. */
  slotTime: string;
  /** The full set of checklist items the staff filled out — fully
   *  admin-configurable since 2026-05-21. Each item is either a
   *  checkbox (`checked`), a text entry (`checked` + `note` = typed
   *  value), or a choice (`checked` + `note` = picked option). The
   *  Flex renderer treats them uniformly. */
  checklist: Array<{
    label: string;
    checked: boolean;
    note?: string | null;
    is_child?: boolean;
    kind?: string;
    description?: string | null;
  }>;
  /** Headline amounts featured above the checklist body — admin
   *  marks amount rows with is_headline_amount. Stack ordered by
   *  display_order; first one renders biggest. Empty/omitted = no
   *  headline block. */
  headlines?: Array<{ label: string; amount: string }>;
  isRevision?: boolean;
  /** Optional header background hex (e.g. '#e94560'). Falls back to
   *  the default IKIGAI ink colour when null/undefined. Used so each
   *  branch's CI colour shows on the LINE card even when the message
   *  is routed through the shared IKIGAI OS OA. */
  headerColor?: string | null;
};

// (readinessSection helper deleted 2026-05-21 — the readiness card is
// now built entirely from the admin checklist via checklistFlexBlock,
// no labelled-section blocks needed.)

/** Per-channel sales breakdown (owner 2026-06-22) — sits under the red-box
 *  total. Lists each channel that had a value, tags ค้างชำระ ones, then shows
 *  the เงินเข้าจริง (cash) vs ค้างชำระ (receivable) split. */
function channelBreakdownBlock(
  channels?: Array<{ name: string; amount: number; isCredit?: boolean }>
): Record<string, unknown> | null {
  const rows = (channels ?? []).filter((c) => c.amount > 0);
  if (rows.length === 0) return null;
  const fmt = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const cash = rows.filter((c) => !c.isCredit).reduce((s, c) => s + c.amount, 0);
  const credit = rows.filter((c) => c.isCredit).reduce((s, c) => s + c.amount, 0);
  return {
    type: "box", layout: "vertical", spacing: "xs", margin: "lg",
    contents: [
      { type: "text", text: "ยอดขายแยกช่องทาง", size: "xs", weight: "bold", color: COLOR_TEXT_MUTED },
      ...rows.map((c) => ({
        type: "box", layout: "horizontal", spacing: "sm",
        contents: [
          { type: "text", text: c.isCredit ? `${c.name} (ค้าง)` : c.name, size: "sm", color: COLOR_TEXT_DARK, flex: 5, wrap: true },
          { type: "text", text: fmt(c.amount), size: "sm", weight: "bold", color: c.isCredit ? "#b45309" : COLOR_TEXT_DARK, flex: 4, align: "end", wrap: true }
        ]
      })),
      { type: "separator", margin: "sm", color: COLOR_DIVIDER },
      kvRow("เงินเข้าจริงวันนี้", `${fmt(cash)} บาท`, { valueWeight: "bold" }),
      ...(credit > 0 ? [kvRow("ค้างชำระ (ลูกหนี้)", `${fmt(credit)} บาท`, { valueColor: "#b45309", valueWeight: "bold" })] : [])
    ]
  };
}

/** Sales-target progress bar (owner 2026-07-11) — a compact bar under the
 *  headline showing ยอดขายวันนี้ as a % of the day's target (monthly target
 *  ÷ days in month). Built from two flex-ratio segments inside a horizontal
 *  grey track (a coloured fill = round(pct) and a transparent remainder =
 *  100 − fill), which renders reliably across LINE clients where a
 *  percentage-width box in a vertical layout does not. Each segment carries
 *  a `filler` so the box is non-empty. The label shows the true %, which
 *  can read over 100 when the day beats target. */
function salesTargetBarBlock(
  st?: { dailyTarget: number; todaySales: number; pct: number } | null
): Record<string, unknown> | null {
  if (!st || !(st.dailyTarget > 0)) return null;
  const fmt = (n: number) =>
    n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const reached = st.pct >= 100;
  const barColor = reached ? "#16a34a" : COLOR_BRAND;
  const fill = Math.min(100, Math.max(0, Math.round(st.pct)));
  const pctText = `${st.pct.toLocaleString("th-TH", { maximumFractionDigits: 1 })}%`;

  const segment = (flexN: number, color: string | null) => ({
    type: "box", layout: "vertical", flex: flexN, height: "10px",
    ...(color ? { backgroundColor: color, cornerRadius: "5px" } : {}),
    contents: [{ type: "filler" }]
  });
  const trackContents: Array<Record<string, unknown>> = [];
  if (fill > 0) trackContents.push(segment(fill, barColor));
  if (fill < 100) trackContents.push(segment(100 - fill, null));

  return {
    type: "box", layout: "vertical", spacing: "xs", margin: "md",
    contents: [
      {
        type: "box", layout: "horizontal",
        contents: [
          { type: "text", text: "ยอดขายวันนี้เทียบเป้า", size: "xs", color: COLOR_TEXT_MUTED, flex: 0 },
          { type: "text", text: pctText, size: "sm", weight: "bold", color: barColor, align: "end", flex: 1 }
        ]
      },
      {
        type: "box", layout: "horizontal", height: "10px",
        backgroundColor: "#e2e8f0", cornerRadius: "5px", margin: "xs",
        contents: trackContents
      },
      {
        type: "text",
        text: `ทำได้ ${fmt(st.todaySales)} / เป้าวันนี้ ${fmt(st.dailyTarget)} บาท${reached ? " · ถึงเป้าแล้ว 🎉" : ""}`,
        size: "xxs", color: COLOR_TEXT_MUTED, wrap: true, margin: "xs"
      }
    ]
  };
}

/** Headline block — the "ยอดเงินปิดกะ 32,999.00 บาท" stack that sits
 *  prominently above the checklist. Admin opts in by marking
 *  amount-kind rows as headline; the FIRST entry renders biggest, the
 *  rest stack smaller below it. Empty array = no block rendered.
 *  Visual hierarchy is bold-by-design so the numbers read at a
 *  glance from a busy LINE group. */
function headlineFlexBlock(
  headlines: Array<{ label: string; amount: string }>
): Record<string, unknown> | null {
  if (headlines.length === 0) return null;
  const rows: Record<string, unknown>[] = [];
  headlines.forEach((h, i) => {
    const isPrimary = i === 0;
    rows.push(
      {
        type: "text",
        text: h.label,
        size: "xs",
        color: COLOR_TEXT_MUTED,
        wrap: true,
        ...(isPrimary ? {} : { margin: "md" })
      },
      {
        type: "text",
        text: `${h.amount} บาท`,
        size: isPrimary ? "xxl" : "xl",
        weight: "bold",
        color: "#dc2626",
        // wrap:true so a long amount wraps instead of bleeding past the
        // bubble edge on narrow phones (owner 2026-06-09).
        wrap: true
      }
    );
  });
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    margin: "md",
    paddingAll: "12px",
    backgroundColor: "#fef2f2",
    cornerRadius: "8px",
    borderColor: "#fecaca",
    borderWidth: "1px",
    contents: rows
  };
}

export function readinessFlex(args: ReadinessCardArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  // Title carries both the slot label (รอบเช้า/รอบบ่าย) and the
  // admin-configured time so recipients see "what round + at what
  // exact time today" without checking another screen.
  const titleText = `รายงานความพร้อม${args.slotLabel} (${args.slotTime} น.)`;

  // Header colour is per-branch when supplied, otherwise the default
  // IKIGAI ink slate. Same hex flows to both the header box's
  // backgroundColor and the bubble-level styles.header — LINE applies
  // the styles to round the header corners; mismatching the two would
  // leave a visible seam.
  const headerColor = args.headerColor || COLOR_INK_700;

  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: titleText, color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        ...(revisionChip(args.isRevision) ? [revisionChip(args.isRevision) as Record<string, unknown>] : []),
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "box", layout: "vertical", spacing: "sm", margin: "md",
          contents: [
            kvRow("ผู้ส่งรายการ", args.reporterName)
          ]
        },
        // Headline amount (optional) — admin marks an amount row as
        // "show big on top" and we render it here in brand red.
        ...(headlineFlexBlock(args.headlines ?? [])
          ? [headlineFlexBlock(args.headlines ?? []) as Record<string, unknown>]
          : []),
        // Admin-configured items — fully drive the card body since
        // 2026-05-21. Reuses the same 3-state row renderer as
        // shift_open / shift_close so admins recognise the language.
        ...checklistFlexBlock(args.checklist.map((c) => ({
          label: c.label,
          checked: c.checked,
          note: c.note ?? null,
          // Pass through optional fields so readiness cards get the
          // same child-indent + description + section-header rendering
          // as open/close cards. Mapper used to drop these and the
          // rendering quietly regressed for readiness — preserve them.
          is_child: c.is_child,
          kind: c.kind,
          description: c.description ?? null
        }))) as Record<string, unknown>[]
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };
  return {
    type: "flex",
    altText: `${titleText} ${args.branchName} · ${dateStr} · ${args.reporterName}`,
    contents: bubble
  };
}

// ── PERSONA: shift unlock request Flex ───────────────────────────────
//
// When a staff member spots an error on a daily report they already
// submitted (any of the 4 types), they hit "ขอแก้ไข" and this card
// lands in the staff LINE group so admin sees the request inline.
// Admin acts via /admin/persona/shift-reports.

const REPORT_TYPE_LABEL_TH: Record<
  "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600",
  string
> = {
  shift_open:     "Check list ก่อนเริ่มงาน",
  shift_close:    "Check list หลังเลิกงาน",
  readiness_1130: "รายงานความพร้อมรอบเช้า",
  readiness_1600: "รายงานความพร้อมรอบบ่าย"
};

export type ShiftUnlockRequestArgs = {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD
  reportType: keyof typeof REPORT_TYPE_LABEL_TH;
  openerName: string;          // who originally submitted
  requesterName: string;       // who's asking for unlock (may differ)
  reason: string;
  /** See readinessFlex headerColor — branch CI hex for the header. */
  headerColor?: string | null;
};

export function shiftUnlockRequestFlex(args: ShiftUnlockRequestArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const typeLabel = REPORT_TYPE_LABEL_TH[args.reportType];
  const headerColor = args.headerColor || COLOR_INK_700;
  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "คำขอแก้ไขรายการ", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
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
            kvRow("รายการที่ขอแก้ไข", typeLabel,
              { valueColor: COLOR_TEXT_DARK }),
            kvRow("ผู้ส่งรายการเดิม", args.openerName),
            kvRow("ผู้ขอแก้ไข", args.requesterName,
              { valueColor: COLOR_BRAND, valueWeight: "bold" })
          ]
        },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "box", layout: "vertical", spacing: "xs", margin: "md",
          contents: [
            { type: "text", text: "เหตุผล", size: "xs", color: COLOR_LABEL },
            {
              type: "text",
              text: args.reason,
              size: "sm", color: COLOR_TEXT_DARK, wrap: true, weight: "bold"
            }
          ]
        },
        {
          type: "text",
          text: `มีคำขอแก้ไข ${typeLabel} ให้แอดมินปลดล็อค และตรวจสอบรายการอีกครั้ง`,
          size: "xxs",
          color: "#b45309",
          wrap: true,
          margin: "md"
        }
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };

  return {
    type: "flex",
    altText: `คำขอแก้ไขรายการ ${args.branchName} · ${dateStr} · ${args.requesterName}`,
    contents: bubble
  };
}

// ── PERSONA: shift unlock decision Flex (admin → staff) ──────────────
//
// Admin's grant or reject decision lands back in the staff LINE group
// so the requester sees the outcome immediately. Reject includes the
// admin's note (when provided) so staff understands why and can file
// another request with better reason if needed. Grant just confirms
// the record was unlocked.

export type ShiftUnlockDecisionArgs = {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD
  requesterName: string;
  adminName: string;
  decision: "granted" | "rejected";
  decisionNote: string | null;
  /** See readinessFlex headerColor — branch CI hex for the header. */
  headerColor?: string | null;
};

export function shiftUnlockDecisionFlex(args: ShiftUnlockDecisionArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const isGrant = args.decision === "granted";
  const titleText = isGrant ? "อนุมัติให้แก้ไขรายการ" : "ปฏิเสธคำขอแก้ไขรายการ";
  const accentColor = isGrant ? "#059669" : "#dc2626";
  const iconText = isGrant ? "✓" : "✗";
  const headerColor = args.headerColor || COLOR_INK_700;

  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md", spacing: "sm",
          contents: [
            { type: "text", text: iconText, color: accentColor, size: "lg", weight: "bold", flex: 0 },
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
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "box", layout: "vertical", spacing: "sm", margin: "md",
          contents: [
            kvRow("ผู้ขอแก้ไข", args.requesterName),
            kvRow("ผู้อนุมัติรายการ", args.adminName,
              { valueColor: COLOR_BRAND, valueWeight: "bold" })
          ]
        },
        ...(args.decisionNote ? [
          { type: "separator", margin: "md", color: COLOR_DIVIDER },
          {
            type: "box", layout: "vertical", spacing: "xs", margin: "md",
            contents: [
              { type: "text", text: "หมายเหตุจากแอดมิน", size: "xs", color: COLOR_LABEL },
              {
                type: "text",
                text: args.decisionNote,
                size: "sm", color: COLOR_TEXT_DARK, wrap: true, weight: "bold"
              }
            ]
          }
        ] : []),
        {
          type: "text",
          text: isGrant
            ? "พนักงานสามารถส่งรายการใหม่ได้แล้ว"
            : "พนักงานสามารถส่งคำขอแก้ไขใหม่ได้ ถ้ายังต้องการ",
          size: "xxs",
          color: accentColor,
          wrap: true,
          margin: "md"
        }
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };

  return {
    type: "flex",
    altText: `${titleText} ${args.branchName} · ${dateStr} · ${args.requesterName}`,
    contents: bubble
  };
}

// ── PERSONA: daily attendance summary Flex (group-facing) ────────
//
// Sent to the cross-branch staff group every time someone clocks
// in/out — a fresh snapshot of who's expected at the branch today,
// who's shown up, who hasn't. Replaces the per-person spam pattern
// (one DM per clock event) with one consolidated rolling card the
// team can glance at.

export type AttendanceSummaryArgs = {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD Bangkok
  roster: AttendanceRow[];
  /** Who just clocked in/out — surfaced as a small "📥 just in"
   *  line below the title so admin can see what triggered this
   *  particular update. */
  triggerName: string;
  triggerAction: "in" | "out";
  triggerTime: string;         // HH:MM Bangkok
  headerColor?: string | null;
};

/** Format a clock-in/out ISO timestamp to "HH:MM" Bangkok local. */
function fmtBkkTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(11, 16);
}

export function attendanceSummaryFlex(args: AttendanceSummaryArgs): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const headerColor = args.headerColor || COLOR_INK_700;

  // Bucket the roster — anyone with an in-time today is "arrived",
  // everyone else is "absent". We don't try to enforce shift
  // schedules here (those land in TC-5); for now the roster is the
  // full set of staff assigned to the branch.
  const arrived = args.roster.filter((r) => r.inTs);
  const absent = args.roster.filter((r) => !r.inTs);

  // Each arrived row: "นาย ก. · เข้า 08:32 · ออก 17:00" (out portion
  // omitted when the staff is still on shift). Each absent row: just
  // the display name. Both lists wrap inside a single box so long
  // names don't break the column.
  function arrivedLine(row: AttendanceRow): Record<string, unknown> {
    const parts: string[] = [`เข้า ${fmtBkkTime(row.inTs)}`];
    if (row.outTs) parts.push(`ออก ${fmtBkkTime(row.outTs)}`);
    return {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        {
          type: "text", text: row.displayName,
          size: "sm", color: COLOR_TEXT_DARK, weight: "bold",
          flex: 5, wrap: true
        },
        {
          type: "text", text: parts.join(" · "),
          size: "xs", color: COLOR_TEXT_MUTED,
          flex: 5, align: "end", wrap: true
        }
      ]
    };
  }
  function absentLine(row: AttendanceRow): Record<string, unknown> {
    return {
      type: "text", text: row.displayName,
      size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "xs"
    };
  }

  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • STAFF", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "รายชื่อพนักงานวันนี้", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        // Trigger line — points at who just punched in/out
        {
          type: "text",
          text: args.triggerAction === "in"
            ? `📥 ${args.triggerName} · เข้างานเวลา ${args.triggerTime}`
            : `📤 ${args.triggerName} · เลิกงานเวลา ${args.triggerTime}`,
          size: "xs",
          color: COLOR_BRAND,
          weight: "bold",
          margin: "xs",
          wrap: true
        },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // ── มาแล้ว ──
        {
          type: "text",
          text: `✓ มาแล้ว (${arrived.length} คน)`,
          size: "xs",
          color: "#047857",
          weight: "bold",
          margin: "md"
        },
        ...(arrived.length > 0
          ? [{
              type: "box", layout: "vertical", spacing: "xs", margin: "sm",
              contents: arrived.map(arrivedLine)
            }]
          : [{
              type: "text", text: "—",
              size: "sm", color: COLOR_TEXT_MUTED, margin: "sm"
            }]
        ),
        // ── ยังไม่มา ──
        ...(absent.length > 0 ? [
          { type: "separator", margin: "md", color: COLOR_DIVIDER },
          {
            type: "text",
            text: `⏳ ยังไม่มา (${absent.length} คน)`,
            size: "xs",
            color: "#b45309",
            weight: "bold",
            margin: "md"
          },
          {
            type: "box", layout: "vertical", spacing: "xs", margin: "sm",
            contents: absent.map(absentLine)
          }
        ] : [])
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };
  return {
    type: "flex",
    altText: `รายชื่อพนักงาน ${args.branchName} · ${dateStr} · มา ${arrived.length}/${args.roster.length}`,
    contents: bubble
  };
}

// ── Daily attendance summary (TC-6) ───────────────────────────────
// One-shot card per branch per day, fired by /api/cron at the
// admin-configured attendance_summary_time (HH:MM Bangkok). Splits
// the roster into four buckets so executives can scan the morning
// status without parsing a stream of clock-in pings.

export type DailySummaryFlexRow = {
  displayName: string;
  titlePrefix?: string | null;   // 2026-05: prepended to displayName via nameWithPrefix
  category: "on_time" | "late" | "on_leave" | "absent" | "not_yet";
  inTs: string | null;          // ISO, only for on_time/late
  minutesLate: number;          // only for late
  leaveType: string | null;     // only for on_leave
};

export type DailyAttendanceSummaryArgs = {
  branchName: string;
  reportDate: string;           // YYYY-MM-DD Bangkok
  rows: DailySummaryFlexRow[];
  headerColor?: string | null;
};

/** TH-friendly label for leave_requests.type values. Falls back to
 *  the raw type if we haven't enumerated it — better than dropping
 *  the leave on the floor for an unknown type. */
function leaveTypeLabelTh(type: string | null): string {
  if (!type) return "ลางาน";
  switch (type) {
    case "sick": return "ลาป่วย";
    case "personal": return "ลากิจ";
    case "vacation": return "ลาพักร้อน";
    case "maternity": return "ลาคลอด";
    case "ordination": return "ลาบวช";
    case "bereavement": return "ลาช่วยงานศพ";
    case "unpaid": return "ลาไม่รับค่าจ้าง";
    default: return type;
  }
}

// ── PERSONA: per-shift personal LINE reminder Flex (2026-05) ──────
//
// One owl-themed card sent each morning (or on-demand) to a single
// staff member's personal LINE OA chat. Three modes based on the
// recipient's status for the date:
//   • work     — listing position(s) + start/end times
//   • day_off  — "เป็นวันหยุดของพี่นะครับ พักผ่อนเยอะๆ"
//   • on_leave — surfacing the approved leave type
//
// Owl voice: warm, junior-assistant tone. Rotates one of N greeting
// openings by day-of-month so the daily card doesn't read identically
// every morning.

export type ShiftReminderArgs = {
  branchName: string;
  dateLabel: string;                       // human-friendly: "วันจันทร์ที่ 26 พ.ค. 2569"
  displayName: string;
  titlePrefix: string | null;
  /** Thai nickname (ชื่อเล่น) when set — used in the greeting
   *  ("สวัสดีครับพี่ <ชื่อเล่น>") so the card feels personal.
   *  Falls back silently to displayName when blank/null. */
  nickname?: string | null;
  kind: "work" | "day_off" | "on_leave";
  // 2026-05-27: shifts now carry the full breakdown — duty position
  // title for the green banner, shift CODE (e.g. "NPF") + time for
  // the row below, and the position's job-description text for the
  // small line under that. Each shift = one (banner + row + desc)
  // block stacked vertically when a staff has multiple assignments.
  shifts: Array<{
    positionTitle: string;
    positionDescription: string | null;
    shiftCode: string;
    start: string;
    end: string;
  }>;
  leaveTypeLabel: string | null;           // pre-localised — e.g. "ลาป่วย"
  headerColor?: string | null;
  /** YYYY-MM-DD — used to seed the greeting rotation so the same
   *  card-day always picks the same opener (consistent across
   *  refresh / re-send within the day). */
  dateBkk: string;
  /** Optional admin-authored greeting overrides — newline-separated
   *  lists per kind, fetched from system_settings. Caller is expected
   *  to pass these in so we don't have to query the DB inside a flex
   *  builder. NULL/missing = use built-in defaults. */
  greetingOverrides?: {
    work?: string | null;
    day_off?: string | null;
    on_leave?: string | null;
  } | null;
};

/** Built-in greeting pools — exported so the admin notification
 *  customiser can show them as the placeholder/fallback. Each line
 *  can use `{NAME}` which is spliced in directly after "พี่" with no
 *  space (owner direction: "พี่เกฟ" not "พี่ เกฟ"). The day-seeded
 *  picker below rotates through these (or the admin override) so the
 *  card looks varied without being random. */
export const DEFAULT_SHIFT_GREETINGS = {
  work: [
    "สวัสดีครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "อรุณสวัสดิ์ครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "สวัสดีตอนเช้าครับพี่{NAME} น้องฮูกแวะมาทักทาย",
    "หวัดดีครับพี่{NAME} น้องฮูกขออนุญาตรายงานเวรประจำวัน",
    "สวัสดีครับพี่{NAME} น้องฮูกพร้อมเริ่มวันใหม่ไปกับพี่"
  ],
  day_off: [
    "สวัสดีตอนเช้าครับพี่{NAME} วันนี้พักผ่อนเต็มที่นะครับ",
    "อรุณสวัสดิ์ครับพี่{NAME} วันนี้น้องดูแลร้านให้ พี่พักได้สบายใจ",
    "สวัสดีครับพี่{NAME} วันนี้เป็นวันของพี่ ขอให้พี่มีความสุข",
    "หวัดดีครับพี่{NAME} วันนี้พักนะครับ น้องฝากรอยยิ้มไว้ให้พี่"
  ],
  on_leave: [
    "สวัสดีครับพี่{NAME} น้องฮูกแจ้งเรื่องวันลาของพี่นะครับ",
    "สวัสดีครับพี่{NAME} บันทึกการลาของพี่เรียบร้อย น้องดูแลให้แล้ว",
    "หวัดดีครับพี่{NAME} การลาของพี่ผ่านการอนุมัติแล้วครับ",
    "สวัสดีครับพี่{NAME} น้องขอให้พี่หายไวๆ กลับมาสดชื่นนะครับ"
  ]
} as const;

/** Parse newline-separated greetings from system_settings. Empty
 *  lines and pure-whitespace lines are dropped so an admin can use
 *  blank lines for readability in the textarea without polluting the
 *  rotation. Returns null when the override is empty/missing so the
 *  caller knows to fall back to defaults. */
function parseGreetingOverride(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines : null;
}

function pickShiftGreeting(
  dateBkk: string,
  kind: "work" | "day_off" | "on_leave",
  nameDisplay: string,
  /** Optional admin-authored overrides per kind. NULL/empty falls
   *  back to DEFAULT_SHIFT_GREETINGS. Lets callers pass the cached
   *  system_settings row rather than re-querying on every send. */
  overrides?: {
    work?: string | null;
    day_off?: string | null;
    on_leave?: string | null;
  }
): string {
  let h = 0;
  for (let i = 0; i < dateBkk.length; i++) {
    h = ((h << 5) - h + dateBkk.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h);
  const override = parseGreetingOverride(overrides?.[kind]);
  const list = override ?? (DEFAULT_SHIFT_GREETINGS[kind] as readonly string[]);
  // Attach name with NO space after "พี่" — "พี่เกฟ" not "พี่ เกฟ".
  // Empty nameDisplay → strip the placeholder cleanly so the line
  // reads "สวัสดีครับพี่ น้องฮูกแวะมาทักทาย" as the polite fallback.
  return list[idx % list.length].replace("{NAME}", nameDisplay || "");
}

/** Closing line — short, encouraging, varies per kind. Owner asked
 *  to dial back the cartoon emoji (no owl / heart / moon icons here);
 *  the only emoji-ish marks that survived are functional check/cross
 *  glyphs used elsewhere on decision cards. */
function pickShiftClosing(kind: "work" | "day_off" | "on_leave"): string {
  if (kind === "work") return "อย่าลืมลงเวลาเข้างานนะครับ น้องเอาใจช่วย";
  if (kind === "day_off") return "ขอให้พี่มีวันหยุดที่ดีนะครับ";
  return "หากต้องการเปลี่ยนแปลงข้อมูล ติดต่อหัวหน้าโดยตรงครับ";
}

export function personaShiftReminderFlex(args: ShiftReminderArgs): LineFlexMessage {
  const headerColor = args.headerColor || COLOR_INK_700;
  // Preferred salutation: nickname (warm). Owner direction: the name
  // attaches DIRECTLY to "พี่" with no space — "พี่เกฟ" not "พี่ เกฟ"
  // — so we pass the bare nickname for the greeting picker to splice
  // in. When no nickname is on file we deliberately pass "" (NOT the
  // display_name) — concatenating "Mr. Phuthitat" or "นาย ภูทิกัต"
  // after "พี่" produces awkward strings; the greeting picker
  // gracefully degrades to "สวัสดีครับพี่ น้องฮูกแวะมาทักทาย" which
  // is polite + grammatical.
  const nameForGreeting = (args.nickname && args.nickname.trim()) || "";
  const greeting = pickShiftGreeting(
    args.dateBkk,
    args.kind,
    nameForGreeting,
    args.greetingOverrides ?? undefined
  );
  const closing = pickShiftClosing(args.kind);

  // Banner colour varies per kind so the recipient knows at a glance
  // which kind of day it is. Owner 2026-05-27 asked to drop the
  // decorative emoji prefixes (✨🌙📅) — the colour + label alone
  // carries the meaning, the icons just felt noisy. The work-kind
  // label is now the duty POSITION title (e.g. "PASTA") instead of
  // the generic "เวรประจำวันของพี่" — one card per shift block.
  const bannerColorByKind = {
    work:    "#10b981",
    day_off: "#f59e0b",
    on_leave: "#0ea5e9"
  } as const;
  const bannerColor = bannerColorByKind[args.kind];

  // Build the work-kind blocks. Each shift gets its own (banner +
  // code+time row + description). Day-off / on-leave only show a
  // single banner with the generic label since they have no shifts.
  const shiftBlocks: Array<Record<string, unknown>> = [];
  if (args.kind === "work" && args.shifts.length > 0) {
    args.shifts.forEach((s, idx) => {
      // Spacer between consecutive shift blocks so they don't fuse.
      if (idx > 0) {
        shiftBlocks.push({ type: "separator", margin: "md", color: COLOR_DIVIDER });
      }
      // Green banner — position title (large, centered).
      shiftBlocks.push({
        type: "box", layout: "vertical",
        paddingAll: "16px", margin: "md",
        backgroundColor: bannerColor + "20",
        cornerRadius: "10px",
        borderWidth: "1px",
        borderColor: bannerColor,
        contents: [
          {
            type: "text",
            text: s.positionTitle,
            size: "xl", color: bannerColor, weight: "bold",
            wrap: true, align: "center"
          }
        ]
      });
      // Code + time row.
      shiftBlocks.push({
        type: "box", layout: "horizontal", spacing: "sm", margin: "md",
        contents: [
          {
            type: "text", text: s.shiftCode,
            size: "md", color: COLOR_TEXT_DARK, weight: "bold",
            flex: 4, wrap: true
          },
          {
            type: "text",
            text: `${s.start}–${s.end} น.`,
            size: "md", color: COLOR_TEXT_DARK, weight: "bold",
            flex: 5, align: "end", wrap: true
          }
        ]
      });
      // Job description — small + muted so it doesn't compete with
      // the code+time row visually. Skipped silently when blank.
      if (s.positionDescription && s.positionDescription.trim()) {
        shiftBlocks.push({
          type: "text",
          text: s.positionDescription.trim(),
          size: "sm", color: COLOR_TEXT_MUTED, wrap: true, margin: "sm"
        });
      }
    });
  } else {
    // No-shift kinds — single banner with generic label, matches the
    // pre-rewrite layout.
    const fallbackLabel = args.kind === "day_off"
      ? "วันหยุดของพี่"
      : `วันลา${args.leaveTypeLabel ? " · " + args.leaveTypeLabel : ""}`;
    shiftBlocks.push({
      type: "box", layout: "vertical",
      paddingAll: "16px", margin: "md",
      backgroundColor: bannerColor + "20",
      cornerRadius: "10px",
      borderWidth: "1px",
      borderColor: bannerColor,
      contents: [
        {
          type: "text",
          text: fallbackLabel,
          size: "lg", color: bannerColor, weight: "bold",
          wrap: true, align: "center"
        }
      ]
    });
  }

  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "20px",
      contents: [
        // Top-row labels — owner direction 2026-05-27: right-side
        // label now reads "ทักทายจากน้องฮูก" (was "น้องฮูก · ผู้ช่วย")
        // — clearer about what the card IS, not who it's from.
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xs", weight: "bold", flex: 1 },
            { type: "text", text: "ทักทายจากน้องฮูก", color: "#cbd5e1", size: "xs", align: "end", flex: 1 }
          ]
        },
        // Date — owl emoji removed (owner asked to cut decorative
        // cartoon glyphs from the card); plain date in white bold
        // looks cleaner against the navy header.
        {
          type: "text",
          text: args.dateLabel,
          color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md"
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "24px",
      contents: [
        // Greeting line — name attached directly to "พี่" via the
        // greeting picker so the wrapping reads as one cohesive
        // phrase ("สวัสดีครับพี่เกฟ น้องฮูกแวะมาทักทาย").
        {
          type: "text",
          text: greeting,
          size: "md", color: COLOR_TEXT_DARK, weight: "bold", wrap: true
        },
        // Branch pill
        {
          type: "text",
          text: args.branchName,
          size: "sm", color: COLOR_TEXT_MUTED, wrap: true, margin: "xs"
        },
        // Shift blocks (built above) — green-banner + code+time +
        // description per shift for the work kind, single banner
        // for day_off / on_leave.
        ...shiftBlocks,
        // Closing line
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text",
          text: closing,
          size: "sm", color: COLOR_TEXT_MUTED, wrap: true, margin: "md"
        }
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };

  const altText = args.kind === "work"
    ? `เวรประจำวัน · ${args.branchName} · ${args.dateLabel}`
    : args.kind === "day_off"
      ? `วันหยุดของพี่ · ${args.dateLabel}`
      : `วันลา · ${args.leaveTypeLabel ?? ""} · ${args.dateLabel}`;
  return { type: "flex", altText, contents: bubble };
}

// ── PERSONA: leave-approval workflow notifications (2026-05) ──────
//
// One Flex card per event. Six audiences map to four events:
//   submitted   → primary (action) + backup (FYI)
//   approved    → requester (good news) + backup (close-the-loop)
//   rejected    → requester (bad news) + backup (close-the-loop)
//   escalated   → new primary (action) + old primary (you missed)
//
// Each card uses the owl mascot + warm copy. Body shows requester
// name + leave type + date range. A CTA button deep-links the
// recipient to the approver page (primary/backup recipients) or to
// the staff leave page (requester recipients).

export type ApprovalNotifyArgs = {
  /** "submitted_primary" — A receives "you must approve"
   *  "submitted_backup"  — B receives "FYI A is handling"
   *  "approved_requester"
   *  "approved_backup"
   *  "rejected_requester"
   *  "rejected_backup"
   *  "escalated_new"      — B receives "now your turn"
   *  "escalated_old"      — A receives "you missed it" */
  variant:
    | "submitted_primary" | "submitted_backup"
    | "approved_requester" | "approved_backup"
    | "rejected_requester" | "rejected_backup"
    | "escalated_new" | "escalated_old";
  /** Recipient's name for the personalised greeting. Prefers nickname. */
  recipientName: string;
  /** Requester display label — "นายสมชาย (ปุย)" — pre-formatted. */
  requesterLabel: string;
  /** "ลาป่วย" / "ลากิจ" / etc., already localised. */
  leaveTypeLabel: string;
  /** YYYY-MM-DD strings — same as DB. */
  dateFrom: string;
  dateTo: string;
  /** Optional free-text reason from the request. */
  reason: string | null;
  /** Decision note when event is approved/rejected. */
  decisionNote?: string | null;
  /** Deep link CTA — UI page the recipient should open. */
  ctaUrl: string;
  ctaLabel: string;
  headerColor?: string | null;
};

function approvalBannerFor(variant: ApprovalNotifyArgs["variant"]): {
  color: string; icon: string; title: string; subtitle: string;
} {
  switch (variant) {
    case "submitted_primary":
      return {
        color: "#0ea5e9", icon: "📩",
        title: "มีคำขอลาใหม่รอพี่อนุมัติ",
        subtitle: "น้องฮูกส่งต่อมาให้พี่ดูครับ"
      };
    case "submitted_backup":
      return {
        color: "#94a3b8", icon: "👀",
        title: "FYI — มีคำขอลาเข้ามาในระบบ",
        subtitle: "น้องส่งให้หัวหน้าตรงดูก่อน พี่เป็น backup ในสาย"
      };
    case "approved_requester":
      return {
        color: "#10b981", icon: "✓",
        title: "คำขอลาของพี่ได้รับการอนุมัติแล้ว",
        subtitle: "น้องฮูกขอแสดงความยินดี ขอให้พักผ่อนเยอะๆ"
      };
    case "approved_backup":
      return {
        color: "#10b981", icon: "✓",
        title: "คำขอลาได้รับการอนุมัติแล้ว",
        subtitle: "ไม่ต้องดำเนินการอะไรเพิ่ม น้องแจ้งให้ทราบเฉยๆ"
      };
    case "rejected_requester":
      return {
        color: "#dc2626", icon: "✗",
        title: "คำขอลาของพี่ไม่ผ่านการอนุมัติ",
        subtitle: "ติดต่อหัวหน้าโดยตรงเพื่อสอบถามเพิ่มเติม"
      };
    case "rejected_backup":
      return {
        color: "#dc2626", icon: "✗",
        title: "คำขอลาถูกปฏิเสธโดยหัวหน้าตรง",
        subtitle: "ไม่ต้องดำเนินการอะไรเพิ่ม น้องแจ้งให้ทราบเฉยๆ"
      };
    case "escalated_new":
      return {
        color: "#f59e0b", icon: "⏰",
        title: "ถึงคิวพี่อนุมัติคำขอนี้แล้ว",
        subtitle: "หัวหน้าตรงไม่ได้ดำเนินการในเวลา ตอนนี้เป็นหน้าที่ของพี่ครับ"
      };
    case "escalated_old":
      return {
        color: "#94a3b8", icon: "⏰",
        title: "คำขอนี้ถูกส่งต่อให้หัวหน้าของพี่แล้ว",
        subtitle: "เกินเวลาดำเนินการที่กำหนด ระบบส่งต่อตามสายอัตโนมัติ"
      };
  }
}

function approvalGreetingTh(recipientName: string, variant: ApprovalNotifyArgs["variant"]): string {
  // Same hash trick used in shift greeter — but keyed by variant so
  // sequential events on the same request get distinct openers.
  // 2026-05-27 — attach name DIRECTLY to "พี่" with no space, matching
  // the shift card. Blank recipientName degrades gracefully to plain
  // "สวัสดีครับพี่" (polite + grammatical Thai opener).
  let h = 0;
  for (let i = 0; i < variant.length; i++) {
    h = ((h << 5) - h + variant.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h);
  const POOL = [
    "สวัสดีครับพี่",
    "หวัดดีครับพี่",
    "ขออภัยที่รบกวนพี่"
  ];
  return `${POOL[idx % POOL.length]}${recipientName || ""}`;
}

export function personaApprovalNotifyFlex(args: ApprovalNotifyArgs): LineFlexMessage {
  const banner = approvalBannerFor(args.variant);
  const greeting = approvalGreetingTh(args.recipientName, args.variant);
  const headerColor = args.headerColor || COLOR_INK_700;
  const dateLine = args.dateFrom === args.dateTo
    ? `${args.dateFrom}`
    : `${args.dateFrom} ถึง ${args.dateTo}`;

  const detailRows: Array<Record<string, unknown>> = [
    {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "text", text: "ผู้ขอลา", size: "sm", color: COLOR_LABEL, flex: 3 },
        { type: "text", text: args.requesterLabel, size: "sm", color: COLOR_TEXT_DARK,
          weight: "bold", flex: 5, align: "end", wrap: true }
      ]
    },
    {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "text", text: "ประเภท", size: "sm", color: COLOR_LABEL, flex: 3 },
        { type: "text", text: args.leaveTypeLabel, size: "sm", color: COLOR_TEXT_DARK,
          weight: "bold", flex: 5, align: "end", wrap: true }
      ]
    },
    {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "text", text: "ช่วงวัน", size: "sm", color: COLOR_LABEL, flex: 3 },
        { type: "text", text: dateLine, size: "sm", color: COLOR_TEXT_DARK,
          weight: "bold", flex: 5, align: "end", wrap: true }
      ]
    }
  ];

  // Reason / decision note — appended as a soft block when present.
  const extraBlocks: Array<Record<string, unknown>> = [];
  if (args.reason && args.reason.trim()) {
    extraBlocks.push(
      { type: "separator", margin: "md", color: COLOR_DIVIDER },
      {
        type: "box", layout: "vertical", spacing: "xs", margin: "md",
        contents: [
          { type: "text", text: "เหตุผล", size: "xs", color: COLOR_LABEL },
          { type: "text", text: args.reason, size: "sm", color: COLOR_TEXT_DARK, wrap: true }
        ]
      }
    );
  }
  if (args.decisionNote && args.decisionNote.trim()) {
    extraBlocks.push(
      { type: "separator", margin: "md", color: COLOR_DIVIDER },
      {
        type: "box", layout: "vertical", spacing: "xs", margin: "md",
        contents: [
          { type: "text", text: "หมายเหตุการตัดสินใจ", size: "xs", color: COLOR_LABEL },
          { type: "text", text: args.decisionNote, size: "sm", color: COLOR_TEXT_DARK, wrap: true }
        ]
      }
    );
  }

  const bubble = {
    type: "bubble",
    size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "20px",
      contents: [
        // Approval card header — matches the shift-reminder card
        // structure since 2026-05-27 (right label = "ทักทายจาก
        // น้องฮูก", no owl emoji in the title row). Owner direction:
        // dial back cartoon glyphs; the navy header + bold title
        // carries enough weight already.
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS · PERSONA", color: COLOR_BRAND_LIGHT, size: "xs", weight: "bold", flex: 1 },
            { type: "text", text: "ทักทายจากน้องฮูก", color: "#cbd5e1", size: "xs", align: "end", flex: 1 }
          ]
        },
        {
          type: "text", text: "เรื่องการลา",
          color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md"
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      paddingAll: "24px",
      contents: [
        // Greeting
        { type: "text", text: greeting, size: "md", color: COLOR_TEXT_DARK, weight: "bold", wrap: true },
        // Banner — title + subtitle inside the kind-coloured chip
        {
          type: "box", layout: "vertical",
          paddingAll: "16px", margin: "md",
          backgroundColor: banner.color + "20",
          cornerRadius: "10px",
          borderWidth: "1px",
          borderColor: banner.color,
          contents: [
            {
              type: "text",
              text: `${banner.icon} ${banner.title}`,
              size: "lg", color: banner.color, weight: "bold", wrap: true, align: "center"
            },
            {
              type: "text",
              text: banner.subtitle,
              size: "sm", color: COLOR_TEXT_DARK, wrap: true, align: "center", margin: "xs"
            }
          ]
        },
        // Detail rows
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: detailRows },
        // Reason / decision note
        ...extraBlocks
      ]
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR_BRAND,
          height: "sm",
          action: { type: "uri", label: args.ctaLabel, uri: args.ctaUrl }
        }
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" },
      footer: { backgroundColor: "#ffffff", separator: true, separatorColor: COLOR_DIVIDER }
    }
  };

  return {
    type: "flex",
    altText: `${banner.title} · ${args.requesterLabel} · ${args.leaveTypeLabel}`,
    contents: bubble
  };
}

export function dailyAttendanceSummaryFlex(
  args: DailyAttendanceSummaryArgs
): LineFlexMessage {
  const dateStr = formatThaiDate(args.reportDate);
  const headerColor = args.headerColor || COLOR_INK_700;

  const onTime = args.rows.filter((r) => r.category === "on_time");
  const late = args.rows.filter((r) => r.category === "late");
  const onLeave = args.rows.filter((r) => r.category === "on_leave");
  const absent = args.rows.filter((r) => r.category === "absent");
  const notYet = args.rows.filter((r) => r.category === "not_yet");

  // Section helpers — keep visual rhythm consistent across the four
  // buckets. Each section has a coloured header line + an indented
  // list of names. When the bucket is empty we render an em dash so
  // executives can still see the section exists.
  function sectionHeader(
    icon: string, label: string, color: string, count: number
  ): Record<string, unknown> {
    return {
      type: "text",
      text: `${icon} ${label} (${count} คน)`,
      size: "xs",
      color,
      weight: "bold",
      margin: "md"
    };
  }

  function nameRow(
    name: string, trailing?: string
  ): Record<string, unknown> {
    if (!trailing) {
      return {
        type: "text", text: name,
        size: "sm", color: COLOR_TEXT_DARK,
        wrap: true, margin: "xs"
      };
    }
    return {
      type: "box", layout: "horizontal", spacing: "sm", margin: "xs",
      contents: [
        {
          type: "text", text: name,
          size: "sm", color: COLOR_TEXT_DARK, weight: "bold",
          flex: 5, wrap: true
        },
        {
          type: "text", text: trailing,
          size: "xs", color: COLOR_TEXT_MUTED,
          flex: 5, align: "end", wrap: true
        }
      ]
    };
  }

  function sectionBody(
    rows: DailySummaryFlexRow[],
    trailingFor: (r: DailySummaryFlexRow) => string | undefined
  ): Record<string, unknown> {
    if (rows.length === 0) {
      return {
        type: "text", text: "—",
        size: "sm", color: COLOR_TEXT_MUTED, margin: "sm"
      };
    }
    return {
      type: "box", layout: "vertical", spacing: "xs", margin: "sm",
      contents: rows.map((r) =>
        nameRow(nameWithPrefix(r.titlePrefix ?? null, r.displayName), trailingFor(r))
      )
    };
  }

  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 0 },
            { type: "text", text: "PERSONA • รายงานเข้างาน", color: "#cbd5e1", size: "xxs", align: "end", flex: 1, wrap: true }
          ]
        },
        {
          type: "box", layout: "baseline", margin: "md",
          contents: [
            { type: "text", text: "สรุปการเข้างานประจำวัน", color: "#ffffff", size: "lg", weight: "bold", wrap: true }
          ]
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: dateStr, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs", wrap: true },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },

        // ── มาตรงเวลา ──
        sectionHeader("✓", "มาตรงเวลา", "#047857", onTime.length),
        sectionBody(onTime, (r) => r.inTs ? `เข้า ${fmtBkkTime(r.inTs)}` : undefined),

        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // ── มาสาย ──
        sectionHeader("⚠", "มาสาย", "#b45309", late.length),
        sectionBody(late, (r) =>
          r.inTs
            ? `เข้า ${fmtBkkTime(r.inTs)} · สาย ${r.minutesLate} นาที`
            : `สาย ${r.minutesLate} นาที`
        ),

        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // ── ลางาน ──
        sectionHeader("📅", "ลางาน (อนุมัติแล้ว)", "#1d4ed8", onLeave.length),
        sectionBody(onLeave, (r) => leaveTypeLabelTh(r.leaveType)),

        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // ── ยังไม่ถึงเวลาเข้างาน (2026-05) ──
        sectionHeader("⏰", "ยังไม่ถึงเวลาเข้างาน", "#475569", notYet.length),
        sectionBody(notYet, () => undefined),

        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        // ── ขาดงาน ──
        sectionHeader("✗", "ขาดงาน", "#b91c1c", absent.length),
        sectionBody(absent, () => undefined)
      ]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };

  return {
    type: "flex",
    altText:
      `สรุปเข้างาน ${args.branchName} ${dateStr} · ตรงเวลา ${onTime.length} · ` +
      `สาย ${late.length} · ลา ${onLeave.length} · รอ ${notYet.length} · ขาด ${absent.length}`,
    contents: bubble
  };
}

// ── Disciplinary warning Flex (TC-P §8) ──────────────────────────
//
// One Flex card pushed to the recipient staff member when a warning
// is issued. Tone is serious without being aggressive — title +
// severity badge + a 1-line summary, and a CTA that takes them to
// the staff page where they must PIN-acknowledge. We deliberately
// don't include the full body in the card so the staff has to land
// on the in-app page (where we log the view + the auto-ack timer
// runs).

export type DisciplinaryFlexArgs = {
  branchName: string;
  recipientName: string;
  severity: "verbal" | "written_1" | "written_2" | "final";
  title: string;
  refNo: string | null;
  staffUrl: string;
  headerColor?: string | null;
};

export function disciplinaryWarningFlex(args: DisciplinaryFlexArgs): LineFlexMessage {
  // Severity tag — using rose for all to keep the gravity consistent;
  // text differs so the staff still sees which level they got.
  const severityTh =
    args.severity === "verbal"     ? "ตักเตือนด้วยวาจา" :
    args.severity === "written_1"  ? "ตักเตือนเป็นลายลักษณ์อักษร ครั้งที่ 1" :
    args.severity === "written_2"  ? "ตักเตือนเป็นลายลักษณ์อักษร ครั้งที่ 2" :
    "หนังสือเตือนครั้งสุดท้าย";
  const headerColor = args.headerColor || "#7f1d1d"; // rose-900
  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: "#fecdd3", size: "xxs", weight: "bold", flex: 1 },
            { type: "text", text: "PERSONA • วินัย", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
          ]
        },
        {
          type: "text", text: "⚠ หนังสือตักเตือนทางวินัย",
          color: "#ffffff", size: "lg", weight: "bold", margin: "md", wrap: true
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        { type: "text", text: args.recipientName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: args.branchName, size: "xs", color: COLOR_TEXT_MUTED, margin: "xs" },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text", text: severityTh,
          size: "xs", color: "#b91c1c", weight: "bold", margin: "md"
        },
        {
          type: "text", text: args.title,
          size: "sm", color: COLOR_TEXT_DARK, weight: "bold", wrap: true, margin: "xs"
        },
        ...(args.refNo ? [{
          type: "text", text: `#${args.refNo}`,
          size: "xs", color: COLOR_TEXT_MUTED, margin: "sm", weight: "bold"
        }] : []),
        {
          type: "text",
          text: "กรุณาเข้าระบบเพื่ออ่านรายละเอียดและกดรับทราบด้วยรหัส PIN ของคุณ",
          size: "xs", color: COLOR_LABEL, wrap: true, margin: "md"
        }
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px",
      contents: [{
        type: "button", style: "primary", color: "#b91c1c",
        action: { type: "uri", label: "เปิดอ่าน + กดรับทราบ", uri: args.staffUrl }
      }]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };
  return {
    type: "flex",
    altText: `⚠ หนังสือเตือน · ${args.title} · ${args.recipientName}`,
    contents: bubble
  };
}

// ── Resignation unlocked notice (2026-05-27) ─────────────────────
//
// When admin opens a staff's "สิทธิ์ยื่นลาออก" via the resignation
// admin page, the staff gets this DM through the platform OA. Short
// + warm — it just lets them know the gate is open + links to the
// form. Same giga + owl-voice contract as other persona cards.

export type ResignationUnlockedFlexArgs = {
  /** Recipient nickname (preferred) or display_name. */
  recipientName: string;
  /** Admin who flipped the toggle — printed so the staff knows who
   *  to talk to if they think it's a mistake. */
  unlockedByName: string;
  /** Body paragraph — owner-authored at /admin/system-settings. The
   *  caller already substituted any `{ADMIN}` placeholder before
   *  passing it here. Empty/null = use the built-in default body. */
  bodyMessage?: string | null;
  /** Deep link to /staff/persona/resignation. */
  resignationUrl: string;
  /** Branch CI colour for the header bar. */
  headerColor?: string | null;
};

const DEFAULT_RESIGNATION_UNLOCK_BODY =
  "{ADMIN} เพิ่งเปิดสิทธิ์ยื่นใบลาออกให้พี่แล้วครับ — ถ้าพี่ต้องการยื่น สามารถเข้าไปกรอกแบบฟอร์มได้ที่ปุ่มด้านล่าง";

/** Apply the {ADMIN} placeholder substitution. Exported so the
 *  unlock endpoint (and any other caller) reuses the exact same
 *  rule + default fallback. */
export function renderResignationUnlockBody(
  template: string | null | undefined,
  adminName: string
): string {
  const t = (template ?? "").trim() || DEFAULT_RESIGNATION_UNLOCK_BODY;
  return t.replace(/\{ADMIN\}/g, adminName);
}

export function personaResignationUnlockedFlex(
  args: ResignationUnlockedFlexArgs
): LineFlexMessage {
  const headerColor = args.headerColor || COLOR_INK_700;
  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS · PERSONA", color: COLOR_BRAND_LIGHT, size: "xs", weight: "bold", flex: 1 },
            { type: "text", text: "ทักทายจากน้องฮูก", color: "#cbd5e1", size: "xs", align: "end", flex: 1 }
          ]
        },
        {
          type: "text", text: "เปิดสิทธิ์ยื่นลาออกแล้ว",
          color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md"
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "24px",
      contents: [
        {
          type: "text",
          text: `สวัสดีครับพี่${args.recipientName ? args.recipientName : ""}`,
          size: "md", color: COLOR_TEXT_DARK, weight: "bold", wrap: true
        },
        {
          type: "text",
          // bodyMessage has already been placeholder-substituted by
          // the caller (renderResignationUnlockBody). Falls back to
          // the default template + the admin name if not supplied.
          text: (args.bodyMessage && args.bodyMessage.trim())
            || DEFAULT_RESIGNATION_UNLOCK_BODY.replace(/\{ADMIN\}/g, args.unlockedByName),
          size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "sm"
        },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text",
          text: "หากเปลี่ยนใจไม่ต้องการยื่น ก็ไม่ต้องทำอะไรครับ สิทธิ์นี้จะอยู่จนกว่าพี่จะกรอกหรือแอดมินจะปิดอีกครั้ง",
          size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "sm"
        }
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px",
      contents: [{
        type: "button", style: "primary", color: headerColor,
        action: { type: "uri", label: "เปิดแบบฟอร์มยื่นลาออก", uri: args.resignationUrl }
      }]
    },
    styles: { header: { backgroundColor: headerColor } }
  };
  return {
    type: "flex",
    altText: `เปิดสิทธิ์ยื่นลาออก · ${args.recipientName}`,
    contents: bubble
  };
}

// ── Resignation TAKE notification ─────────────────────────────────
//
// Fires when the nightly cron flips a user's status to 'resigned'
// because their approved resignation's proposed_last_day passed.
// Short, gentle, owl-voiced — confirms the change and points the
// staff at the admin if they need to come back to work.

export type ResignationTakenFlexArgs = {
  recipientName: string;  // e.g. "ตูน" or display_name fallback
  lastDay: string;        // YYYY-MM-DD — the date they worked last
  /** Optional — when set we render a "ติดต่อแอดมิน: <name>" line.
   *  Caller pulls the branch admin off the user's primary branch. */
  contactAdminName?: string | null;
  headerColor?: string | null;
};

export function personaResignationTakenFlex(
  args: ResignationTakenFlexArgs
): LineFlexMessage {
  const headerColor = args.headerColor || COLOR_INK_700;
  const friendlyLastDay = formatThaiDate(args.lastDay);
  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS · PERSONA", color: COLOR_BRAND_LIGHT, size: "xs", weight: "bold", flex: 1 },
            { type: "text", text: "ทักทายจากน้องฮูก", color: "#cbd5e1", size: "xs", align: "end", flex: 1 }
          ]
        },
        {
          type: "text", text: "ขอบคุณสำหรับการทำงานที่ผ่านมาครับ",
          color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md"
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "24px",
      contents: [
        {
          type: "text",
          text: `สวัสดีครับพี่${args.recipientName}`,
          size: "md", color: COLOR_TEXT_DARK, weight: "bold", wrap: true
        },
        {
          type: "text",
          text: `วันสุดท้ายที่พี่ทำงานคือ ${friendlyLastDay} — ตั้งแต่วันนี้ระบบจะปิดบัญชีของพี่อัตโนมัติครับ`,
          size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "sm"
        },
        { type: "separator", margin: "md", color: COLOR_DIVIDER },
        {
          type: "text",
          text: "ระบบจะเก็บข้อมูลของพี่ไว้ 1 ปี ก่อนลบอัตโนมัติ ตามนโยบายความเป็นส่วนตัว",
          size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "sm"
        },
        ...(args.contactAdminName ? [{
          type: "text",
          text: `หากต้องการกลับเข้าทำงานหรือสอบถาม ติดต่อ: ${args.contactAdminName}`,
          size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "xs"
        }] : []),
        {
          type: "text",
          text: "ขอให้พี่โชคดีในเส้นทางใหม่ครับ น้องฮูก 🦉",
          size: "xs", color: COLOR_TEXT_MUTED, wrap: true, margin: "md"
        }
      ]
    },
    styles: { header: { backgroundColor: headerColor } }
  };
  return {
    type: "flex",
    altText: `บัญชีของคุณถูกปิดอัตโนมัติ · ${args.recipientName}`,
    contents: bubble
  };
}

// ── Roster published / updated Flex (TC-R) ────────────────────────
//
// One-line announcement card the supervisor sends when the monthly
// roster is ready, or when it gets revised post-publish. The card
// links staff back to /staff/persona/calendar (or the LIFF URL) so
// they can read their own assignments. Intentionally minimal — the
// full schedule lives in the app, not in the chat.

export type RosterPublishedFlexArgs = {
  branchName: string;
  yearMonth: string;        // YYYY-MM Bangkok
  kind: "publish" | "edit"; // first publish vs post-edit notice
  note: string | null;      // optional change summary the supervisor types in
  calendarUrl: string;      // deep link to /staff/persona/calendar
  headerColor?: string | null;
};

export function rosterPublishedFlex(args: RosterPublishedFlexArgs): LineFlexMessage {
  const headerColor = args.headerColor || COLOR_INK_700;
  // Convert YYYY-MM → "พฤษภาคม" so the title reads natural Thai
  // instead of the numeric "2026-05". Falls back to the raw value
  // when the input doesn't parse — defensive against legacy callers.
  const TH_MONTHS = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
  ];
  const ymParts = args.yearMonth.split("-");
  const monthIdx = parseInt(ymParts[1] ?? "", 10) - 1;
  const monthName = monthIdx >= 0 && monthIdx < 12
    ? TH_MONTHS[monthIdx]
    : args.yearMonth;
  // Owner asked for plain-text copy without emoji decoration — the
  // RESERVA/PERSONA pill in the header already telegraphs context.
  const title = args.kind === "publish"
    ? `ตารางเดือน${monthName} พร้อมแล้ว`
    : `ตารางเดือน${monthName} ถูกแก้ไข`;
  const subtitle = args.kind === "publish"
    ? `ทางบริษัทได้เผยแพร่ตารางปฏิบัติงานประจำเดือน${monthName}แล้ว หากมีข้อสงสัย หรือต้องการเปลี่ยนแปลงตารางการทำงาน ให้ติดต่อกับหัวหน้างานของคุณ`
    : `ทางบริษัทได้ปรับปรุงตารางปฏิบัติงานประจำเดือน${monthName} กรุณาตรวจสอบอีกครั้ง หากมีข้อสงสัย หรือต้องการเปลี่ยนแปลงตารางการทำงาน ให้ติดต่อกับหัวหน้างานของคุณ`;
  const bubble = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: headerColor, paddingAll: "20px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "IKIGAI OS", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1 },
            { type: "text", text: "PERSONA • ROSTER", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
          ]
        },
        {
          type: "text", text: title, color: "#ffffff",
          size: "lg", weight: "bold", wrap: true, margin: "md"
        }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      contents: [
        { type: "text", text: args.branchName, weight: "bold", size: "md", color: COLOR_TEXT_DARK, wrap: true },
        { type: "text", text: subtitle, size: "sm", color: COLOR_TEXT_MUTED, wrap: true, margin: "xs" },
        ...(args.note ? [
          { type: "separator", margin: "md", color: COLOR_DIVIDER },
          { type: "text", text: "หมายเหตุ", size: "xs", color: COLOR_LABEL, margin: "sm" },
          { type: "text", text: args.note, size: "sm", color: COLOR_TEXT_DARK, wrap: true, margin: "xs" }
        ] : [])
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px",
      contents: [{
        type: "button", style: "primary",
        color: COLOR_BRAND,
        // Short English label per owner request — "Schedule" reads
        // unambiguously at a glance even for staff who skim the card.
        action: { type: "uri", label: "Schedule", uri: args.calendarUrl }
      }]
    },
    styles: {
      header: { backgroundColor: headerColor },
      body: { backgroundColor: "#ffffff" }
    }
  };
  return {
    type: "flex",
    altText: `${title} · ${args.branchName}`,
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

/** Route a staff-facing Flex notification using the cross-branch
 *  multi-OA strategy:
 *
 *    routing="global" — push via the IKIGAI OS LINE OA to the
 *      shared cross-branch staff group. Used for PERSONA
 *      notifications (daily reports, edit requests, decisions) so
 *      staff from every branch see them in one chat. The branch
 *      identity is carried in the Flex body + header colour, not
 *      in the OA sending the message.
 *
 *    routing="branch" — push via the branch's own OA to the
 *      branch's staff group. Used for booking-related notifications
 *      where each branch wants its own dedicated group.
 *
 *  Fallback: when routing="global" but system_settings hasn't been
 *  configured yet (no global token or no global group ID), we drop
 *  back to branch routing so adoption can roll out without a hard
 *  cutover. Once admin sets the global OA at /admin/system-settings,
 *  PERSONA notifications auto-switch to the shared group on the
 *  next push.
 *
 *  Fire-and-forget — same contract as notifyDailyReport / notifyStaff. */
export async function notifyToStaffGroup(
  branch: Branch,
  flex: LineFlexMessage,
  routing: "global" | "branch" = "global"
): Promise<void> {
  if (routing === "global") {
    // The IKIGAI OS LINE OA credentials live on messaging_channels
    // (code='ikigai-os') — that's where /admin/persona/messaging
    // writes them via setPlatformChannel(). The cross-branch group
    // id stays on system_settings because it's a routing decision
    // (which group to push into), not a channel credential.
    //
    // Earlier code read the token from system_settings.global_line_
    // channel_token, but the new admin UI never writes there. The
    // mismatch meant tokens set via /admin/persona/messaging were
    // ignored and notifications silently fell back to per-branch
    // routing (and silently failed when branches had no staff group
    // configured either).
    const platform = getPlatformChannel();
    const sys = getSystemSettings();
    // Token preference: messaging_channels.platform first, then the
    // legacy system_settings.global_line_channel_token as a fallback
    // so installs that still use the super-admin page keep working.
    const token = platform?.channel_token ?? decryptSecret(sys.global_line_channel_token) ?? null;
    const groupId = sys.global_staff_group_id ?? null;
    if (token && groupId) {
      const result = await sendLinePush(token, {
        to: groupId,
        messages: [flex]
      });
      // Surface failures so callers that await this (e.g. the manual
      // resend endpoint) can return a real error to the UI. The
      // auto-flow's .catch(...) wrapper still swallows it for
      // fire-and-forget behaviour.
      if (!result.ok) {
        throw new Error(
          `LINE push failed (HTTP ${result.status}): ${result.error ?? "unknown"}`
        );
      }
      return;
    }
    // Global OA not configured yet — fall through to branch routing.
  }
  // Branch routing — delegate to the existing notifyDailyReport
  // helper which already handles the staff_group_id / per-user
  // fallback chain.
  return notifyDailyReport(branch, flex);
}

/** Push an INVENTA notification to the branch's own LINE group
 *  (branches.inventa_group_id) via the platform OA. When the branch
 *  hasn't configured its own group, falls back to notifyToStaffGroup
 *  (the shared global group) so nothing is silently dropped.
 *  (owner 2026-06-06 — clinic-specific stock notifications.) */
export async function notifyInventaGroup(
  branch: Branch & { inventa_group_id?: string | null },
  flex: LineFlexMessage
): Promise<void> {
  const groupId = branch.inventa_group_id?.trim() || null;
  if (groupId) {
    const platform = getPlatformChannel();
    const token = platform?.channel_token?.trim() ?? null;
    if (token) {
      try {
        const res = await sendLinePush(token, { to: groupId, messages: [flex] });
        if (res.ok) return;
        console.warn(`[inventa-notify] LINE push rejected: ${res.status} ${res.error ?? ""}`);
      } catch (e) {
        console.warn("[inventa-notify] push threw:", e);
      }
    }
    // Token missing or push failed → fall through to the global group.
  }
  return notifyToStaffGroup(branch, flex, "global");
}

/** Push a notification to the HR group (system_settings.recruita_exec_group_id).
 *  Used by PERSONA HR notifications: attendance summaries, leave/shift-change
 *  request alerts, and the pending-requests digest. Shares the same IKIGAI OS
 *  platform OA as RECRUITA exec pushes — both routes go to "IKIGAI RECRUIT x HR".
 *  Best-effort: silently skips when the group or OA isn't configured. */
export async function notifyToHrGroup(
  flex: LineFlexMessage
): Promise<void> {
  const sys = getSystemSettings();
  const groupId = sys.recruita_exec_group_id?.trim() ?? null;
  if (!groupId) {
    console.info("[hr-notify] skipped: recruita_exec_group_id not set");
    return;
  }
  const platform = getPlatformChannel();
  const token = platform?.channel_token?.trim() ?? null;
  if (!token) {
    console.info("[hr-notify] skipped: IKIGAI OS platform OA not configured");
    return;
  }
  try {
    const res = await sendLinePush(token, { to: groupId, messages: [flex] });
    if (!res.ok) {
      console.warn(`[hr-notify] LINE push rejected: ${res.status} ${res.error ?? ""}`);
    }
  } catch (e) {
    console.warn("[hr-notify] push threw:", e);
  }
}
