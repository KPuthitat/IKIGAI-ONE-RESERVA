// แจ้งเตือนกลุ่ม LINE เรื่องเชคลิสต์ที่ประชุม (owner 2026-09-05).
//
//  • notifyMeetingChecklist — โพสต์เชคลิสต์ทั้งชุดเข้ากลุ่มเมื่อแอดมินกด "ส่งเข้ากลุ่ม"
//    (เห็นงานที่ต้องทำตั้งแต่ต้น) — คืนผลลัพธ์ให้ปุ่มบอกสถานะได้
//  • notifyMeetingItemDone — แจ้งเมื่อทำรายการเสร็จ (fire-and-forget)
//
// การประชุมของสาขา → ส่งเข้ากลุ่มพนักงานรวม (การ์ดโชว์สาขา) โดย fallback ไปกลุ่มของ
// สาขาเองเมื่อยังไม่ตั้งกลุ่มรวม; การประชุมระดับบริษัท → ส่งเข้ากลุ่มพนักงานรวมโดยตรง.

import type Database from "better-sqlite3";
import { getSystemSettings, type Branch } from "@/lib/db";
import { getPlatformChannel } from "@/lib/messaging-channels";
import { decryptSecret } from "@/lib/secret-vault";
import { sendLinePush, notifyToStaffGroup, type LineFlexMessage } from "@/lib/line";
import { nameWithPrefix } from "@/lib/name";

export type NotifyResult = { ok: boolean; reason?: "no_group" | "send_failed" | "not_found" | "empty" };

function kvRow(label: string, value: string) {
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8c8c8c", size: "xs", flex: 3 },
      { type: "text", text: value, color: "#333333", size: "xs", flex: 7, wrap: true }
    ]
  };
}

/**
 * Push a flex card to the linked staff group. Branch meeting → shared group with
 * the branch shown on the card (falls back to the branch's own group); company-
 * wide meeting → straight to the shared staff group. Returns a result so a
 * button can report whether the group is configured / the push landed.
 */
async function pushToLinkedGroup(
  db: Database.Database, branchId: number | null, flex: LineFlexMessage
): Promise<NotifyResult> {
  try {
    if (branchId) {
      const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined;
      if (!branch) return { ok: false, reason: "no_group" };
      // notifyToStaffGroup("global") pushes to the shared group, throwing on a
      // real push failure and silently falling back to the branch group when the
      // global OA isn't configured.
      await notifyToStaffGroup(branch, flex, "global");
      return { ok: true };
    }
    const platform = getPlatformChannel();
    const sys = getSystemSettings();
    const token = platform?.channel_token ?? decryptSecret(sys.global_line_channel_token) ?? null;
    const groupId = sys.global_staff_group_id ?? null;
    if (!token || !groupId) return { ok: false, reason: "no_group" };
    const res = await sendLinePush(token, { to: groupId, messages: [flex] });
    return res.ok ? { ok: true } : { ok: false, reason: "send_failed" };
  } catch {
    return { ok: false, reason: "send_failed" };
  }
}

// ── Card builders ────────────────────────────────────────────────────

function buildItemDoneFlex(args: {
  itemTitle: string; meetingTitle: string; branchName: string | null;
  doneByName: string; remaining: number; headerColor: string;
}): LineFlexMessage {
  return {
    type: "flex",
    altText: `ดำเนินการเสร็จแล้ว: ${args.itemTitle}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: args.headerColor,
        contents: [{ type: "text", text: "ดำเนินการรายการในเชคลิสต์เสร็จแล้ว", weight: "bold", color: "#ffffff", size: "sm", wrap: true }]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          { type: "text", text: args.itemTitle, weight: "bold", size: "md", wrap: true, color: "#111827" },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: [
            kvRow("การประชุม", args.meetingTitle),
            kvRow("สาขา", args.branchName ?? "ทุกสาขา"),
            kvRow("ผู้ดำเนินการ", args.doneByName),
            kvRow("คงเหลือ", args.remaining > 0 ? `อีก ${args.remaining} รายการ` : "ครบทุกรายการแล้ว")
          ] }
        ]
      }
    }
  };
}

function buildChecklistFlex(args: {
  meetingTitle: string; meetingDate: string; branchName: string | null;
  items: Array<{ title: string; assignee: string | null; due: string | null }>;
  headerColor: string;
}): LineFlexMessage {
  const itemLines = args.items.map((it, i) => ({
    type: "box", layout: "vertical", spacing: "none",
    margin: i === 0 ? "none" : "md",
    contents: [
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: `${i + 1}.`, color: "#8c8c8c", size: "sm", flex: 0 },
        { type: "text", text: it.title, size: "sm", color: "#111827", wrap: true, flex: 1 }
      ] },
      ...(it.assignee || it.due ? [{
        type: "text",
        text: [it.assignee ? `ผู้รับผิดชอบ: ${it.assignee}` : null, it.due ? `ครบกำหนด: ${it.due}` : null]
          .filter(Boolean).join("  ·  "),
        size: "xs", color: "#8c8c8c", margin: "xs", wrap: true
      }] : [])
    ]
  }));
  return {
    type: "flex",
    altText: `เชคลิสต์งานหลังการประชุม: ${args.meetingTitle}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: args.headerColor,
        contents: [
          { type: "text", text: "เชคลิสต์งานหลังการประชุม", weight: "bold", color: "#ffffff", size: "sm" },
          { type: "text", text: args.meetingTitle, color: "#ffffff", size: "xs", wrap: true, margin: "xs" }
        ]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
        contents: [
          { type: "box", layout: "baseline", spacing: "sm", contents: [
            { type: "text", text: "สาขา", color: "#8c8c8c", size: "xs", flex: 3 },
            { type: "text", text: `${args.branchName ?? "ทุกสาขา"}  ·  ${args.meetingDate}`, color: "#333333", size: "xs", flex: 7, wrap: true }
          ] },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", margin: "md", contents: itemLines },
          { type: "text", text: "เมื่อทำรายการใดเสร็จ ระบบจะแจ้งความคืบหน้าในกลุ่มนี้อัตโนมัติ", size: "xxs", color: "#aaaaaa", wrap: true, margin: "lg" }
        ]
      }
    }
  };
}

// ── Public API ───────────────────────────────────────────────────────

type ItemDoneRow = {
  item_title: string; meeting_id: number; meeting_title: string;
  branch_id: number | null; branch_name: string | null; brand_color: string | null;
};

/** Notify the linked group that a checklist item was completed. Fire-and-forget. */
export async function notifyMeetingItemDone(
  db: Database.Database, itemId: number, doneByUserId: number
): Promise<void> {
  const r = db.prepare(`
    SELECT ai.title AS item_title, m.id AS meeting_id, m.title AS meeting_title,
           m.branch_id, b.name AS branch_name, b.brand_color
    FROM meeting_action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    LEFT JOIN branches b ON b.id = m.branch_id
    WHERE ai.id = ?
  `).get(itemId) as ItemDoneRow | undefined;
  if (!r) return;

  const remaining = (db.prepare(
    "SELECT COUNT(*) AS c FROM meeting_action_items WHERE meeting_id = ? AND status = 'open'"
  ).get(r.meeting_id) as { c: number }).c;
  const doneBy = db.prepare(
    "SELECT display_name, title_prefix FROM users WHERE id = ?"
  ).get(doneByUserId) as { display_name: string; title_prefix: string | null } | undefined;

  const flex = buildItemDoneFlex({
    itemTitle: r.item_title, meetingTitle: r.meeting_title, branchName: r.branch_name,
    doneByName: doneBy ? nameWithPrefix(doneBy.title_prefix, doneBy.display_name) : "—",
    remaining, headerColor: r.brand_color || "#0B1F3A"
  });
  await pushToLinkedGroup(db, r.branch_id, flex);
}

/** Post the whole checklist (open items) to the linked group. Returns a result
 *  the "ส่งเข้ากลุ่ม" button can surface. */
export async function notifyMeetingChecklist(
  db: Database.Database, meetingId: number
): Promise<NotifyResult> {
  const m = db.prepare(`
    SELECT m.title, m.meeting_date, m.branch_id, b.name AS branch_name, b.brand_color
    FROM meetings m LEFT JOIN branches b ON b.id = m.branch_id
    WHERE m.id = ?
  `).get(meetingId) as
    { title: string; meeting_date: string; branch_id: number | null; branch_name: string | null; brand_color: string | null } | undefined;
  if (!m) return { ok: false, reason: "not_found" };

  const items = db.prepare(`
    SELECT ai.title, u.display_name AS assignee_name, u.title_prefix AS assignee_prefix, ai.due_date
    FROM meeting_action_items ai
    LEFT JOIN users u ON u.id = ai.assignee_user_id
    WHERE ai.meeting_id = ? AND ai.status = 'open'
    ORDER BY ai.sort_order ASC, ai.id ASC
    LIMIT 50
  `).all(meetingId) as Array<{ title: string; assignee_name: string | null; assignee_prefix: string | null; due_date: string | null }>;
  if (items.length === 0) return { ok: false, reason: "empty" };

  const flex = buildChecklistFlex({
    meetingTitle: m.title, meetingDate: m.meeting_date, branchName: m.branch_name,
    headerColor: m.brand_color || "#0B1F3A",
    items: items.map((it) => ({
      title: it.title,
      assignee: it.assignee_name ? nameWithPrefix(it.assignee_prefix, it.assignee_name) : null,
      due: it.due_date
    }))
  });
  return pushToLinkedGroup(db, m.branch_id, flex);
}
