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
import { sendLinePush, personaApprovalNotifyFlex } from "./line";
import { getTierLineRecipients, type TierLevel } from "./approval-tiers";

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
    military:      "ลารับราชการทหาร"
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
    label: "เปิดหน้าอนุมัติ"
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
      // Notify everyone in the current tier (excluding requester).
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
    case "tier_advanced": {
      // After a tier-1 approve, the request is now at tier 2.
      // Notify all tier-2 members (minus the requester, in case
      // they're on the executive list too via self-skip).
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
