// Time-certification decision notifier (2026-05-30).
//
// When an admin approves or rejects a staff's time-certification
// request, push a short LINE message to the staff so they know.
// Previously the decide route just updated the DB silently — staff
// only discovered the outcome by reopening the persona menu.
//
// Fire-and-forget: failures (no line_user_id, channel not ready,
// 429 quota, etc.) are console.warned and never thrown. The
// underlying decision is already committed; a missed notification
// is annoying but not data-loss.

import { getDb, getSystemSettings } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush } from "./line";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

// One "label: value" row for the Flex card body.
function infoRow(label: string, value: string): Record<string, unknown> {
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#94a3b8", flex: 3 },
      { type: "text", text: value, size: "sm", color: "#1e293b", weight: "bold", flex: 7, wrap: true }
    ]
  };
}

function bkkDisplay(iso: string): string {
  // Same helper as TimeCertificationsClient — "YYYY-MM-DD HH:MM"
  // in Bangkok time. Keep in sync if the format ever changes.
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 16).replace("T", " ");
}

type CertDecisionInput = {
  /** time_certifications.id — used purely for log context. */
  certId: number;
  /** Outcome — drives the message wording. */
  decision: "approved" | "rejected";
  /** Optional admin note attached to the decision. Shown to the
   *  staff so they understand the "why" without having to ask. */
  decisionNote: string | null;
};

export async function notifyTimeCertDecision(input: CertDecisionInput): Promise<void> {
  const db = getDb();

  // Pull everything we need in one query: requester's LINE id + name
  // + the original/proposed timestamps + entry type. Joins are cheap
  // and keep the caller site simple (just pass certId).
  const row = db.prepare(`
    SELECT
      u.line_user_id     AS line_user_id,
      u.display_name     AS display_name,
      u.nickname_th      AS nickname_th,
      c.proposed_ts      AS proposed_ts,
      c.original_ts      AS original_ts,
      e.type             AS entry_type
    FROM time_certifications c
    JOIN users u ON u.id = c.requested_by
    JOIN time_entries e ON e.id = c.entry_id
    WHERE c.id = ?
  `).get(input.certId) as
    | {
        line_user_id: string | null;
        display_name: string;
        nickname_th: string | null;
        proposed_ts: string;
        original_ts: string;
        entry_type: "in" | "out";
      }
    | undefined;

  if (!row) {
    console.warn(`[time-cert-notify] cert#${input.certId} row not found`);
    return;
  }
  if (!row.line_user_id) {
    // Staff hasn't added the OA as a friend yet — silent skip, the
    // outcome is still in the persona menu for them to discover.
    return;
  }

  const channel = getPlatformChannel();
  if (!isChannelReady(channel) || !channel || !channel.channel_token) {
    console.warn(`[time-cert-notify] platform channel not ready, skipping cert#${input.certId}`);
    return;
  }

  const nick = row.nickname_th?.trim() || "";
  const greet = nick ? `พี่${nick}` : "พี่";
  const entryLabelTh = row.entry_type === "in" ? "เข้างาน" : "ออกงาน";

  const text = input.decision === "approved"
    ? [
        `✅ คำขอแก้ไขเวลา${entryLabelTh} ของ${greet}ได้รับการอนุมัติแล้วครับ`,
        ``,
        `เวลาเดิม:  ${bkkDisplay(row.original_ts)}`,
        `เวลาใหม่:  ${bkkDisplay(row.proposed_ts)}`,
        input.decisionNote ? `\nหมายเหตุจากแอดมิน:\n${input.decisionNote}` : ``
      ].filter(Boolean).join("\n")
    : [
        `❌ คำขอแก้ไขเวลา${entryLabelTh} ของ${greet}ถูกปฏิเสธครับ`,
        ``,
        `เวลาเดิม (ไม่ถูกแก้):  ${bkkDisplay(row.original_ts)}`,
        input.decisionNote
          ? `\nเหตุผลจากแอดมิน:\n${input.decisionNote}`
          : `\nหากต้องการรายละเอียดเพิ่มเติม กรุณาสอบถามแอดมิน`
      ].filter(Boolean).join("\n");

  const result = await sendLinePush(channel.channel_token, {
    to: row.line_user_id,
    messages: [{ type: "text", text }]
  });

  if (!result.ok) {
    console.warn(
      `[time-cert-notify] cert#${input.certId} push failed: status=${result.status} error=${result.error}`
    );
  }
}

// Alert the HR / exec LINE group ("IKIGAI RECRUIT x HR") when a staff
// SUBMITS a time-certification request, so an admin actually goes and
// approves it (owner 2026-06-10: certs were sitting unapproved because
// nothing flagged them → the certified time never reached payroll).
// Reuses system_settings.recruita_exec_group_id (the combined HR group)
// + the IKIGAI OS platform OA. Fire-and-forget; silent no-op when the
// group / OA isn't configured.
export async function notifyExecGroupTimeCertRequest(certId: number): Promise<void> {
  const groupId = getSystemSettings().recruita_exec_group_id?.trim();
  if (!groupId) return;
  const channel = getPlatformChannel();
  if (!isChannelReady(channel) || !channel?.channel_token) return;

  const db = getDb();
  const row = db.prepare(`
    SELECT c.kind, c.work_date, c.proposed_ts,
           COALESCE(e.type, c.entry_type) AS entry_type,
           u.display_name, u.title_prefix
    FROM time_certifications c
    JOIN users u ON u.id = c.requested_by
    LEFT JOIN time_entries e ON e.id = c.entry_id
    WHERE c.id = ?
  `).get(certId) as
    | {
        kind: "correction" | "missing"; work_date: string | null; proposed_ts: string;
        entry_type: "in" | "out" | null; display_name: string; title_prefix: string | null;
      }
    | undefined;
  if (!row) return;

  const who = [row.title_prefix, row.display_name].filter(Boolean).join(" ") || "พนักงาน";
  const what = row.entry_type === "out" ? "เวลาออกงาน" : "เวลาเข้างาน";
  const kindTh = row.kind === "missing" ? "เพิ่มเวลาที่ลืมลง" : "แก้ไขเวลา";
  const when = bkkDisplay(row.proposed_ts);

  // Flex card with a button straight to the approval page (owner 2026-06-15).
  // No emoji — supplementary-plane glyphs got mangled into "\uD83D…" on the
  // group push, and the owner wants a clean card anyway.
  const flex = {
    type: "flex" as const,
    altText: `คำขอรับรองเวลา: ${who} (${kindTh} ${what})`,
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", paddingAll: "16px", backgroundColor: "#a06820",
        contents: [
          { type: "text", text: "คำขอรับรองเวลา", color: "#ffffff", weight: "bold", size: "md" },
          { type: "text", text: "รออนุมัติ", color: "#ffffff", size: "xs", margin: "xs" }
        ]
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", backgroundColor: "#ffffff",
        contents: [
          infoRow("พนักงาน", who),
          infoRow("รายการ", `${kindTh} (${what})`),
          infoRow("เวลาที่ขอ", `${when} น.`)
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: "#ffffff",
        contents: [
          {
            type: "button", style: "primary", color: "#a06820", height: "sm",
            action: { type: "uri", label: "ตอบรับคำขอ", uri: `${PUBLIC_BASE}/admin/persona/time-certifications` }
          }
        ]
      }
    }
  };

  const res = await sendLinePush(channel.channel_token, {
    to: groupId,
    messages: [flex]
  });
  if (!res.ok) {
    console.warn(`[time-cert-notify] exec-group cert#${certId} push failed: status=${res.status} error=${res.error}`);
  }
}
