// RECRUITA-side LINE OA messaging helpers.
//
// Mirrors the IKIGAI OS (platform) push pattern but routes through
// the dedicated "IKIGAI Recruit" channel so candidate-facing notifs
// don't bleed into the staff group + we can rate-limit / quota them
// independently.
//
// Two scenarios surface here:
//   1. Stage-change push — called from /api/recruita/applications/[id]/stage
//      whenever an admin moves a card. Sends a Flex card to the
//      candidate's linked LINE userId (set via webhook follow flow).
//   2. Send Flex card by application id — generic helper the bridge
//      ("รับเข้าทำงาน") and any future Phase 1f workflows can use.
//
// All public functions are no-ops when the channel isn't fully
// configured (channel_token + channel_secret + a LINE userId on the
// candidate). Caller never has to guard.

import { getDb, getSystemSettings } from "./db";
import { sendLinePush } from "./line";
import { getRecruitaChannel, getPlatformChannel, isChannelReady } from "./messaging-channels";
import { STAGE_META, type ApplicationStage } from "./recruita";
import { formatApplicationNo, formatLongDate } from "./time";

// Minimal local mirror of line.ts's LinePushPayload — kept local so
// we don't have to widen the line.ts module surface for one caller.
type LineMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

// IKIGAI OS Portal LIFF — taps from the exec group open this, which
// auto-logs-in the admin via LINE (see /persona/portal) then redirects
// to `next`. So "ตรวจสอบใบสมัคร" lands them straight on the application.
const PORTAL_LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID_PORTAL ?? "";

/** URL for the exec "ตรวจสอบใบสมัคร" button. Routes through the IKIGAI OS
 *  Portal LIFF (auto-login) when configured, then deep-links to the
 *  application detail page. Falls back to the plain admin URL (which
 *  bounces through /login if there's no session) when the portal LIFF
 *  id isn't set. */
function reviewUrl(applicationId: number): string {
  const target = `/admin/recruita/applications/${applicationId}`;
  return PORTAL_LIFF_ID
    ? `https://liff.line.me/${PORTAL_LIFF_ID}?next=${encodeURIComponent(target)}`
    : `${PUBLIC_BASE}${target}`;
}

// IKIGAI OS CI palette — keep in sync with tailwind.config.ts + line.ts
// so RECRUITA cards look like the rest of the system (PERSONA / RESERVA).
const COLOR_INK = "#281a0e";
const COLOR_BRAND = "#a06820";
const COLOR_BRAND_LIGHT = "#d6a14d";
const COLOR_TEXT_DARK = "#1a1a2e";
const COLOR_LABEL = "#64748b";
const COLOR_MUTED = "#94a3b8";
const COLOR_DIVIDER = "#e2e8f0";

/** Navy header with the "IKIGAI Recruit · RECRUITA" brand bar, matching
 *  the PERSONA/RESERVA Flex cards. */
function brandHeader(title: string, subtitle: string): Record<string, unknown> {
  return {
    type: "box", layout: "vertical", backgroundColor: COLOR_INK,
    paddingAll: "20px", paddingTop: "18px", paddingBottom: "18px",
    contents: [
      {
        type: "box", layout: "horizontal",
        contents: [
          { type: "text", text: "IKIGAI RECRUIT", color: COLOR_BRAND_LIGHT, size: "xxs", weight: "bold", flex: 1 },
          { type: "text", text: "RECRUITA", color: "#cbd5e1", size: "xxs", align: "end", flex: 1 }
        ]
      },
      { type: "text", text: title, color: "#ffffff", size: "lg", weight: "bold", margin: "md", wrap: true },
      { type: "text", text: subtitle, color: COLOR_MUTED, size: "xs", margin: "xs", wrap: true }
    ]
  };
}

/** A label : value row for the white card body. */
function infoRow(label: string, value: string): Record<string, unknown> {
  return {
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: COLOR_LABEL, flex: 4 },
      { type: "text", text: value, size: "sm", color: COLOR_TEXT_DARK, flex: 6, weight: "bold", align: "end", wrap: true }
    ]
  };
}

/** Push a Flex/text message bundle to a candidate. Skips silently
 *  when the OA isn't configured. Returns the same shape sendLinePush()
 *  does so callers can log + report. */
export async function pushToCandidate(
  lineUserId: string,
  messages: LineMessage[]
): Promise<{ ok: boolean; skipped?: true; status?: number; error?: string }> {
  const ch = getRecruitaChannel();
  if (!ch || !ch.channel_token) {
    return { ok: false, skipped: true };
  }
  if (!lineUserId) return { ok: false, skipped: true };
  return sendLinePush(ch.channel_token, {
    to: lineUserId,
    messages
  });
}

/** Per-stage copy. Each entry returns the headline + accent colour
 *  the Flex card uses. Keep the strings owner-editable later
 *  (Phase 1f notification customizer) — for v1 these are inline. */
type StageCopy = { headline: string; tone: string; cta?: { label: string; url: string } };

function stageCopy(stage: ApplicationStage, positionTitle: string): StageCopy {
  const candidates: Record<ApplicationStage, StageCopy> = {
    applied: {
      headline: "ระบบได้รับใบสมัครของคุณแล้ว",
      tone: "#3b82f6"
    },
    screening: {
      headline: `ใบสมัครของคุณผ่านการคัดกรองเบื้องต้น\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#0ea5e9"
    },
    interview: {
      headline: `ทีมงานต้องการเชิญคุณมาสัมภาษณ์\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#f59e0b"
    },
    health_check: {
      headline: `ผ่านการสัมภาษณ์แล้ว — ขั้นตอนต่อไปคือตรวจสุขภาพ\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#14b8a6"
    },
    offered: {
      headline: `ยินดีด้วย เรามีข้อเสนองานสำหรับคุณ\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#8b5cf6"
    },
    accepted: {
      headline: `ขอบคุณที่ตอบรับข้อเสนอ\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#10b981"
    },
    hired: {
      headline: `ยินดีต้อนรับสู่ทีม IKIGAI\nตำแหน่ง ${positionTitle}`,
      tone: "#059669",
      cta: { label: "เข้าสู่ระบบพนักงาน", url: `${PUBLIC_BASE}/login` }
    },
    rejected: {
      headline: `ขอบคุณที่สมัครงานกับเรา`,
      tone: "#64748b"
    },
    withdrawn: {
      headline: `บันทึกการถอนใบสมัครแล้ว`,
      tone: "#64748b"
    }
  };
  return candidates[stage];
}

/** Default body for the health-check ("ตรวจสุขภาพ") card. Admin can
 *  override it in /admin/system-settings (recruita_health_check_message);
 *  NULL/empty there falls back to this. Owner-authored 2026-06-14. */
export const DEFAULT_HEALTH_CHECK_MESSAGE =
  "ให้ผู้สมัครที่ผ่านสัมภาษณ์ ติดต่อสถานพยาบาล (คลินิก หรือโรงพยาบาลก็ได้) เพื่อตรวจสุขภาพ " +
  "โดยแจ้งว่ามาขอรับการตรวจร่างกาย และใบรับรองแพทย์ 5 โรค หลังจากนั้นให้ผู้สมัครอัพโหลดภาพถ่าย" +
  "ใบรับรองแพทย์เข้ามาในระบบก่อน ส่วนใบรับรองแพทย์ตัวจริงให้นำมายื่นที่บริษัทในวันแรกที่มาทำงาน\n\n" +
  "หมายเหตุ: ถ้าสถานพยาบาลสอบถามลักษณะงานที่ทำ สามารถแจ้งได้ว่าทำงานในร้านอาหาร " +
  "หากทางสถานพยาบาลแนะนำให้ตรวจสุขภาพรายการอื่นๆ นอกเหนือจากใบรับรองแพทย์ 5 โรค ให้ปฏิเสธ " +
  "และแจ้งว่า ทางบริษัทจะจัดตรวจสุขภาพสำหรับผู้สัมผัสอาหารให้อีกครั้งก่อนเริ่มงาน";

/** Build the Flex card we send when an admin moves a candidate to a
 *  new stage. Generic across stages; the copy varies by stage. */
export function stageChangeFlex(args: {
  applicantName: string;
  positionTitle: string;
  branchName: string | null;
  stage: ApplicationStage;
  applicationNo: string;
  /** First work day (YYYY-MM-DD) — shown on the 'offered' card so the
   *  candidate knows when to start (owner 2026-06-15). */
  offerStartDate?: string | null;
  /** Offered compensation shown on the 'offered' card. */
  offerSalary?: number | null;
  offerSalaryType?: "monthly" | "hourly" | null;
}): LineMessage {
  const meta = STAGE_META[args.stage];
  const copy = stageCopy(args.stage, args.positionTitle);
  const altText = `${meta.label} · ${args.positionTitle}`;

  const bodyRows: Array<Record<string, unknown>> = [
    { type: "text", text: copy.headline, size: "sm", color: COLOR_TEXT_DARK, wrap: true }
  ];
  // Health-check stage: surface the admin-editable instructions (contact a
  // clinic, get the 5-disease cert, upload the photo, bring the original on
  // day one). Owner rule 2026-06-14. Falls back to the built-in default.
  if (args.stage === "health_check") {
    const msg = (getSystemSettings().recruita_health_check_message ?? "").trim()
      || DEFAULT_HEALTH_CHECK_MESSAGE;
    bodyRows.push({
      type: "text", text: msg, size: "xs", color: "#475569", wrap: true, margin: "md"
    });
  }
  bodyRows.push(
    { type: "separator", margin: "md", color: COLOR_DIVIDER },
    infoRow("สถานะ", meta.label),
    infoRow("ตำแหน่ง", args.positionTitle)
  );
  if (args.branchName) bodyRows.push(infoRow("บริษัท/สาขา", args.branchName));
  if (args.stage === "offered" && args.offerSalary != null && args.offerSalary > 0) {
    const unit = args.offerSalaryType === "hourly" ? "บาท/ชม." : "บาท/เดือน";
    bodyRows.push(infoRow("ค่าตอบแทน", `${args.offerSalary.toLocaleString("th-TH")} ${unit}`));
  }
  if (args.stage === "offered" && args.offerStartDate && /^\d{4}-\d{2}-\d{2}$/.test(args.offerStartDate)) {
    bodyRows.push(infoRow("เริ่มงานวันแรก", formatLongDate(args.offerStartDate, "th")));
  }
  bodyRows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));

  const footerContents: Array<Record<string, unknown>> = [];
  if (args.stage === "interview") {
    // Interview invite (owner 2026-06-11): two clear actions —
    //   1. เลือกเวลาเข้าสัมภาษณ์ → the candidate status page (LIFF when
    //      configured so LINE auto-logs them in), where they self-book a slot.
    //   2. นำทางมาสถานที่นัดสัมภาษณ์ → the venue map link from settings
    //      (shown only when configured + a valid http(s) URL).
    const ch = getRecruitaChannel();
    const statusUrl = ch?.liff_id_status
      ? `https://liff.line.me/${ch.liff_id_status}`
      : `${PUBLIC_BASE}/recruita/status`;
    footerContents.push({
      type: "button", style: "primary", color: COLOR_BRAND, height: "sm",
      action: { type: "uri", label: "เลือกเวลาเข้าสัมภาษณ์", uri: statusUrl }
    });
    const mapUrl = (getSystemSettings().recruita_interview_map_url ?? "").trim();
    if (/^https?:\/\//i.test(mapUrl)) {
      footerContents.push({
        type: "button", style: "secondary", height: "sm",
        action: { type: "uri", label: "นำทางมาสถานที่นัดสัมภาษณ์", uri: mapUrl }
      });
    }
  } else if (args.stage === "health_check") {
    // Health-check stage (owner 2026-06-14): the sole action is to upload
    // the medical certificate. Opens the candidate status page (LIFF when
    // configured so LINE auto-logs them in), where the upload control
    // appears on this application's card. Replaces the old
    // "ดูตำแหน่งงานอื่น" button on this card.
    const ch = getRecruitaChannel();
    const statusUrl = ch?.liff_id_status
      ? `https://liff.line.me/${ch.liff_id_status}`
      : `${PUBLIC_BASE}/recruita/status`;
    footerContents.push({
      type: "button", style: "primary", color: COLOR_BRAND, height: "sm",
      action: { type: "uri", label: "อัพโหลดใบรับรองแพทย์", uri: statusUrl }
    });
  } else if (args.stage === "offered") {
    // Offer stage (owner 2026-06-15): the candidate accepts or rejects the
    // offer on the status page (LIFF auto-logs them in), where the offer
    // detail + ตอบรับ/ปฏิเสธ buttons appear on this application's card.
    const ch = getRecruitaChannel();
    const statusUrl = ch?.liff_id_status
      ? `https://liff.line.me/${ch.liff_id_status}`
      : `${PUBLIC_BASE}/recruita/status`;
    footerContents.push({
      type: "button", style: "primary", color: COLOR_BRAND, height: "sm",
      action: { type: "uri", label: "ตอบรับ หรือปฏิเสธข้อเสนองาน", uri: statusUrl }
    });
  } else {
    if (copy.cta) {
      footerContents.push({
        type: "button", style: "primary", color: COLOR_BRAND,
        action: { type: "uri", label: copy.cta.label, uri: copy.cta.url }
      });
    }
    // "ดูตำแหน่งงานอื่น" only makes sense for early or terminal-negative
    // stages — NOT once the candidate has accepted the offer or been hired
    // (owner 2026-06-15: the accepted-status card should not invite them to
    // browse other jobs).
    if (args.stage !== "accepted" && args.stage !== "hired") {
      footerContents.push({
        type: "button", style: "secondary", height: "sm",
        action: { type: "uri", label: "ดูตำแหน่งงานอื่น", uri: `${PUBLIC_BASE}/recruita/positions` }
      });
    }
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "giga",
    header: brandHeader(meta.label, args.positionTitle),
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      backgroundColor: "#ffffff",
      contents: bodyRows
    }
  };
  // Only attach a footer when there's at least one button — an empty footer
  // box renders as dead padding (e.g. the 'accepted' card has no actions).
  if (footerContents.length > 0) {
    bubble.footer = {
      type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
      backgroundColor: "#ffffff",
      contents: footerContents
    };
  }

  return { type: "flex", altText, contents: bubble };
}

/** Build a compact Flex card the exec group sees when a new
 *  application lands. Mirrors the candidate-facing card style but
 *  surfaces admin-relevant data: candidate name, position, branch,
 *  phone (so admin can call before clicking through), and a CTA to
 *  the application detail page. */
function newApplicationFlexForExec(args: {
  applicantName: string;
  positionTitle: string;
  branchName: string | null;
  phone: string | null;
  applicationNo: string;
  applicationId: number;
}): LineMessage {
  const altText = `ใบสมัครใหม่: ${args.applicantName} · ${args.positionTitle}`;
  const rows: Array<Record<string, unknown>> = [
    infoRow("ผู้สมัคร", args.applicantName),
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) rows.push(infoRow("บริษัท/สาขา", args.branchName));
  if (args.phone) rows.push(infoRow("เบอร์โทร", args.phone));
  rows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "giga",
      header: brandHeader("ใบสมัครใหม่เข้ามาแล้ว", "มีผู้สมัครงานส่งใบสมัครเข้ามา"),
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        backgroundColor: "#ffffff",
        contents: rows
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: "#ffffff",
        contents: [
          {
            type: "button", style: "primary", color: COLOR_BRAND,
            action: {
              type: "uri",
              label: "ตรวจสอบใบสมัคร",
              uri: reviewUrl(args.applicationId)
            }
          }
        ]
      }
    }
  };
}

/** Shared gate + send for any exec-group push. Routed through the
 *  IKIGAI OS platform OA into system_settings.recruita_exec_group_id —
 *  the same bot that handles PERSONA staff notifications. Kept separate
 *  from the candidate-facing IKIGAI Recruit OA on purpose: exec pushes
 *  must NOT eat into IKIGAI Recruit's free message quota (reserved for
 *  candidate updates). Owners invite the IKIGAI OS bot to the exec
 *  group. Logs each skip/failure path because a dropped group push is
 *  invisible from the candidate side. Silent no-op when unconfigured.
 *  Owner runs `pm2 logs reserva --lines 50 --nostream` to see which
 *  gate failed. */
async function pushToExecGroup(messages: LineMessage[]): Promise<void> {
  const settings = getSystemSettings();
  const groupId = settings.recruita_exec_group_id?.trim();
  if (!groupId) {
    console.info(
      "[recruita] exec group notify skipped: recruita_exec_group_id is empty " +
      "(set it at /admin/system-settings → RECRUITA · กลุ่ม LINE ผู้บริหาร)"
    );
    return;
  }
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) {
    console.info(
      "[recruita] exec group notify skipped: IKIGAI OS platform OA not " +
      "configured (set Channel Token + Secret in /admin/system-settings)"
    );
    return;
  }
  try {
    const res = await sendLinePush(platform.channel_token, { to: groupId, messages });
    if (res.ok) {
      console.info(`[recruita] exec group notify sent → ${groupId}`);
    } else {
      console.warn(
        `[recruita] exec group notify rejected by LINE: status=${res.status} ` +
        `error=${res.error ?? "(unknown)"} groupId=${groupId} ` +
        `(common causes: the IKIGAI OS bot is not a member of this group, ` +
        `or the group id is wrong — should start with C followed by 32 hex)`
      );
    }
  } catch (e) {
    console.warn("[recruita] exec group notify threw:", e);
  }
}

/** Fire-and-forget push of the "new application" Flex card to the exec
 *  group. Silent no-op when the group/platform OA isn't configured. */
export async function notifyExecGroupNewApplication(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.submitted_at,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.title_prefix, c.first_name_th, c.last_name_th, c.mobile_phone,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number;
    submitted_at: string;
    day_seq: number;
    title_prefix: string | null;
    first_name_th: string | null;
    last_name_th: string | null;
    mobile_phone: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row) return;

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  await pushToExecGroup([newApplicationFlexForExec({
    applicantName,
    positionTitle: row.position_title,
    branchName: row.branch_name,
    phone: row.mobile_phone,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq),
    applicationId: row.id
  })]);
}

/** Exec-facing Flex card describing a stage update. */
function execStageChangeFlex(args: {
  applicantName: string;
  positionTitle: string;
  branchName: string | null;
  stage: ApplicationStage;
  applicationNo: string;
  applicationId: number;
}): LineMessage {
  const meta = STAGE_META[args.stage];
  const altText = `อัปเดตสถานะ: ${args.applicantName} → ${meta.label}`;
  const rows: Array<Record<string, unknown>> = [
    infoRow("ผู้สมัคร", args.applicantName),
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) rows.push(infoRow("บริษัท/สาขา", args.branchName));
  rows.push(infoRow("สถานะใหม่", meta.label));
  rows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));
  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "giga",
      header: brandHeader("อัปเดตสถานะใบสมัคร", `เปลี่ยนเป็น “${meta.label}”`),
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        backgroundColor: "#ffffff",
        contents: rows
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: "#ffffff",
        contents: [
          {
            type: "button", style: "primary", color: COLOR_BRAND,
            action: {
              type: "uri",
              label: "ตรวจสอบใบสมัคร",
              uri: reviewUrl(args.applicationId)
            }
          }
        ]
      }
    }
  };
}

/** Fire-and-forget push to the exec group when an application's stage
 *  changes, so owners follow pipeline movement — not just new
 *  applications. Silent no-op when the exec group/platform OA isn't
 *  configured. */
export async function notifyExecGroupStageChange(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.stage, a.submitted_at,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.title_prefix, c.first_name_th, c.last_name_th,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; stage: ApplicationStage; submitted_at: string; day_seq: number;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row) return;

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  await pushToExecGroup([execStageChangeFlex({
    applicantName,
    positionTitle: row.position_title,
    branchName: row.branch_name,
    stage: row.stage,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq),
    applicationId: row.id
  })]);
}

/** Fire-and-forget stage-change push to a candidate. Called from
 *  the stage-change API after the DB write succeeds. Silently skips
 *  when there's no linked LINE userId or the OA isn't configured. */
export async function notifyStageChange(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.stage, a.submitted_at, a.offer_start_date,
           a.offer_salary, a.offer_salary_type,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.line_user_id,
           c.title_prefix, c.first_name_th, c.last_name_th,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; stage: ApplicationStage; submitted_at: string; day_seq: number;
    offer_start_date: string | null;
    offer_salary: number | null;
    offer_salary_type: "monthly" | "hourly" | null;
    line_user_id: string | null;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row) {
    console.info(`[recruita] candidate notify skipped: application #${applicationId} not found`);
    return;
  }
  if (!row.line_user_id) {
    console.info(
      `[recruita] candidate notify skipped: app #${applicationId} has no linked LINE userId ` +
      `(applicant didn't open the form via the IKIGAI Recruit LIFF / not bound yet)`
    );
    return;
  }

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const message = stageChangeFlex({
    applicantName,
    positionTitle: row.position_title,
    branchName: row.branch_name,
    stage: row.stage,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq),
    offerStartDate: row.offer_start_date,
    offerSalary: row.offer_salary,
    offerSalaryType: row.offer_salary_type
  });
  const res = await pushToCandidate(row.line_user_id, [message]);
  if (res.ok) {
    console.info(`[recruita] candidate notify sent → app #${applicationId}`);
  } else if (res.skipped) {
    console.info(
      "[recruita] candidate notify skipped: IKIGAI Recruit OA token not configured " +
      "(set it at /admin/system-settings → RECRUITA · ตั้งค่า LINE OA)"
    );
  } else {
    console.warn(
      `[recruita] candidate notify rejected by LINE: status=${res.status} ` +
      `error=${res.error ?? "(unknown)"} ` +
      `(the applicant may not have added the IKIGAI Recruit OA as a friend — ` +
      `LINE blocks push messages to users who haven't added the OA)`
    );
  }
}

/** Welcome Flex card sent to a freshly-hired candidate (owner 2026-06-15,
 *  simplified 2026-06-16). The card's ONLY action is "เพิ่มเพื่อน IKIGAI OS
 *  PORTAL" — adds the staff OA so PERSONA pushes (shift reminders, payroll,
 *  edit decisions) can reach them. Account setup (username/password) + LINE
 *  binding are then handled by the admin manually (owner chose the semi-manual
 *  path after the INVITE LIFF onboard proved flaky). The OA-add button is
 *  omitted when system_settings.portal_oa_link isn't set — then the card is a
 *  plain welcome message. */
function hireWelcomeFlex(args: {
  positionTitle: string;
  branchName: string | null;
  portalOaLink: string | null;
}): LineMessage {
  const rows: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: "ยินดีต้อนรับสู่ทีม IKIGAI!",
      size: "sm", color: COLOR_TEXT_DARK, wrap: true, weight: "bold"
    },
    {
      type: "text",
      text: "ขั้นตอนถัดไป: กดปุ่มด้านล่างเพื่อเพิ่มเพื่อน LINE ระบบพนักงาน " +
            "(IKIGAI OS PORTAL) จากนั้นแอดมินจะตั้งค่าบัญชีพนักงานให้คุณต่อไป",
      size: "xs", color: "#475569", wrap: true, margin: "md"
    },
    { type: "separator", margin: "md", color: COLOR_DIVIDER },
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) rows.push(infoRow("บริษัท/สาขา", args.branchName));

  const footerContents: Array<Record<string, unknown>> = [];
  if (args.portalOaLink && /^https?:\/\//i.test(args.portalOaLink)) {
    footerContents.push({
      type: "button", style: "primary", color: COLOR_BRAND, height: "sm",
      action: { type: "uri", label: "เพิ่มเพื่อน IKIGAI OS PORTAL", uri: args.portalOaLink }
    });
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "giga",
    header: brandHeader("ยินดีต้อนรับสู่ทีม IKIGAI", args.positionTitle),
    body: {
      type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
      backgroundColor: "#ffffff",
      contents: rows
    }
  };
  if (footerContents.length > 0) {
    bubble.footer = {
      type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
      backgroundColor: "#ffffff",
      contents: footerContents
    };
  }

  return {
    type: "flex",
    altText: `ยินดีต้อนรับสู่ทีม IKIGAI · ${args.positionTitle}`,
    contents: bubble
  };
}

/** Fire-and-forget welcome push to a freshly-hired candidate. Called from the
 *  hire bridge so the new employee gets the "เพิ่มเพื่อน IKIGAI OS PORTAL"
 *  button; account setup + LINE binding are handled by the admin afterward.
 *  Silent no-op without a linked LINE userId / configured OA. */
export async function notifyHireWelcome(
  applicationId: number
): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, c.line_user_id,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; line_user_id: string | null;
    position_title: string; branch_name: string | null;
  } | undefined;
  if (!row) {
    console.info(`[recruita] hire welcome skipped: application #${applicationId} not found`);
    return;
  }
  if (!row.line_user_id) {
    console.info(
      `[recruita] hire welcome skipped: app #${applicationId} has no linked LINE userId ` +
      `(send the onboard link manually from the application detail page)`
    );
    return;
  }
  const portalOaLink = (getSystemSettings().portal_oa_link ?? "").trim() || null;
  const message = hireWelcomeFlex({
    positionTitle: row.position_title,
    branchName: row.branch_name,
    portalOaLink
  });
  const res = await pushToCandidate(row.line_user_id, [message]);
  if (res.ok) {
    console.info(`[recruita] hire welcome sent → app #${applicationId}`);
  } else if (res.skipped) {
    console.info(
      "[recruita] hire welcome skipped: IKIGAI Recruit OA token not configured"
    );
  } else {
    console.warn(
      `[recruita] hire welcome rejected by LINE: status=${res.status} ` +
      `error=${res.error ?? "(unknown)"}`
    );
  }
}

/** Format a naive Bangkok-local "YYYY-MM-DDTHH:MM" into Thai text. */
function fmtInterviewWhen(at: string): string {
  const [d, t] = at.split("T");
  const time = (t ?? "").slice(0, 5);
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? formatLongDate(d, "th") : (d ?? at);
  return time ? `${datePart} เวลา ${time} น.` : datePart;
}

/** Candidate-facing Flex card announcing a scheduled interview. */
function interviewScheduledFlex(args: {
  positionTitle: string;
  branchName: string | null;
  interviewAt: string;
  location: string | null;
  note: string | null;
  applicationNo: string;
}): LineMessage {
  const rows: Array<Record<string, unknown>> = [
    { type: "text", text: "ทีมงานนัดหมายสัมภาษณ์งานกับคุณ", size: "sm", color: COLOR_TEXT_DARK, wrap: true },
    { type: "separator", margin: "md", color: COLOR_DIVIDER },
    infoRow("วันเวลา", fmtInterviewWhen(args.interviewAt)),
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) rows.push(infoRow("บริษัท/สาขา", args.branchName));
  if (args.location) rows.push(infoRow("สถานที่", args.location));
  if (args.note) rows.push(infoRow("หมายเหตุ", args.note));
  rows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));
  return {
    type: "flex",
    altText: `นัดสัมภาษณ์ ${fmtInterviewWhen(args.interviewAt)} · ${args.positionTitle}`,
    contents: {
      type: "bubble",
      size: "giga",
      header: brandHeader("นัดหมายสัมภาษณ์", args.positionTitle),
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        backgroundColor: "#ffffff",
        contents: rows
      }
    }
  };
}

/** Fire-and-forget push to the candidate when an interview is scheduled
 *  (or rescheduled). No-op without a linked LINE userId / configured OA
 *  / a set interview time. */
export async function notifyInterviewScheduled(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.submitted_at, a.interview_at, a.interview_location, a.interview_note,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.line_user_id,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; submitted_at: string; day_seq: number;
    interview_at: string | null;
    interview_location: string | null;
    interview_note: string | null;
    line_user_id: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row || !row.line_user_id || !row.interview_at) return;

  const message = interviewScheduledFlex({
    positionTitle: row.position_title,
    branchName: row.branch_name,
    interviewAt: row.interview_at,
    location: row.interview_location,
    note: row.interview_note,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq)
  });
  const res = await pushToCandidate(row.line_user_id, [message]);
  if (res.ok) {
    console.info(`[recruita] interview notify sent → app #${applicationId}`);
  } else if (!res.skipped) {
    console.warn(
      `[recruita] interview notify rejected by LINE: status=${res.status} error=${res.error ?? "(unknown)"}`
    );
  }
}

/** Exec-facing Flex card: an applicant picked their own interview slot
 *  on the public status page (self-service booking, owner 2026-06-09).
 *  Distinct copy from execStageChangeFlex so owners can tell a
 *  self-booking apart from an admin-set time. */
function execInterviewBookedFlex(args: {
  applicantName: string;
  positionTitle: string;
  branchName: string | null;
  interviewAt: string;
  location: string | null;
  applicationNo: string;
  applicationId: number;
}): LineMessage {
  const rows: Array<Record<string, unknown>> = [
    infoRow("ผู้สมัคร", args.applicantName),
    infoRow("วันเวลาที่เลือก", fmtInterviewWhen(args.interviewAt)),
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) rows.push(infoRow("บริษัท/สาขา", args.branchName));
  if (args.location) rows.push(infoRow("สถานที่", args.location));
  rows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));
  return {
    type: "flex",
    altText: `ผู้สมัครเลือกวันสัมภาษณ์: ${args.applicantName} · ${fmtInterviewWhen(args.interviewAt)}`,
    contents: {
      type: "bubble",
      size: "giga",
      header: brandHeader("ผู้สมัครเลือกวันสัมภาษณ์แล้ว", "การจองผ่านหน้า ตรวจสอบสถานะใบสมัคร"),
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        backgroundColor: "#ffffff",
        contents: rows
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: "#ffffff",
        contents: [
          {
            type: "button", style: "primary", color: COLOR_BRAND,
            action: { type: "uri", label: "ตรวจสอบใบสมัคร", uri: reviewUrl(args.applicationId) }
          }
        ]
      }
    }
  };
}

/** Fire-and-forget exec-group push when an applicant self-books an
 *  interview slot. Silent no-op when the exec group / platform OA isn't
 *  configured. */
export async function notifyExecGroupInterviewBooked(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.submitted_at, a.interview_at, a.interview_location,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           c.title_prefix, c.first_name_th, c.last_name_th,
           p.title AS position_title,
           b.name  AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; submitted_at: string; day_seq: number;
    interview_at: string | null; interview_location: string | null;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row || !row.interview_at) return;

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  await pushToExecGroup([execInterviewBookedFlex({
    applicantName,
    positionTitle: row.position_title,
    branchName: row.branch_name,
    interviewAt: row.interview_at,
    location: row.interview_location,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq),
    applicationId: row.id
  })]);
}
