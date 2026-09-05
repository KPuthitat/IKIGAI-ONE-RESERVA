// แจ้งเตือนกลุ่ม LINE เมื่อทำรายการในเชคลิสต์ที่ประชุมเสร็จ (owner 2026-09-05).
//
// เมื่อผู้รับผิดชอบ (หรือแอดมิน) กดว่า "ทำแล้ว" สำหรับ action item ของการประชุม
// ระบบจะส่งการ์ดแจ้งเตือนไปยังกลุ่มพนักงานที่ผูกไว้ เพื่อให้ทีมเห็นความคืบหน้าของ
// มติที่ประชุมแบบเรียลไทม์ · การประชุมของสาขา → การ์ดพร้อมสีสาขา, ส่งเข้ากลุ่มรวม
// (routing="global") ตามแนวทางเดียวกับการแจ้งเตือน PERSONA อื่น ๆ; การประชุมระดับ
// บริษัท (ไม่ระบุสาขา) → ส่งเข้ากลุ่มพนักงานรวมโดยตรง. Fire-and-forget ทั้งหมด.

import type Database from "better-sqlite3";
import { getSystemSettings, type Branch } from "@/lib/db";
import { getPlatformChannel } from "@/lib/messaging-channels";
import { decryptSecret } from "@/lib/secret-vault";
import { sendLinePush, notifyToStaffGroup, type LineFlexMessage } from "@/lib/line";
import { nameWithPrefix } from "@/lib/name";

type DoneRow = {
  item_title: string;
  meeting_id: number;
  meeting_title: string;
  branch_id: number | null;
  branch_name: string | null;
  brand_color: string | null;
};

function row(label: string, value: string) {
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8c8c8c", size: "xs", flex: 3 },
      { type: "text", text: value, color: "#333333", size: "xs", flex: 7, wrap: true }
    ]
  };
}

function buildDoneFlex(args: {
  itemTitle: string; meetingTitle: string; branchName: string | null;
  doneByName: string; remaining: number; headerColor: string;
}): LineFlexMessage {
  const bodyContents: unknown[] = [
    { type: "text", text: args.itemTitle, weight: "bold", size: "md", wrap: true, color: "#111827" },
    { type: "separator", margin: "md" },
    { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: [
      row("การประชุม", args.meetingTitle),
      row("สาขา", args.branchName ?? "ทุกสาขา"),
      row("ผู้ดำเนินการ", args.doneByName),
      row("คงเหลือ", args.remaining > 0 ? `อีก ${args.remaining} รายการ` : "ครบทุกรายการแล้ว")
    ] }
  ];
  return {
    type: "flex",
    altText: `ดำเนินการเสร็จแล้ว: ${args.itemTitle}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", paddingAll: "12px",
        backgroundColor: args.headerColor,
        contents: [
          { type: "text", text: "ดำเนินการรายการในเชคลิสต์เสร็จแล้ว", weight: "bold", color: "#ffffff", size: "sm", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: bodyContents }
    }
  };
}

/**
 * Push a "checklist item completed" card to the linked staff group.
 * Fire-and-forget: never throws to the caller. Call AFTER the item's status has
 * been set to 'done'. `doneByUserId` is who marked it complete.
 */
export async function notifyMeetingItemDone(
  db: Database.Database, itemId: number, doneByUserId: number
): Promise<void> {
  try {
    const r = db.prepare(`
      SELECT ai.title AS item_title, m.id AS meeting_id, m.title AS meeting_title,
             m.branch_id, b.name AS branch_name, b.brand_color
      FROM meeting_action_items ai
      JOIN meetings m ON m.id = ai.meeting_id
      LEFT JOIN branches b ON b.id = m.branch_id
      WHERE ai.id = ?
    `).get(itemId) as DoneRow | undefined;
    if (!r) return;

    const remaining = (db.prepare(
      "SELECT COUNT(*) AS c FROM meeting_action_items WHERE meeting_id = ? AND status = 'open'"
    ).get(r.meeting_id) as { c: number }).c;

    const doneBy = db.prepare(
      "SELECT display_name, title_prefix FROM users WHERE id = ?"
    ).get(doneByUserId) as { display_name: string; title_prefix: string | null } | undefined;

    const flex = buildDoneFlex({
      itemTitle: r.item_title,
      meetingTitle: r.meeting_title,
      branchName: r.branch_name,
      doneByName: doneBy ? nameWithPrefix(doneBy.title_prefix, doneBy.display_name) : "—",
      remaining,
      headerColor: r.brand_color || "#0B1F3A"
    });

    if (r.branch_id) {
      // Branch meeting → shared staff group (branch identity is on the card),
      // falling back to the branch's own group when the global OA isn't set.
      const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(r.branch_id) as Branch | undefined;
      if (branch) await notifyToStaffGroup(branch, flex, "global");
      return;
    }

    // Company-wide meeting → push straight to the shared staff group.
    const platform = getPlatformChannel();
    const sys = getSystemSettings();
    const token = platform?.channel_token ?? decryptSecret(sys.global_line_channel_token) ?? null;
    const groupId = sys.global_staff_group_id ?? null;
    if (token && groupId) await sendLinePush(token, { to: groupId, messages: [flex] });
  } catch (e) {
    console.warn("[meetings-notify] item-done push failed:", e);
  }
}
