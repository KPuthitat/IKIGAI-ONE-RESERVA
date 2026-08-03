// Leave-approval notification helper (2026-05, tier-based rewrite).
//
// Pushes owl-themed Flex cards to every stakeholder when one of these
// events fires on a leave_requests row. Recipients are derived from
// the branch's tier roster (NOT from the requester's per-user chain
// as in the previous version):
//
//   submitted     → all members of current_tier (typically tier 1).
//                   "Action required — please open and decide."
//   tier_advanced → all members of the NEW current_tier (after a
//                   tier-1 approve bumped it to tier 2). Cards say
//                   "Past tier 1, now your turn."
//   approved      → requester (final approval at tier 2). Plus a
//                   close-the-loop FYI to the other tier members
//                   so they know no further action is needed.
//   rejected      → requester (final rejection at any tier).
//   escalated     → all members of tier 2 (auto-escalation from
//                   tier-1 timeout). Card has an extra-urgent banner.
//
// All cards go through the IKIGAI OS platform OA (same one staff
// added as a friend for clock-in confirmations). Recipients without
// line_user_id are silently skipped — there's no fallback to email
// or SMS in this iteration.
//
// Each push is fire-and-forget at the caller's level (we never throw);
// individual failures are console.warned. We don't write to
// notification_log here since these are operational nudges, not
// audit-worthy events — the request row itself is the audit trail.

import { getDb } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush, personaApprovalNotifyFlex, notifyToHrGroup } from "./line";
import { getTierLineRecipients, type TierLevel } from "./approval-tiers";
import { nameWithPrefix } from "./name";

export type LeaveApprovalEvent =
  | "submitted"        // → notify current tier
  | "tier_advanced"    // → notify new (higher) tier after tier-1 approve
  | "approved"         // → notify requester (final at tier 2)
  | "rejected"         // → notify requester
  | "escalated";       // → notify tier 2 after timeout bump

type LeaveRow = {
  id: number;
  user_id: number;
  type: string;
  date_from: string;
  date_to: string;
  reason: string | null;
  decision_note: string | null;
  current_tier: number | null;
  branch_id: number | null;
};

type UserRow = {
  id: number;
  display_name: string;
  nickname_th: string | null;
  title_prefix: string | null;
  line_user_id: string | null;
};

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

function userLabel(u: { display_name: string; nickname_th: string | null; title_prefix: string | null }): string {
  const prefix = u.title_prefix ?? "";
  const nick = u.nickname_th?.trim();
  if (nick) return `${prefix}${u.display_name} (${nick})`.trim();
  return `${prefix}${u.display_name}`.trim();
}

function recipientGreetingName(u: { display_name: string; nickname_th: string | null }): string {
  // 2026-05-27: return "" (NOT display_name) when no nickname on file.
  // approvalGreetingTh now concatenates this directly after "พี่" with
  // no space — falling back to a full display_name like "Mr. Phuthitat"
  // produced awkward "สวัสดีครับพี่Mr. Phuthitat" strings. Empty string
  // degrades to plain "สวัสดีครับพี่" which is polite Thai.
  return u.nickname_th?.trim() || "";
}

function leaveLabelTh(type: string): string {
  const m: Record<string, string> = {
    sick:          "ลาป่วย",
    personal:      "ลากิจส่วนตัว",
    annual:        "ลาพักร้อน",
    maternity:     "ลาคลอด",
    ordination:    "ลาบวช",
    sterilization: "ลาทำหมัน",
    pilgrimage:    "ลาประกอบพิธีฮัจญ์",
    military:      "ลารับราชการทหาร",
    unpaid:        "ลาไม่รับค่าจ้าง",
    holiday:       "วันหยุดประเพณี (สะสม)"
  };
  return m[type] ?? type;
}

/** Push a single Flex to one recipient via the platform OA. Skip if
 *  no line_user_id. Returns true on success. */
async function pushOne(
  token: string,
  lineUserId: string | null,
  flex: ReturnType<typeof personaApprovalNotifyFlex>
): Promise<boolean> {
  if (!lineUserId?.trim()) return false;
  try {
    const res = await sendLinePush(token, {
      to: lineUserId,
      messages: [flex]
    });
    if (!res.ok) {
      console.warn("approval-notify push failed", res.error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("approval-notify push threw", e);
    return false;
  }
}

/** Send the appropriate set of LINE Flex cards for one event on a
 *  leave request. Caller fire-and-forget. */
export async function notifyLeaveEvent(args: {
  requestId: number;
  event: LeaveApprovalEvent;
  /** For "approved"/"rejected" — caller may pass the tier where the
   *  decision was actually made, so the close-the-loop FYI goes to
   *  the right cohort. Defaults to the request's current_tier. */
  decidedTier?: TierLevel;
}): Promise<void> {
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) return;
  const token = platform.channel_token;

  const db = getDb();
  const row = db.prepare(`
    SELECT id, user_id, type, date_from, date_to, reason, decision_note,
           current_tier, branch_id
    FROM leave_requests WHERE id = ?
  `).get(args.requestId) as LeaveRow | undefined;
  if (!row || !row.branch_id) return;

  const requester = db.prepare(`
    SELECT id, display_name, nickname_th, title_prefix, line_user_id
    FROM users WHERE id = ?
  `).get(row.user_id) as UserRow | undefined;
  if (!requester) return;

  const requesterLabel = userLabel(requester);
  const leaveTypeLabel = leaveLabelTh(row.type);

  const ctaPrimary = {
    url: `${PUBLIC_BASE}/admin/persona/leave?focus=${row.id}`,
    label: "ตอบรับคำขอ"
  };
  const ctaSelf = {
    url: `${PUBLIC_BASE}/staff/persona/leave`,
    label: "เปิดประวัติการลา"
  };

  const baseDetail = {
    requesterLabel,
    leaveTypeLabel,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    reason: row.reason,
    decisionNote: row.decision_note
  };

  // Tier currently sitting on the request. May be null on legacy
  // rows submitted before the tier migration — we skip notifying
  // those gracefully.
  const tier = (row.current_tier as TierLevel | null) ?? null;

  switch (args.event) {
    case "submitted": {
      // Owner 2026-06-06: leave requests are personal — notify the
      // REQUESTER (acknowledgement only) + HR group (already done at
      // the API call site via notifyHrLeaveRequest). Do NOT DM the
      // approval chain: managers are in the HR group and see it there.
      // If no one approves, the escalation cron bumps to tier 2.
      const label = leaveLabelTh(row.type);
      const range = row.date_from === row.date_to
        ? row.date_from : `${row.date_from} – ${row.date_to}`;
      await pushOne(token, requester.line_user_id, {
        type: "flex",
        altText: `คำขอ${label}ของคุณถูกส่งแล้ว`,
        contents: {
          type: "bubble", size: "giga",
          body: {
            type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
            contents: [
              { type: "text", text: "คำขอลางานถูกส่งแล้ว", size: "xs", color: "#047857", weight: "bold" },
              { type: "text", text: `${label} · ${range}`, size: "md", color: "#0F1B33", weight: "bold", margin: "sm", wrap: true },
              { type: "text", text: "อยู่ระหว่างรออนุมัติจากหัวหน้างานในกลุ่ม HR", size: "sm", color: "#555555", wrap: true, margin: "sm" }
            ]
          },
          footer: {
            type: "box", layout: "vertical", paddingAll: "12px",
            contents: [{
              type: "button", style: "link",
              action: { type: "uri", label: "ดูประวัติการลา", uri: ctaSelf.url }
            }]
          }
        }
      } as ReturnType<typeof personaApprovalNotifyFlex>);
      return;
    }
    case "tier_advanced": {
      // After a tier-1 approve, request is now at tier 2. Notify
      // tier-2 members so they know to action it.
      // (Kept: tier 2 members may not be in the same HR group line.)
      if (!tier) return;
      const recipients = getTierLineRecipients(row.branch_id, tier, requester.id);
      for (const r of recipients) {
        await pushOne(token, r.line_user_id, personaApprovalNotifyFlex({
          ...baseDetail,
          variant: "submitted_primary",
          recipientName: recipientGreetingName(r),
          ctaUrl: ctaPrimary.url,
          ctaLabel: ctaPrimary.label
        }));
      }
      return;
    }
    case "approved":
    case "rejected": {
      // Requester gets the verdict.
      await pushOne(token, requester.line_user_id, personaApprovalNotifyFlex({
        ...baseDetail,
        variant: args.event === "approved" ? "approved_requester" : "rejected_requester",
        recipientName: recipientGreetingName(requester),
        ctaUrl: ctaSelf.url,
        ctaLabel: ctaSelf.label
      }));
      // Close-the-loop FYI to the other members of the tier where
      // the decision happened (so they don't keep checking).
      const closeLoopTier = args.decidedTier ?? tier;
      if (closeLoopTier) {
        const others = getTierLineRecipients(row.branch_id, closeLoopTier, requester.id);
        for (const r of others) {
          await pushOne(token, r.line_user_id, personaApprovalNotifyFlex({
            ...baseDetail,
            variant: args.event === "approved" ? "approved_backup" : "rejected_backup",
            recipientName: recipientGreetingName(r),
            ctaUrl: ctaPrimary.url,
            ctaLabel: ctaPrimary.label
          }));
        }
      }
      return;
    }
    case "escalated": {
      // Auto-escalation from tier-1 timeout. The request's current_
      // tier has already been bumped to 2 by the cron; notify all of
      // them with the "your turn now" card variant.
      if (!tier) return;
      const recipients = getTierLineRecipients(row.branch_id, tier, requester.id);
      for (const r of recipients) {
        await pushOne(token, r.line_user_id, personaApprovalNotifyFlex({
          ...baseDetail,
          variant: "escalated_new",
          recipientName: recipientGreetingName(r),
          ctaUrl: ctaPrimary.url,
          ctaLabel: ctaPrimary.label
        }));
      }
      return;
    }
  }
}

// ── HR group alerts (owner 2026-06-06) ──────────────────────────────
// Send a brief Flex card to the HR group when a leave or shift-change
// request is submitted, so HR sees every request in one group.
const LEAVE_TYPE_HR: Record<string, string> = {
  sick: "ลาป่วย", personal: "ลากิจส่วนตัว", annual: "ลาพักร้อน",
  pt_emergency: "ลาฉุกเฉิน (พาร์ทไทม์)", maternity: "ลาคลอด",
  ordination: "ลาบวช", sterilization: "ลาทำหมัน", military: "ลารับราชการทหาร"
};

/** Push a compact Flex notification to the HR group when a leave request
 *  is submitted. Best-effort: never throws, skips if HR group unconfigured. */
export async function notifyHrLeaveRequest(requestId: number): Promise<void> {
  try {
    const row = getDb().prepare(`
      SELECT l.type, l.date_from, l.date_to, l.days, l.ref_no,
             u.display_name, u.title_prefix
      FROM leave_requests l JOIN users u ON u.id = l.user_id
      WHERE l.id = ?
    `).get(requestId) as {
      type: string; date_from: string; date_to: string; days: number;
      ref_no: string | null; display_name: string; title_prefix: string | null;
    } | undefined;
    if (!row) return;
    const name = nameWithPrefix(row.title_prefix, row.display_name);
    const label = LEAVE_TYPE_HR[row.type] ?? row.type;
    const range = row.date_from === row.date_to ? row.date_from : `${row.date_from} – ${row.date_to}`;
    await notifyToHrGroup({
      type: "flex",
      altText: `คำขอลางาน · ${name} · ${label}`,
      contents: {
        type: "bubble", size: "giga",
        body: {
          type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
          contents: [
            { type: "text", text: "คำขอลางาน · รออนุมัติ", size: "xs", color: "#B45309", weight: "bold" },
            { type: "text", text: name, size: "md", color: "#0F1B33", weight: "bold", margin: "sm", wrap: true },
            { type: "text", text: `${label} · ${range} (${row.days} วัน)`, size: "sm", color: "#555555", wrap: true },
            ...(row.ref_no ? [{ type: "text" as const, text: row.ref_no, size: "xxs" as const, color: "#9a9a9a" }] : [])
          ]
        },
        footer: {
          type: "box", layout: "vertical", paddingAll: "12px",
          contents: [{
            type: "button", style: "primary", color: "#0F1B33", height: "sm",
            action: { type: "uri", label: "ตอบรับคำขอ", uri: `${PUBLIC_BASE}/admin/persona/leave?focus=${requestId}` }
          }]
        }
      }
    });
  } catch { /* best-effort */ }
}

/** Push a compact Flex notification to the HR group when a shift-change
 *  request is submitted. Best-effort. */
export async function notifyHrShiftRequest(params: {
  name: string; refNo: string | null; kind: "extra_shift" | "swap";
  workDate: string; offDate: string | null;
}): Promise<void> {
  try {
    const kindLabel = params.kind === "swap" ? "ขอสลับวันหยุด" : "ขอเพิ่มกะ";
    const detail = params.kind === "swap"
      ? `หยุด ${params.offDate} ทำงานแทน ${params.workDate}`
      : `ทำงานเพิ่ม ${params.workDate}`;
    await notifyToHrGroup({
      type: "flex",
      altText: `คำขอเปลี่ยนเวลางาน · ${params.name} · ${kindLabel}`,
      contents: {
        type: "bubble", size: "giga",
        body: {
          type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
          contents: [
            { type: "text", text: "คำขอเปลี่ยนเวลางาน · รออนุมัติ", size: "xs", color: "#1a2b50", weight: "bold" },
            { type: "text", text: params.name, size: "md", color: "#0F1B33", weight: "bold", margin: "sm", wrap: true },
            { type: "text", text: `${kindLabel} · ${detail}`, size: "sm", color: "#555555", wrap: true },
            ...(params.refNo ? [{ type: "text" as const, text: params.refNo, size: "xxs" as const, color: "#9a9a9a" }] : [])
          ]
        },
        footer: {
          type: "box", layout: "vertical", paddingAll: "12px",
          contents: [{
            type: "button", style: "primary", color: "#1a2b50", height: "sm",
            action: { type: "uri", label: "ตอบรับคำขอ", uri: `${PUBLIC_BASE}/admin/persona/shift-requests` }
          }]
        }
      }
    });
  } catch { /* best-effort */ }
}
