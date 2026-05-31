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

import { getDb } from "./db";
import { sendLinePush } from "./line";
import { getRecruitaChannel } from "./messaging-channels";
import { STAGE_META, type ApplicationStage } from "./recruita";

// Minimal local mirror of line.ts's LinePushPayload — kept local so
// we don't have to widen the line.ts module surface for one caller.
type LineMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

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
  stage: ApplicationStage;
  applicationId: number;
}): LineMessage {
  const meta = STAGE_META[args.stage];
  const copy = stageCopy(args.stage, args.positionTitle);
  const altText = `${meta.label} · ${args.positionTitle}`;

  const footerContents: Array<Record<string, unknown>> = [];
  if (copy.cta) {
    footerContents.push({
      type: "button",
      style: "primary",
      color: copy.tone,
      action: { type: "uri", label: copy.cta.label, uri: copy.cta.url }
    });
  }
  // Always offer "ดูสถานะใบสมัคร" so the candidate can re-open the
  // public detail page (when implemented). For v1 we link back to
  // the position listing — better than nothing.
  footerContents.push({
    type: "button",
    style: "secondary",
    action: {
      type: "uri",
      label: "ดูตำแหน่งงานอื่น",
      uri: `${PUBLIC_BASE}/recruita/positions`
    }
  });

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: copy.tone,
        contents: [
          { type: "text", text: "IKIGAI Recruit", size: "xxs", color: "#ffffff", weight: "bold" },
          { type: "text", text: meta.label, size: "lg", color: "#ffffff", weight: "bold", margin: "xs" }
        ]
      },
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "16px",
        contents: [
          { type: "text", text: copy.headline, size: "sm", color: "#1a1a2e", wrap: true },
          { type: "separator", margin: "md" },
          {
            type: "box", layout: "baseline", margin: "md",
            contents: [
              { type: "text", text: "ผู้สมัคร", size: "xs", color: "#888888", flex: 2 },
              { type: "text", text: args.applicantName, size: "xs", color: "#1a1a2e", weight: "bold", flex: 5, wrap: true }
            ]
          },
          {
            type: "box", layout: "baseline",
            contents: [
              { type: "text", text: "ตำแหน่ง", size: "xs", color: "#888888", flex: 2 },
              { type: "text", text: args.positionTitle, size: "xs", color: "#1a1a2e", weight: "bold", flex: 5, wrap: true }
            ]
          },
          {
            type: "box", layout: "baseline",
            contents: [
              { type: "text", text: "เลขที่ใบสมัคร", size: "xs", color: "#888888", flex: 2 },
              { type: "text", text: `#${args.applicationId}`, size: "xs", color: "#1a1a2e", weight: "bold", flex: 5 }
            ]
          }
        ]
      },
      footer: footerContents.length > 0 ? {
        type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
        contents: footerContents
      } : undefined
    }
  };
}

/** Fire-and-forget stage-change push to a candidate. Called from
 *  the stage-change API after the DB write succeeds. Silently skips
 *  when there's no linked LINE userId or the OA isn't configured. */
export async function notifyStageChange(applicationId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.id, a.stage,
           c.line_user_id,
           c.title_prefix, c.first_name_th, c.last_name_th,
           p.title AS position_title
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    WHERE a.id = ?
  `).get(applicationId) as {
    id: number; stage: ApplicationStage; line_user_id: string | null;
    title_prefix: string | null;
    first_name_th: string | null; last_name_th: string | null;
    position_title: string;
  } | undefined;
  if (!row || !row.line_user_id) return;

  const applicantName = [row.title_prefix, row.first_name_th, row.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const message = stageChangeFlex({
    applicantName,
    positionTitle: row.position_title,
    stage: row.stage,
    applicationId: row.id
  });
  await pushToCandidate(row.line_user_id, [message]);
}
