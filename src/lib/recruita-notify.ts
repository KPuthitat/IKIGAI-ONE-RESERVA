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
import { getRecruitaChannel } from "./messaging-channels";
import { STAGE_META, type ApplicationStage } from "./recruita";
import { formatApplicationNo } from "./time";

// Minimal local mirror of line.ts's LinePushPayload — kept local so
// we don't have to widen the line.ts module surface for one caller.
type LineMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

// IKIGAI OS CI palette — keep in sync with tailwind.config.ts + line.ts
// so RECRUITA cards look like the rest of the system (PERSONA / RESERVA).
const COLOR_INK = "#1a1a2e";
const COLOR_BRAND = "#e94560";
const COLOR_BRAND_LIGHT = "#ff6b85";
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
      headline: `✅ ใบสมัครของคุณผ่านการคัดกรองเบื้องต้น\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#0ea5e9"
    },
    interview: {
      headline: `🗣 ทีมงานต้องการเชิญคุณมาสัมภาษณ์\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#f59e0b"
    },
    offered: {
      headline: `📨 ยินดีด้วย! เรามีข้อเสนองานสำหรับคุณ\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#8b5cf6"
    },
    accepted: {
      headline: `🎉 ขอบคุณที่ตอบรับข้อเสนอ\nสำหรับตำแหน่ง ${positionTitle}`,
      tone: "#10b981"
    },
    hired: {
      headline: `🎊 ยินดีต้อนรับสู่ทีม IKIGAI!\nตำแหน่ง ${positionTitle}`,
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

/** Build the Flex card we send when an admin moves a candidate to a
 *  new stage. Generic across stages; the copy varies by stage. */
export function stageChangeFlex(args: {
  applicantName: string;
  positionTitle: string;
  branchName: string | null;
  stage: ApplicationStage;
  applicationNo: string;
}): LineMessage {
  const meta = STAGE_META[args.stage];
  const copy = stageCopy(args.stage, args.positionTitle);
  const altText = `${meta.label} · ${args.positionTitle}`;

  const bodyRows: Array<Record<string, unknown>> = [
    { type: "text", text: copy.headline, size: "sm", color: COLOR_TEXT_DARK, wrap: true },
    { type: "separator", margin: "md", color: COLOR_DIVIDER },
    infoRow("สถานะ", meta.label),
    infoRow("ตำแหน่ง", args.positionTitle)
  ];
  if (args.branchName) bodyRows.push(infoRow("บริษัท/สาขา", args.branchName));
  bodyRows.push(infoRow("เลขที่ใบสมัคร", args.applicationNo));

  const footerContents: Array<Record<string, unknown>> = [];
  if (copy.cta) {
    footerContents.push({
      type: "button", style: "primary", color: COLOR_BRAND,
      action: { type: "uri", label: copy.cta.label, uri: copy.cta.url }
    });
  }
  footerContents.push({
    type: "button", style: "secondary", height: "sm",
    action: { type: "uri", label: "ดูตำแหน่งงานอื่น", uri: `${PUBLIC_BASE}/recruita/positions` }
  });

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "giga",
      header: brandHeader(meta.label, args.positionTitle),
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        backgroundColor: "#ffffff",
        contents: bodyRows
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
        backgroundColor: "#ffffff",
        contents: footerContents
      }
    }
  };
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
              label: "ดูใบสมัคร",
              uri: `${PUBLIC_BASE}/admin/recruita/applications/${args.applicationId}`
            }
          }
        ]
      }
    }
  };
}

/** Shared gate + send for any exec-group push. Routed through the SAME
 *  OA as candidate notifications — the "IKIGAI Recruit" OA — so the
 *  whole RECRUITA module runs on one bot: owners just invite the IKIGAI
 *  Recruit OA to the exec group (the join event prints the group id to
 *  paste into settings). Logs each skip/failure path because a dropped
 *  group push is invisible from the candidate side. Silent no-op when
 *  group id or the OA token isn't configured. Owner runs `pm2 logs
 *  reserva --lines 50 --nostream` to see which gate failed. */
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
  const ch = getRecruitaChannel();
  if (!ch?.channel_token) {
    console.info(
      "[recruita] exec group notify skipped: IKIGAI Recruit OA not configured " +
      "(set Channel Access Token at /admin/system-settings → RECRUITA · ตั้งค่า LINE OA)"
    );
    return;
  }
  try {
    const res = await sendLinePush(ch.channel_token, { to: groupId, messages });
    if (res.ok) {
      console.info(`[recruita] exec group notify sent → ${groupId}`);
    } else {
      console.warn(
        `[recruita] exec group notify rejected by LINE: status=${res.status} ` +
        `error=${res.error ?? "(unknown)"} groupId=${groupId} ` +
        `(common causes: the IKIGAI Recruit bot is not a member of this group, ` +
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
              label: "ดูใบสมัคร",
              uri: `${PUBLIC_BASE}/admin/recruita/applications/${args.applicationId}`
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
    SELECT a.id, a.stage, a.submitted_at,
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
    line_user_id: string | null;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    position_title: string;
    branch_name: string | null;
  } | undefined;
  if (!row || !row.line_user_id) return;

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const message = stageChangeFlex({
    applicantName,
    positionTitle: row.position_title,
    branchName: row.branch_name,
    stage: row.stage,
    applicationNo: formatApplicationNo(row.submitted_at, row.day_seq)
  });
  await pushToCandidate(row.line_user_id, [message]);
}
