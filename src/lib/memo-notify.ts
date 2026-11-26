// LINE notices for the memo flow (best effort; the in-app "to sign" list and the menu badge are the reliable signal).
import { getDb } from "./db";
import { noticeFlex, pushIndividually } from "./special-duty-notify";
import { approverRecipients, userLine, type PrRow } from "./purchasing";
import type { MemoRow } from "./memos";

const base = () => (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "https://ikigaimedihealth.com").replace(/\/$/, "");
const fmt = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const url = (id: number) => `${base()}/admin/memos?id=${id}`;
const warn = (what: string) => (e: unknown) => console.error(`memo notify ${what}`, e);

/** Everyone who must sign is told (each one gets their own push). */
export function notifySigners(m: MemoRow): void {
  const rows = getDb().prepare("SELECT s.user_id FROM memo_signers s WHERE s.memo_id = ? AND s.status = 'pending' ORDER BY s.sort_no").all(m.id) as Array<{ user_id: number }>;
  void pushIndividually(rows.map((r) => userLine(r.user_id)), noticeFlex({
    title: "มี Memo รอท่านลงนาม",
    lines: [`${m.memoNo} · ${m.branchName}`, m.subject, `ยอดรวม ฿${fmt(m.total)}`, `ผู้ขอ: ${m.authorName}`],
    url: url(m.id), button: "ดูและลงลายมือชื่อ"
  })).catch(warn("signers"));
}

export function notifyAuthorApproved(m: MemoRow): void {
  void pushIndividually([userLine(m.authorId)], noticeFlex({
    title: "Memo ได้รับความเห็นชอบครบแล้ว",
    lines: [`${m.memoNo} · ${m.subject}`, `ยอดรวม ฿${fmt(m.total)}`, "กดเปิด PR ได้เลย ข้อมูลจะดึงมาจาก Memo"],
    url: url(m.id), button: "เปิด PR"
  })).catch(warn("approved"));
}

export function notifyAuthorRejected(m: MemoRow, byName: string, reason: string): void {
  void pushIndividually([userLine(m.authorId)], noticeFlex({
    title: "Memo ไม่ได้รับความเห็นชอบ",
    lines: [`${m.memoNo} · ${m.subject}`, `โดย ${byName}`, `เหตุผล: ${reason}`],
    url: url(m.id), button: "ดู Memo"
  })).catch(warn("rejected"));
}

/** The PR opened from a memo goes to the executives who approve PRs, exactly like a PR made by hand. */
export function notifyPrApprovers(pr: PrRow, memoNo: string): void {
  void pushIndividually(approverRecipients().map((a) => a.lineUserId), noticeFlex({
    title: "มีใบขอซื้อรออนุมัติ",
    lines: [`${pr.prNo} · ${pr.branchName}`, pr.title, `ยอดรวม ฿${fmt(pr.total)}${pr.overBudget ? " · เกินงบ" : ""}`, `จาก ${memoNo} (ลงนามครบแล้ว)`],
    url: `${base()}/admin/accounta/purchasing?pr=${pr.id}`, button: "ดูและอนุมัติ"
  })).catch(warn("pr approvers"));
}
