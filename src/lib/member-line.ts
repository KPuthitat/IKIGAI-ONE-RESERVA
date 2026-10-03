// INSIGNA membership — LINE reports and member messages (owner 2026-10-03,
// phase 4). Three sends, all PIN-gated in the API:
//   • the member report to the branch's HOD LINE group (platform OA);
//   • a birthday greeting to consenting members born this month (once a year);
//   • a "we miss you" note to consenting members gone quiet (at most every
//     30 days).
// Member pushes go through the branch OA the member signed up with. Nothing
// here stores a name; the card link is the member's own token.
//
// Lives outside src/lib/insigna so the import graph stays acyclic
// (line.ts → insigna; this file → line.ts + insigna, like salesa-line.ts).

import { getDb } from "./db";
import { pushToCustomer, type LineFlexMessage } from "./line";
import { notifySalesaHod } from "./salesa-line";
import { lineUserIdsForHashes, getOrCreateMemberLink, type MemberReport, type MemberRow } from "./insigna";

export type MemberMessageKind = "birthday" | "winback";

export const DEFAULT_BIRTHDAY_TEXT = "สุขสันต์วันเกิดค่ะ ขอให้ปีนี้เป็นปีที่ดี มีสุขภาพแข็งแรง แวะมาให้เราดูแลในเดือนเกิดนะคะ แสดงบัตรสมาชิกกับพนักงานเพื่อรับสิทธิพิเศษวันเกิดค่ะ";
export const DEFAULT_WINBACK_TEXT = "ไม่ได้เจอกันนานเลยค่ะ คิดถึงนะคะ กลับมาให้เราดูแลอีกครั้ง แสดงบัตรสมาชิกกับพนักงานได้เลยค่ะ";

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/+$/, "");
const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";
const intTh = (n: number) => n.toLocaleString("th-TH");

// ── message texts (system_settings) ─────────────────────────────────────────

export type MemberMessageConfig = { birthday_text: string; winback_text: string; birthday_custom: boolean; winback_custom: boolean };

export function getMemberMessageConfig(): MemberMessageConfig {
  const row = getDb().prepare("SELECT insigna_member_birthday_text AS b, insigna_member_winback_text AS w FROM system_settings WHERE id = 1")
    .get() as { b: string | null; w: string | null } | undefined;
  const b = row?.b?.trim() || null, w = row?.w?.trim() || null;
  return { birthday_text: b ?? DEFAULT_BIRTHDAY_TEXT, winback_text: w ?? DEFAULT_WINBACK_TEXT, birthday_custom: !!b, winback_custom: !!w };
}

export function saveMemberMessageConfig(patch: { birthday_text?: string | null; winback_text?: string | null }): MemberMessageConfig {
  const db = getDb();
  if (patch.birthday_text !== undefined) db.prepare("UPDATE system_settings SET insigna_member_birthday_text = ? WHERE id = 1").run(patch.birthday_text?.trim().slice(0, 500) || null);
  if (patch.winback_text !== undefined) db.prepare("UPDATE system_settings SET insigna_member_winback_text = ? WHERE id = 1").run(patch.winback_text?.trim().slice(0, 500) || null);
  return getMemberMessageConfig();
}

// ── Flex builders ───────────────────────────────────────────────────────────

function kv(label: string, value: string, bold = false): unknown {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: "sm", color: "#666666", flex: 5, wrap: true },
      { type: "text", text: value, size: "sm", color: "#1a1a2e", weight: bold ? "bold" : "regular", align: "end", flex: 4, wrap: true }
    ]
  };
}
const sep = { type: "separator", margin: "md", color: "#eeeeee" };

/** The member report pushed to the HOD group. */
export function memberReportFlex(r: MemberReport, meta: { branchName: string; operator: string; color: string }): LineFlexMessage {
  const withVisits = r.rows.filter((m) => m.pattern);
  const top = [...withVisits].sort((a, b) => b.pattern!.spendYear - a.pattern!.spendYear).slice(0, 5);
  const quiet = withVisits.filter((m) => m.pattern!.overdue).map((m) => m.member_code);
  const birthdays = r.birthdays.map((b) => `${b.day} ${TH_MONTHS[r.month]} · ${b.member_code}`);
  const list = (title: string, items: string[]): unknown[] => items.length ? [
    { type: "text", text: title, size: "xs", weight: "bold", color: "#0e2724", margin: "md" },
    ...items.slice(0, 8).map((t) => ({ type: "text", text: `• ${t}`, size: "xs", color: "#333333", wrap: true })),
    ...(items.length > 8 ? [{ type: "text", text: `และอีก ${items.length - 8} ราย`, size: "xxs", color: "#999999" }] : [])
  ] : [];
  const contents = {
    type: "bubble", size: "giga",
    header: {
      type: "box", layout: "vertical", backgroundColor: meta.color, paddingAll: "16px", spacing: "xs",
      contents: [
        { type: "text", text: "NOKHOOK OS · INSIGNA สมาชิก", size: "xxs", color: "#ffffff99" },
        { type: "text", text: `รายงานสมาชิก ${TH_MONTHS[r.month]} พ.ศ. ${r.year + 543}`, size: "lg", weight: "bold", color: "#ffffff" },
        { type: "text", text: `${meta.branchName} · บิลที่${r.branchId ? "สาขานี้" : "ทุกสาขา"}`, size: "xs", color: "#ffffffcc", wrap: true }
      ]
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
      contents: [
        kv("สมาชิกทั้งหมด", `${intTh(r.summary.members)} ราย`, true),
        kv("สมัครใหม่เดือนนี้", `${intTh(r.summary.newThisMonth)} ราย`),
        kv("ยินยอมรับข่าวสาร", `${intTh(r.summary.consented)} ราย`),
        sep,
        kv(`มาใช้บริการปี ${r.year + 543}`, `${intTh(r.summary.visitsYear)} ครั้ง`),
        kv("ยอดสมาชิกปีนี้", baht(r.summary.spendYear), true),
        kv("มีประวัติบิล", `${intTh(r.summary.withVisits)} ราย`),
        sep,
        ...list(`เกิดเดือน${TH_MONTHS[r.month]} (${r.birthdays.length})`, birthdays),
        ...list(`เงียบนานกว่ารอบปกติ (${quiet.length})`, quiet),
        ...list("ยอดสูงสุดปีนี้", top.map((m) => `${m.member_code} · ${baht(m.pattern!.spendYear)} (${m.pattern!.visitsYear} ครั้ง)`))
      ]
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "10px",
      contents: [{ type: "text", text: `ส่งโดย ${meta.operator} · ทุกรายการเป็นหมายเลขสมาชิก ไม่มีชื่อ`, size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }]
    }
  };
  return { type: "flex", altText: `รายงานสมาชิก ${TH_MONTHS[r.month]} พ.ศ. ${r.year + 543} · ${meta.branchName}`, contents };
}

/** The greeting / win-back card pushed to one member. */
export function memberMessageFlex(args: { kind: MemberMessageKind; text: string; branchName: string; cardUrl: string; headerColor?: string | null }): LineFlexMessage {
  const title = args.kind === "birthday" ? "สุขสันต์วันเกิด" : "คิดถึงนะคะ";
  const color = args.headerColor || "#281a0e";
  return {
    type: "flex",
    altText: `${title} · ${args.branchName}`,
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: color, paddingAll: "20px",
        contents: [
          { type: "text", text: "IKIGAI", color: "#d6a14d", size: "xxs", weight: "bold" },
          { type: "text", text: title, color: "#ffffff", size: "lg", weight: "bold", wrap: true, margin: "md" }
        ]
      },
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        contents: [
          { type: "text", text: args.branchName, weight: "bold", size: "md", color: "#1a1a2e", wrap: true },
          { type: "text", text: args.text, size: "sm", color: "#1a1a2e", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px",
        contents: [{ type: "button", style: "primary", color: "#a06820", height: "sm", action: { type: "uri", label: "เปิดบัตรสมาชิก", uri: args.cardUrl } }]
      },
      styles: { header: { backgroundColor: color }, body: { backgroundColor: "#ffffff" }, footer: { backgroundColor: "#ffffff", separator: true, separatorColor: "#e2e8f0" } }
    }
  };
}

// ── targets + sends ─────────────────────────────────────────────────────────

function lastPushAt(hash: string, kind: MemberMessageKind): string | null {
  const r = getDb().prepare("SELECT MAX(sent_at) AS t FROM insigna_member_pushes WHERE customer_hash = ? AND kind = ?").get(hash, kind) as { t: string | null };
  return r.t;
}

/** Members a send would reach now: consented, in the audience, and not
 *  already messaged in the guard window (birthday: this calendar year;
 *  win-back: the last 30 days). */
export function memberPushTargets(report: MemberReport, kind: MemberMessageKind, todayIso: string): MemberRow[] {
  const yearPrefix = todayIso.slice(0, 4);
  const cutoff30 = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 30 * 86_400_000).toISOString();
  return report.rows.filter((m) => {
    if (!m.consent_marketing || !m.signup_branch_id) return false;
    if (kind === "birthday" ? !m.birthdayThisMonth : !m.pattern?.overdue) return false;
    const last = lastPushAt(m.customer_hash, kind);
    if (!last) return true;
    return kind === "birthday" ? !last.startsWith(yearPrefix) : last < cutoff30;
  });
}

export type MemberSendResult = { sent: number; skipped: number; reasons: Record<string, number> };

/** Push the message to every target and record each send. */
export async function sendMemberMessages(args: { kind: MemberMessageKind; targets: MemberRow[]; text: string; sentBy: number | null }): Promise<MemberSendResult> {
  const db = getDb();
  const ids = lineUserIdsForHashes(args.targets.map((t) => t.customer_hash));
  const branchNames = new Map<number, { name: string; brand_color: string | null }>();
  const branchOf = (id: number) => {
    if (!branchNames.has(id)) {
      const b = db.prepare("SELECT name, brand_color FROM branches WHERE id = ?").get(id) as { name: string; brand_color: string | null } | undefined;
      branchNames.set(id, b ?? { name: "IKIGAI", brand_color: null });
    }
    return branchNames.get(id)!;
  };
  const res: MemberSendResult = { sent: 0, skipped: 0, reasons: {} };
  const skip = (why: string) => { res.skipped++; res.reasons[why] = (res.reasons[why] ?? 0) + 1; };
  const rec = db.prepare("INSERT INTO insigna_member_pushes (customer_hash, kind, sent_by) VALUES (?, ?, ?)");
  for (const t of args.targets) {
    const lineId = ids.get(t.customer_hash);
    const branchId = t.signup_branch_id;
    if (!lineId || !branchId) { skip("no_line_id"); continue; }
    const b = branchOf(branchId);
    const cardUrl = `${PUBLIC_BASE}/m?t=${encodeURIComponent(getOrCreateMemberLink(lineId, branchId))}`;
    const flex = memberMessageFlex({ kind: args.kind, text: args.text, branchName: b.name, cardUrl, headerColor: b.brand_color });
    const r = await pushToCustomer(branchId, lineId, [flex]);
    if (r.ok) { rec.run(t.customer_hash, args.kind, args.sentBy); res.sent++; }
    else skip(r.skipped ?? "push_failed");
  }
  return res;
}

/** Record a push without sending (for tests and dry runs). */
export function recordMemberPush(hash: string, kind: MemberMessageKind, sentBy: number | null = null): void {
  getDb().prepare("INSERT INTO insigna_member_pushes (customer_hash, kind, sent_by) VALUES (?, ?, ?)").run(hash, kind, sentBy);
}

/** Push the member report to a HOD group. */
export async function sendMemberReport(groupId: string, flex: LineFlexMessage): Promise<{ ok: boolean; error?: string }> {
  return notifySalesaHod(groupId, flex);
}
