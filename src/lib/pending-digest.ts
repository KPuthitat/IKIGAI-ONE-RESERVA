// Daily pending-requests digest (owner 2026-06-05).
//
// Once per day per branch, at the admin-configured
// branches.pending_digest_time, push a single LINE card to the
// HR group (via notifyToHrGroup → system_settings.recruita_exec_group_id)
// summarising staff requests that are STILL WAITING on someone —
// the ones that "fell through" because nobody actioned them:
//
//   คำขอเปลี่ยนเวลางาน          ← shift_change_requests status='pending'
//    • นาย ก
//    • นาย ข
//   คำขอลางานรออนุมัติ          ← leave_requests status='pending'
//    • นาย ก
//   คำขอทำงานล่วงเวลา           ← ot_requests status='pending' (owner 2026-06-08)
//    • นาย ก
//
// Same idempotency model as the attendance summary:
// isPendingDigestDue() short-circuits on pending_digest_last_sent_date
// so the every-5-min external cron doesn't re-send. The cron sends
// only when there's at least one pending item, but stamps the date
// regardless so an empty day doesn't get retried all afternoon.

import { getDb, type Branch } from "./db";
import { nameWithPrefix } from "./name";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const MAX_ROWS_PER_SECTION = 20;

// Self-contained Thai leave-type labels (mirrors approval-notify's
// private map; kept local so this module has no cross-import on a
// non-exported helper). Falls back to the raw code for unknowns.
const LEAVE_LABEL_TH: Record<string, string> = {
  sick:          "ลาป่วย",
  personal:      "ลากิจส่วนตัว",
  annual:        "ลาพักร้อน",
  pt_emergency:  "ลาฉุกเฉิน (พาร์ทไทม์)",
  maternity:     "ลาคลอด",
  ordination:    "ลาบวช",
  sterilization: "ลาทำหมัน",
  military:      "ลารับราชการทหาร"
};
const SHIFT_KIND_TH: Record<string, string> = {
  extra_shift: "ขอเพิ่มกะ",
  swap:        "ขอสลับวันหยุด"
};

export type PendingDigestItem = {
  name: string;     // already prefixed (e.g. "นาย ก")
  detail: string;   // small muted sub-line for context
  ref: string | null;
};

export type PendingDigest = {
  shiftChange: PendingDigestItem[];
  leave: PendingDigestItem[];
  ot: PendingDigestItem[];
};

/** Collect the still-pending shift-change + leave requests for a
 *  branch. Both lists are oldest-first so the most-overdue request
 *  reads at the top. */
export function buildPendingDigest(branchId: number): PendingDigest {
  const db = getDb();

  type ShiftRow = {
    kind: string; work_date: string; off_date: string | null;
    ref_no: string | null; display_name: string; title_prefix: string | null;
  };
  const shiftRows = db.prepare(`
    SELECT r.kind, r.work_date, r.off_date, r.ref_no,
           u.display_name, u.title_prefix
    FROM shift_change_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.branch_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all(branchId) as ShiftRow[];

  type LeaveRow = {
    type: string; date_from: string; date_to: string;
    ref_no: string | null; display_name: string; title_prefix: string | null;
  };
  const leaveRows = db.prepare(`
    SELECT l.type, l.date_from, l.date_to, l.ref_no,
           u.display_name, u.title_prefix
    FROM leave_requests l
    JOIN users u ON u.id = l.user_id
    WHERE l.branch_id = ? AND l.status = 'pending'
    ORDER BY l.created_at ASC
  `).all(branchId) as LeaveRow[];

  // OT requests pending approval (owner 2026-06-08) — folded into this
  // daily digest instead of a per-request push to save LINE quota.
  type OtRow = {
    work_date: string; requested_until: string;
    display_name: string; title_prefix: string | null;
  };
  const otRows = db.prepare(`
    SELECT o.work_date, o.requested_until, u.display_name, u.title_prefix
    FROM ot_requests o
    JOIN users u ON u.id = o.user_id
    WHERE o.branch_id = ? AND o.status = 'pending'
    ORDER BY o.created_at ASC
  `).all(branchId) as OtRow[];

  return {
    shiftChange: shiftRows.map((r) => ({
      name: nameWithPrefix(r.title_prefix, r.display_name),
      detail: r.kind === "swap"
        ? `${SHIFT_KIND_TH.swap} · หยุด ${r.off_date} ทำงานแทน ${r.work_date}`
        : `${SHIFT_KIND_TH.extra_shift} · ${r.work_date}`,
      ref: r.ref_no
    })),
    leave: leaveRows.map((r) => {
      const label = LEAVE_LABEL_TH[r.type] ?? r.type;
      const range = r.date_from === r.date_to
        ? r.date_from
        : `${r.date_from} – ${r.date_to}`;
      return {
        name: nameWithPrefix(r.title_prefix, r.display_name),
        detail: `${label} · ${range}`,
        ref: r.ref_no
      };
    }),
    ot: otRows.map((r) => ({
      name: nameWithPrefix(r.title_prefix, r.display_name),
      detail: `ทำงานล่วงเวลาถึง ${r.requested_until} น. · ${r.work_date}`,
      ref: null
    }))
  };
}

/** True when the digest carries at least one pending item. The cron
 *  uses this to decide whether to actually push (an empty digest is
 *  pointless), while still stamping the dedupe date either way. */
export function hasPendingItems(d: PendingDigest): boolean {
  return d.shiftChange.length > 0 || d.leave.length > 0 || d.ot.length > 0;
}

/** Build the LINE Flex card. Navy header + two name-bulleted sections
 *  matching the owner's requested pattern. Each name has a small muted
 *  sub-line (kind/date) so an executive can act without opening the
 *  app; overflow past MAX_ROWS_PER_SECTION collapses into "+ N more". */
export function pendingDigestFlex(args: {
  branchName: string;
  reportDate: string;          // YYYY-MM-DD Bangkok
  digest: PendingDigest;
  headerColor?: string | null;
}): { type: "flex"; altText: string; contents: Record<string, unknown> } {
  const headerColor = args.headerColor || "#1a2b50";
  const total = args.digest.shiftChange.length + args.digest.leave.length + args.digest.ot.length;
  const altText =
    `สรุปคำขอค้าง ${total} รายการ · ${args.branchName}`;

  const section = (
    label: string, items: PendingDigestItem[]
  ): Array<Record<string, unknown>> => {
    const blocks: Array<Record<string, unknown>> = [
      {
        type: "box", layout: "baseline", margin: "lg",
        contents: [
          { type: "text", text: label, weight: "bold", size: "sm", color: "#1a2b50", flex: 0 },
          { type: "text", text: `${items.length} คน`, size: "xs", color: "#9a9a9a", align: "end", flex: 1 }
        ]
      }
    ];
    if (items.length === 0) {
      blocks.push({
        type: "text", text: "— ไม่มีคำขอค้าง —",
        size: "xs", color: "#b0b0b0", margin: "sm"
      });
      return blocks;
    }
    const visible = items.slice(0, MAX_ROWS_PER_SECTION);
    const overflow = items.length - visible.length;
    for (const it of visible) {
      blocks.push({
        type: "box", layout: "vertical", margin: "md",
        contents: [
          {
            type: "text",
            text: `•  ${it.name}`,
            size: "sm", color: "#1a1a2e", weight: "bold", wrap: true
          },
          {
            type: "text",
            text: it.ref ? `${it.detail} · ${it.ref}` : it.detail,
            size: "xxs", color: "#888888", wrap: true, margin: "none"
          }
        ]
      });
    }
    if (overflow > 0) {
      blocks.push({
        type: "text", text: `+ อีก ${overflow} รายการ`,
        size: "xxs", color: "#888888", margin: "sm"
      });
    }
    return blocks;
  };

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: headerColor,
        contents: [
          { type: "text", text: "สรุปคำขอค้าง — รอดำเนินการ", size: "xs", color: "#c9b27a", weight: "bold" },
          { type: "text", text: args.branchName, size: "lg", color: "#ffffff", weight: "bold", margin: "xs", wrap: true },
          { type: "text", text: `ประจำวันที่ ${args.reportDate}`, size: "xxs", color: "#c9b27a", margin: "xs" }
        ]
      },
      body: {
        type: "box", layout: "vertical", spacing: "none", paddingAll: "16px",
        contents: [
          ...section("คำขอเปลี่ยนเวลางาน", args.digest.shiftChange),
          { type: "separator", margin: "lg", color: "#eeeeee" },
          ...section("คำขอลางานรออนุมัติ", args.digest.leave),
          { type: "separator", margin: "lg", color: "#eeeeee" },
          ...section("คำขอทำงานล่วงเวลา", args.digest.ot)
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          {
            type: "button", style: "primary", color: headerColor, height: "sm",
            action: {
              type: "uri",
              label: "เปิด PERSONA เพื่อดำเนินการ",
              uri: `${PUBLIC_BASE}/admin/persona/shift-requests`
            }
          }
        ]
      }
    }
  };
}

/** Idempotency gate — mirrors isDailySummaryDue().
 *    pending_digest_time NULL/blank → disabled, never due.
 *    last_sent_date == today        → already sent today, skip.
 *    now_hhmm < digest_time         → not time yet.
 *    otherwise                      → due. */
export function isPendingDigestDue(
  branch: Branch,
  nowHhmmBkk: string,
  todayBkk: string
): boolean {
  const t = branch.pending_digest_time;
  if (!t || !t.trim()) return false;
  if (branch.pending_digest_last_sent_date === todayBkk) return false;
  if (nowHhmmBkk < t) return false;
  return true;
}

export function markPendingDigestSent(branchId: number, dateBkk: string): void {
  getDb().prepare(
    "UPDATE branches SET pending_digest_last_sent_date = ? WHERE id = ?"
  ).run(dateBkk, branchId);
}
