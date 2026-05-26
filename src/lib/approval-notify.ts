// Leave-approval notification helper (2026-05).
//
// Pushes owl-themed Flex cards to every stakeholder when one of these
// events fires on a leave_requests row:
//
//   submitted   → primary approver (A) gets the "action required" card,
//                 A's manager (backup B) gets an FYI card so they know
//                 something's brewing in the chain
//   approved    → requester gets the good-news card, backup gets the
//                 close-the-loop "no action needed" card
//   rejected    → requester gets the bad-news card, backup gets the
//                 close-the-loop card
//   escalated   → the new primary (B, one step up) gets "your turn"
//                 card, the old primary (A) gets "you missed it" card
//
// All cards go through the IKIGAI OS *platform* OA (the same one
// staff added as a friend for clock-in confirmations). Recipients
// without line_user_id are silently skipped — there's no fallback
// to email or SMS in this iteration.
//
// Each push is fire-and-forget at the caller's level (we never throw);
// individual failures are console.warned. We don't write to
// notification_log here since these are operational nudges, not
// audit-worthy events — the request row itself is the audit trail.

import { getDb } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush, personaApprovalNotifyFlex } from "./line";

export type LeaveApprovalEvent =
  | "submitted"
  | "approved"
  | "rejected"
  | "escalated";

type LeaveRow = {
  id: number;
  user_id: number;
  type: string;
  date_from: string;
  date_to: string;
  reason: string | null;
  decision_note: string | null;
  current_approver_user_id: number | null;
  branch_id: number | null;
};

type UserRow = {
  id: number;
  display_name: string;
  nickname_th: string | null;
  title_prefix: string | null;
  line_user_id: string | null;
  reports_to_user_id: number | null;
};

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

function userLabel(u: UserRow): string {
  const prefix = u.title_prefix ?? "";
  const nick = u.nickname_th?.trim();
  if (nick) return `${prefix}${u.display_name} (${nick})`.trim();
  return `${prefix}${u.display_name}`.trim();
}

function recipientGreetingName(u: UserRow): string {
  return u.nickname_th?.trim() || u.display_name;
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

/** Push a single Flex to a recipient via the platform OA. Silently
 *  skip when the recipient has no line_user_id. Returns true on
 *  success, false on any failure (caller may log). */
async function pushOne(
  token: string,
  recipient: UserRow | undefined,
  flex: ReturnType<typeof personaApprovalNotifyFlex>
): Promise<boolean> {
  if (!recipient?.line_user_id?.trim()) return false;
  try {
    const res = await sendLinePush(token, {
      to: recipient.line_user_id,
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

/** Resolve a user row + their direct manager. Returns null when the
 *  user_id doesn't exist (defensive — caller should ignore). */
function loadUserWithManager(userId: number): {
  user: UserRow | null;
  manager: UserRow | null;
} {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, display_name, nickname_th, title_prefix, line_user_id,
           reports_to_user_id
    FROM users WHERE id = ?
  `).get(userId) as UserRow | undefined;
  if (!user) return { user: null, manager: null };
  let manager: UserRow | null = null;
  if (user.reports_to_user_id) {
    manager = db.prepare(`
      SELECT id, display_name, nickname_th, title_prefix, line_user_id,
             reports_to_user_id
      FROM users WHERE id = ? AND status != 'disabled'
    `).get(user.reports_to_user_id) as UserRow | null ?? null;
  }
  return { user, manager };
}

/** Send the appropriate set of LINE Flex cards for one event on a
 *  leave request. Caller can fire-and-forget (`.catch(...)`). */
export async function notifyLeaveEvent(args: {
  requestId: number;
  event: LeaveApprovalEvent;
  /** For "escalated" — the user_id we just escalated FROM (the
   *  approver who didn't act). The TO side is the new value
   *  already saved in current_approver_user_id at call time. */
  escalatedFromUserId?: number | null;
}): Promise<void> {
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) return;
  const token = platform.channel_token;

  const db = getDb();
  const row = db.prepare(`
    SELECT id, user_id, type, date_from, date_to, reason, decision_note,
           current_approver_user_id, branch_id
    FROM leave_requests WHERE id = ?
  `).get(args.requestId) as LeaveRow | undefined;
  if (!row) return;

  const requesterResolved = loadUserWithManager(row.user_id);
  const requester = requesterResolved.user;
  if (!requester) return;
  const requesterLabel = userLabel(requester);
  const leaveTypeLabel = leaveLabelTh(row.type);

  // CTA destinations — primary/backup → admin leave page; requester
  // → their own staff leave page.
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

  switch (args.event) {
    case "submitted": {
      // A = current approver (initial assignee); B = A's manager.
      if (!row.current_approver_user_id) return;
      const aResolved = loadUserWithManager(row.current_approver_user_id);
      const a = aResolved.user;
      const b = aResolved.manager;
      // Primary
      if (a) {
        await pushOne(token, a, personaApprovalNotifyFlex({
          ...baseDetail,
          variant: "submitted_primary",
          recipientName: recipientGreetingName(a),
          ctaUrl: ctaPrimary.url,
          ctaLabel: ctaPrimary.label
        }));
      }
      // Backup
      if (b) {
        await pushOne(token, b, personaApprovalNotifyFlex({
          ...baseDetail,
          variant: "submitted_backup",
          recipientName: recipientGreetingName(b),
          ctaUrl: ctaPrimary.url,
          ctaLabel: ctaPrimary.label
        }));
      }
      return;
    }
    case "approved":
    case "rejected": {
      // Requester gets the news.
      await pushOne(token, requester, personaApprovalNotifyFlex({
        ...baseDetail,
        variant: args.event === "approved" ? "approved_requester" : "rejected_requester",
        recipientName: recipientGreetingName(requester),
        ctaUrl: ctaSelf.url,
        ctaLabel: ctaSelf.label
      }));
      // Backup (the original primary's manager) closes the loop.
      // We look it up from the requester's chain: requester → A → B.
      // At this point the request might already be decided so
      // current_approver might still be A; the backup is A's manager.
      if (requester.reports_to_user_id) {
        const aResolved = loadUserWithManager(requester.reports_to_user_id);
        const b = aResolved.manager;
        if (b) {
          await pushOne(token, b, personaApprovalNotifyFlex({
            ...baseDetail,
            variant: args.event === "approved" ? "approved_backup" : "rejected_backup",
            recipientName: recipientGreetingName(b),
            ctaUrl: ctaPrimary.url,
            ctaLabel: ctaPrimary.label
          }));
        }
      }
      return;
    }
    case "escalated": {
      // New primary = current_approver_user_id (post-escalation);
      // Old primary = escalatedFromUserId.
      if (!row.current_approver_user_id) return;
      const newPrimary = loadUserWithManager(row.current_approver_user_id).user;
      if (newPrimary) {
        await pushOne(token, newPrimary, personaApprovalNotifyFlex({
          ...baseDetail,
          variant: "escalated_new",
          recipientName: recipientGreetingName(newPrimary),
          ctaUrl: ctaPrimary.url,
          ctaLabel: ctaPrimary.label
        }));
      }
      if (args.escalatedFromUserId) {
        const oldPrimary = loadUserWithManager(args.escalatedFromUserId).user;
        if (oldPrimary) {
          await pushOne(token, oldPrimary, personaApprovalNotifyFlex({
            ...baseDetail,
            variant: "escalated_old",
            recipientName: recipientGreetingName(oldPrimary),
            ctaUrl: ctaPrimary.url,
            ctaLabel: ctaPrimary.label
          }));
        }
      }
      return;
    }
  }
}
