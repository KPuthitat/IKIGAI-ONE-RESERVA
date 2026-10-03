// INSIGNA — Membership (owner 2026-10-03: "เอาหมดเลย").
//
// A customer signs up from the branch LINE OA: the printed QR opens the OA
// with a prefilled "สมาชิก" keyword, the webhook answers with a card whose
// button opens /m/join?t=<link token>, and the sign-up page collects the
// minimum we keep — birthday as three numbers, gender, a coarse home area,
// how they found us, and the marketing consent. They get a member code
// YYMMXXXX (พ.ศ. year, month, sequence: 69100001 = first sign-up of ตุลาคม
// 2569) and a card with a QR that staff scan at checkout to tie the bill
// to the member.
//
// Privacy: no name is stored anywhere. The LINE userId lives only in the
// operational member_links table (outside the insigna_* wall); the member
// row is keyed by the usual customer_hash. member_code and scan_token are
// pseudonyms — the PII lint allows them.

import crypto from "node:crypto";
import { getDb } from "../db";
import { isCustomerHash, hashLineUserId } from "./hash";
import { upsertCustomer, deleteCustomer, type InsignaCustomer } from "./customers";
import { linkBill } from "./bills";
import { logInsignaEvent } from "./audit";

export type MemberGender = "M" | "F" | "X";

export type MemberProfile = InsignaCustomer & {
  member_code: string | null;
  member_since: string | null;
  birth_month: number | null;
  birth_day: number | null;
  home_area: string | null;
  consent_at: string | null;
  scan_token: string | null;
  signup_branch_id: number | null;
};

export const ACQUISITION_SOURCES = [
  { key: "friend", label: "เพื่อนหรือครอบครัวแนะนำ" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "google", label: "ค้นหาใน Google" },
  { key: "line", label: "LINE" },
  { key: "walkby", label: "เดินผ่านหน้าร้าน" },
  { key: "event", label: "งานหรือกิจกรรม" },
  { key: "other", label: "อื่น ๆ" }
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number]["key"];

const todayBkkIso = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** The 'YYMM' prefix of a member code for an ISO date: พ.ศ. year's last two
 *  digits + the month. 2026-10-03 → "6910". */
export function memberCodePrefix(iso: string): string {
  const y = Number(iso.slice(0, 4)) + 543;
  return `${String(y % 100).padStart(2, "0")}${iso.slice(5, 7)}`;
}

/** Issue the next member code for the month (transactional counter). */
export function issueMemberCode(iso: string = todayBkkIso()): string {
  const db = getDb();
  const ym = memberCodePrefix(iso);
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO insigna_member_seq (ym, last) VALUES (?, 0)").run(ym);
    db.prepare("UPDATE insigna_member_seq SET last = last + 1 WHERE ym = ?").run(ym);
    const last = (db.prepare("SELECT last FROM insigna_member_seq WHERE ym = ?").get(ym) as { last: number }).last;
    if (last > 9999) throw new Error("[INSIGNA] member code sequence exhausted for " + ym);
    return `${ym}${String(last).padStart(4, "0")}`;
  })();
}

export function isMemberCode(s: string): boolean {
  return /^\d{8}$/.test(s.trim());
}

function newScanToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function getMemberByHash(hash: string): MemberProfile | null {
  if (!isCustomerHash(hash)) return null;
  const r = getDb().prepare("SELECT * FROM insigna_customers WHERE customer_hash = ?").get(hash) as MemberProfile | undefined;
  return r ?? null;
}

export function getMemberByCode(code: string): MemberProfile | null {
  const c = code.trim();
  if (!isMemberCode(c)) return null;
  const r = getDb().prepare("SELECT * FROM insigna_customers WHERE member_code = ?").get(c) as MemberProfile | undefined;
  return r ?? null;
}

/** Resolve what a staff scanner read: the member-card QR URL (…/m/s/<token>),
 *  a bare scan token, or a typed member code. */
export function getMemberByScan(input: string): MemberProfile | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/m\/s\/([A-Za-z0-9_-]{8,})/);
  const token = m ? m[1] : s;
  const byToken = getDb().prepare("SELECT * FROM insigna_customers WHERE scan_token = ?").get(token) as MemberProfile | undefined;
  if (byToken) return byToken;
  return getMemberByCode(s);
}

export type RegisterMemberArgs = {
  customer_hash: string;
  signup_branch_id: number | null;
  birth_day: number | null;
  birth_month: number | null;
  birth_year: number | null;        // CE
  gender: MemberGender | null;
  home_area: string | null;
  acquisition_source: string | null;
  consent_marketing: boolean;
  todayIso?: string;
};

function cleanArea(s: string | null): string | null {
  const v = (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return v || null;
}

function validBirth(d: number | null, m: number | null): boolean {
  if (d == null && m == null) return true;
  return d != null && m != null && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** Create the member (or refresh an existing one's profile). Idempotent on
 *  the hash: a second sign-up keeps the original member code and date. */
export function registerMember(args: RegisterMemberArgs): MemberProfile {
  if (!isCustomerHash(args.customer_hash)) throw new Error("[INSIGNA] registerMember: bad hash");
  if (!validBirth(args.birth_day, args.birth_month)) throw new Error("[INSIGNA] registerMember: bad birthday");
  const db = getDb();
  const today = args.todayIso ?? todayBkkIso();
  upsertCustomer({
    customer_hash: args.customer_hash,
    birth_year: args.birth_year,
    gender: args.gender,
    consent_marketing: args.consent_marketing,
    consent_analytics: true,
    acquisition_source: args.acquisition_source
  });
  const existing = getMemberByHash(args.customer_hash)!;
  const code = existing.member_code ?? issueMemberCode(today);
  const since = existing.member_since ?? new Date().toISOString();
  const scan = existing.scan_token ?? newScanToken();
  db.prepare(`
    UPDATE insigna_customers
       SET member_code = ?, member_since = ?, birth_month = ?, birth_day = ?, home_area = ?,
           consent_at = COALESCE(consent_at, ?), scan_token = ?, signup_branch_id = COALESCE(signup_branch_id, ?)
     WHERE customer_hash = ?
  `).run(code, since, args.birth_month, args.birth_day, cleanArea(args.home_area), new Date().toISOString(), scan,
    args.signup_branch_id, args.customer_hash);
  logInsignaEvent({ event_type: existing.member_code ? "member.update" : "member.register", customer_hash: args.customer_hash, payload: { code } });
  return getMemberByHash(args.customer_hash)!;
}

/** Marketing consent flip from the member's own card (PDPA withdrawal). */
export function setMemberMarketingConsent(hash: string, consent: boolean): void {
  upsertCustomer({ customer_hash: hash, consent_marketing: consent });
}

/** A fresh scan token (the old QR stops working) — for a lost phone. */
export function rotateScanToken(hash: string): string {
  const t = newScanToken();
  getDb().prepare("UPDATE insigna_customers SET scan_token = ? WHERE customer_hash = ?").run(t, hash);
  return t;
}

// ── Operational link tokens (LINE userId ↔ member card URL) ─────────────────

/** The customer's persistent card link token — created on first use. */
export function getOrCreateMemberLink(lineUserId: string, branchId: number | null): string {
  const id = lineUserId.trim();
  if (!id) throw new Error("[INSIGNA] member link: lineUserId required");
  const db = getDb();
  const row = db.prepare("SELECT token FROM member_links WHERE line_user_id = ?").get(id) as { token: string } | undefined;
  if (row) return row.token;
  const token = crypto.randomBytes(16).toString("base64url");
  db.prepare("INSERT INTO member_links (line_user_id, token, branch_id) VALUES (?, ?, ?)").run(id, token, branchId);
  return token;
}

export type ResolvedMemberLink = { line_user_id: string; branch_id: number | null; customer_hash: string };

export function resolveMemberLink(token: string): ResolvedMemberLink | null {
  const t = token.trim();
  if (!t) return null;
  const row = getDb().prepare("SELECT line_user_id, branch_id FROM member_links WHERE token = ?").get(t) as { line_user_id: string; branch_id: number | null } | undefined;
  if (!row) return null;
  return { ...row, customer_hash: hashLineUserId(row.line_user_id) };
}

/** LINE userIds for a set of member hashes (for consented pushes). Walks the
 *  operational table and hashes each id — the only way back across the wall,
 *  and it never stores the pairing. */
export function lineUserIdsForHashes(hashes: string[]): Map<string, string> {
  const want = new Set(hashes);
  const out = new Map<string, string>();
  if (!want.size) return out;
  for (const r of getDb().prepare("SELECT line_user_id FROM member_links").all() as Array<{ line_user_id: string }>) {
    const h = hashLineUserId(r.line_user_id);
    if (want.has(h)) out.set(h, r.line_user_id);
  }
  return out;
}

/** Right to be forgotten from the member card: the INSIGNA rows (cascade),
 *  the bill links, pending links, and the operational link token. */
export function deleteMember(lineUserId: string): { deleted: boolean } {
  const db = getDb();
  const hash = hashLineUserId(lineUserId);
  const exists = db.prepare("SELECT 1 FROM insigna_customers WHERE customer_hash = ?").get(hash);
  db.transaction(() => {
    db.prepare("DELETE FROM insigna_customer_bills WHERE customer_hash = ?").run(hash);
    db.prepare("DELETE FROM insigna_pending_bills WHERE customer_hash = ?").run(hash);
    db.prepare("DELETE FROM member_links WHERE line_user_id = ?").run(lineUserId.trim());
    if (exists) deleteCustomer(hash);
  })();
  return { deleted: !!exists };
}

// ── Checkout links (staff scan the member QR, type the bill number) ─────────

export type PendingBillResult = "linked" | "pending" | "already_yours" | "linked_to_other" | "pending_other";

/** Tie a bill to a member at checkout. If the day's receipt file is already
 *  imported the link is immediate; otherwise it waits in insigna_pending_bills
 *  and resolves when the receipts arrive (resolvePendingBills). */
export function addMemberBill(args: { customer_hash: string; branch_id: number; sale_date: string; bill_no: string; linked_by?: number | null }): PendingBillResult {
  const db = getDb();
  const bill_no = args.bill_no.trim();
  const direct = linkBill({ ...args, bill_no });
  if (direct !== "receipt_not_found") return direct;
  const existing = db.prepare("SELECT customer_hash FROM insigna_pending_bills WHERE branch_id = ? AND sale_date = ? AND bill_no = ?")
    .get(args.branch_id, args.sale_date, bill_no) as { customer_hash: string } | undefined;
  if (existing) return existing.customer_hash === args.customer_hash ? "already_yours" : "pending_other";
  db.prepare("INSERT INTO insigna_pending_bills (customer_hash, branch_id, sale_date, bill_no, linked_by) VALUES (?, ?, ?, ?, ?)")
    .run(args.customer_hash, args.branch_id, args.sale_date, bill_no, args.linked_by ?? null);
  return "pending";
}

/** Turn pending checkout links into real bill links once the receipts exist.
 *  Scoped to a branch + date (called right after a receipt import) or global
 *  (nightly cron). Returns how many resolved. */
export function resolvePendingBills(branchId?: number, saleDate?: string): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.customer_hash, p.branch_id, p.sale_date, p.bill_no, p.linked_by
    FROM insigna_pending_bills p
    JOIN salesa_receipts r ON r.branch_id = p.branch_id AND r.sale_date = p.sale_date AND r.bill_no = p.bill_no
    WHERE (? IS NULL OR p.branch_id = ?) AND (? IS NULL OR p.sale_date = ?)
  `).all(branchId ?? null, branchId ?? null, saleDate ?? null, saleDate ?? null) as Array<{ id: number; customer_hash: string; branch_id: number; sale_date: string; bill_no: string; linked_by: number | null }>;
  let n = 0;
  const del = db.prepare("DELETE FROM insigna_pending_bills WHERE id = ?");
  for (const p of rows) {
    const r = linkBill({ customer_hash: p.customer_hash, branch_id: p.branch_id, sale_date: p.sale_date, bill_no: p.bill_no, linked_by: p.linked_by });
    if (r === "linked" || r === "already_yours" || r === "linked_to_other") { del.run(p.id); if (r === "linked") n++; }
  }
  return n;
}

export function countPendingBills(hash: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM insigna_pending_bills WHERE customer_hash = ?").get(hash) as { n: number }).n;
}

/** Members list for the back office: pseudonymous rows only. */
export function listMembers(opts: { branchId?: number | null; limit?: number } = {}): MemberProfile[] {
  const limit = Math.min(5000, Math.max(1, opts.limit ?? 2000));
  return getDb().prepare(`
    SELECT * FROM insigna_customers
    WHERE member_code IS NOT NULL AND (? IS NULL OR signup_branch_id = ?)
    ORDER BY member_since DESC LIMIT ?
  `).all(opts.branchId ?? null, opts.branchId ?? null, limit) as MemberProfile[];
}
