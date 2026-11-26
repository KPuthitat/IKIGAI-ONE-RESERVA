// Monthly bank reconciliation (owner 2026-11-26).
//
// 1. A statement file (CSV / Excel from the bank) is read, never guessed: the columns are detected from their headings (Thai or English) and
//    shown in a preview; the balance column is used to check that no line is missing (each balance = previous balance ± the movement).
// 2. Each line is matched to what the system already knows — an ACCOUNTA expense (paid by transfer), an income row, or the other side of a
//    transfer between two company accounts — only when there is exactly one candidate; otherwise it waits for a person. A line can also be
//    explained with a reason (bank fee, interest, saving transfer …).
// 3. A month of one account is closed when every line is matched or explained; the opening / closing balance and totals are kept, and
//    closed months are no longer changed (only the owner can reopen one).
import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { getDb } from "./db";

export class ReconError extends Error { constructor(public code: ReconErrorCode, public detail?: string) { super(code); } }
export type ReconErrorCode = "not_found" | "bad_file" | "no_columns" | "period_closed" | "unmatched_remain" | "amount_mismatch" | "already_used" | "reason_required" | "no_lines" | "forbidden" | "bad_account" | "bad_status";
export const RECON_ERROR_TH: Record<ReconErrorCode, string> = {
  not_found: "ไม่พบรายการ", bad_file: "อ่านไฟล์ไม่ได้ (ใช้ไฟล์ CSV หรือ Excel จากธนาคาร)", no_columns: "หาคอลัมน์วันที่/จำนวนเงินในไฟล์ไม่เจอ — เลือกคอลัมน์เองในหน้าตัวอย่าง",
  period_closed: "เดือนนี้ปิดงวดแล้ว แก้ไม่ได้", unmatched_remain: "ยังมีรายการที่ยังไม่ได้จับคู่หรืออธิบาย จึงปิดงวดไม่ได้", amount_mismatch: "ยอดไม่ตรงกับรายการที่เลือก",
  already_used: "รายการนี้ถูกจับคู่กับรายการธนาคารอื่นแล้ว", reason_required: "กรุณาระบุเหตุผล", no_lines: "เดือนนี้ไม่มีรายการให้กระทบ", forbidden: "ไม่มีสิทธิ์", bad_account: "ไม่พบบัญชี", bad_status: "สถานะไม่ถูกต้อง"
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── reading a statement ─────────────────────────────────────────────────────────────────────
export type Columns = { date: number; desc: number | null; debit: number | null; credit: number | null; amount: number | null; type: number | null; balance: number | null };
export type ParsedLine = { row: number; date: string; description: string; debit: number; credit: number; balance: number | null };
export type ParsedStatement = {
  headerRow: number; headers: string[]; columns: Columns | null; lines: ParsedLine[]; problems: string[]; sample: string[][];
  opening: number | null; closing: number | null; chainBreaks: number; firstDate: string | null; lastDate: string | null; order: "asc" | "desc"; hasBalance: boolean;
};

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
const HEAD = {
  date: /^(วันที่|วันเวลา|วัน|date|transactiondate|txdate|postdate|valuedate|effectivedate)/,
  desc: /(รายละเอียด|รายการ|description|detail|memo|particulars|narrative|หมายเหตุ|ช่องทาง|channel|remark)/,
  debit: /(ถอน|เดบิต|debit|withdraw|เงินออก|จ่ายออก|^dr$|^dr\b)/,
  credit: /(ฝาก|เครดิต|credit|deposit|เงินเข้า|รับเข้า|^cr$|^cr\b)/,
  amount: /(จำนวนเงิน|amount|ยอดเงิน(?!คงเหลือ))/,
  type: /(ประเภท|type|dr\/cr|d\/c|เดบิต\/เครดิต)/,
  balance: /(คงเหลือ|ยอดเงินคงเหลือ|balance|ยอดยกไป)/
};

function decodeText(buf: Buffer): string {
  const utf = new TextDecoder("utf-8").decode(buf);
  if (!utf.includes("�")) return utf.replace(/^﻿/, "");
  try { return new TextDecoder("windows-874").decode(buf); } catch { return utf; }
}

export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let t = String(v ?? "").trim();
  if (!t || t === "-" || t === "—") return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  t = t.replace(/[฿,\s]/g, "").replace(/(บาท|thb)$/i, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return neg ? -n : n;
}

const TH_MONTHS: Record<string, number> = { "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6, "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function fixYear(y: number): number { if (y < 100) return y >= 50 ? y + 2500 - 543 : y + 2000; return y > 2400 ? y - 543 : y; }
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);

/** "26/11/2026", "26-11-69", "2026-11-26", "26 พ.ย. 69", an Excel serial number → yyyy-mm-dd (Buddhist years understood). Day-first, as Thai banks print it. */
export function parseDate(v: unknown): string | null {
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400_000)); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
    return null;
  }
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (m) return iso(fixYear(+m[1]), +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
  if (m) return iso(fixYear(+m[3]), +m[2], +m[1]);
  m = /^(\d{1,2})\s*([ก-๙.]+|[a-z]{3})\.?\s*(\d{2,4})/.exec(t);
  if (m) { const mo = TH_MONTHS[m[2]] ?? TH_MONTHS[m[2].replace(/\.$/, "") + "."] ?? TH_MONTHS[m[2].slice(0, 3)]; if (mo) return iso(fixYear(+m[3]), mo, +m[1]); }
  return null;
}

function detectColumns(headers: string[]): Columns | null {
  const h = headers.map(norm);
  const find = (re: RegExp, not: number[] = []) => h.findIndex((x, i) => x && re.test(x) && !not.includes(i));
  const date = find(HEAD.date);
  if (date < 0) return null;
  const balance = find(HEAD.balance, [date]);
  const debit = find(HEAD.debit, [date, balance]), credit = find(HEAD.credit, [date, balance, debit]);
  const used = [date, balance, debit, credit].filter((i) => i >= 0);
  const amount = debit >= 0 && credit >= 0 ? -1 : find(HEAD.amount, used);
  const type = amount >= 0 ? find(HEAD.type, [...used, amount]) : -1;
  const desc = find(HEAD.desc, [...used, amount, type]);
  if (!(debit >= 0 && credit >= 0) && amount < 0) return null;
  return { date, desc: desc >= 0 ? desc : null, debit: debit >= 0 && credit >= 0 ? debit : null, credit: debit >= 0 && credit >= 0 ? credit : null, amount: amount >= 0 ? amount : null, type: type >= 0 ? type : null, balance: balance >= 0 ? balance : null };
}

export function parseStatement(buf: Buffer, fileName: string, mapping?: Columns): ParsedStatement {
  const out: ParsedStatement = { headerRow: -1, headers: [], columns: null, lines: [], problems: [], sample: [], opening: null, closing: null, chainBreaks: 0, firstDate: null, lastDate: null, order: "asc", hasBalance: false };
  let rows: unknown[][];
  try {
    const wb = /\.(xlsx|xls)$/i.test(fileName) ? XLSX.read(buf, { type: "buffer" }) : XLSX.read(decodeText(buf), { type: "string", raw: true })   // raw: never let the library turn "05/11/69" into a (US-order) date;
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
  } catch { throw new ReconError("bad_file"); }
  if (!rows.length) throw new ReconError("bad_file");
  out.sample = rows.slice(0, 8).map((r) => r.map((c) => String(c ?? "")));

  let cols: Columns | null = mapping ?? null;
  let h = -1;
  if (!cols) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) { const c = detectColumns(rows[i].map((x) => String(x ?? ""))); if (c) { cols = c; h = i; break; } }
  } else {
    // a manual mapping: the heading row is the last row before the first row that has a date in the mapped column
    h = rows.findIndex((r) => parseDate(r[mapping!.date]) != null) - 1;
  }
  out.headerRow = h; out.columns = cols;
  if (!cols) { out.problems.push("หาคอลัมน์วันที่ / จำนวนเงินไม่เจอ"); return out; }
  out.headers = (h >= 0 ? rows[h] : rows[0]).map((x) => String(x ?? ""));
  out.hasBalance = cols.balance != null;

  const raw: ParsedLine[] = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[cols.date]);
    let debit = 0, credit = 0;
    if (cols.debit != null && cols.credit != null) { debit = Math.abs(parseNumber(r[cols.debit]) ?? 0); credit = Math.abs(parseNumber(r[cols.credit]) ?? 0); }
    else if (cols.amount != null) {
      const a = parseNumber(r[cols.amount]);
      if (a != null) {
        const t = cols.type != null ? norm(r[cols.type]) : "";
        if (/(ถอน|จ่าย|debit|^dr|-)/.test(t)) debit = Math.abs(a); else if (/(ฝาก|รับ|credit|^cr|\+)/.test(t)) credit = Math.abs(a); else if (a < 0) debit = -a; else credit = a;
      }
    }
    if (!date) { if (debit || credit) out.problems.push(`แถว ${i + 1}: มียอดเงินแต่อ่านวันที่ไม่ได้ ("${String(r[cols.date] ?? "")}") — ข้ามแถวนี้`); continue; }
    if (!debit && !credit) continue;                          // an informational row (opening balance line, blank amount)
    raw.push({ row: i + 1, date, description: cols.desc != null ? String(r[cols.desc] ?? "").replace(/\s+/g, " ").trim() : "", debit: round2(debit), credit: round2(credit), balance: cols.balance != null ? parseNumber(r[cols.balance]) : null });
  }

  // chronological order and the balance chain (a missing line breaks it)
  let lines = raw;
  if (out.hasBalance && raw.length > 1 && raw.every((l) => l.balance != null)) {
    let asc = 0, desc = 0;
    for (let i = 1; i < raw.length; i++) {
      if (same(raw[i].balance!, raw[i - 1].balance! + raw[i].credit - raw[i].debit)) asc++;
      if (same(raw[i].balance!, raw[i - 1].balance! - raw[i - 1].credit + raw[i - 1].debit)) desc++;
    }
    if (desc > asc) { lines = [...raw].reverse(); out.order = "desc"; }
    for (let i = 1; i < lines.length; i++) if (!same(lines[i].balance!, lines[i - 1].balance! + lines[i].credit - lines[i].debit)) out.chainBreaks++;
    out.opening = round2(lines[0].balance! - lines[0].credit + lines[0].debit);
    out.closing = round2(lines[lines.length - 1].balance!);
  } else if (raw.length > 1 && raw[0].date > raw[raw.length - 1].date) { lines = [...raw].reverse(); out.order = "desc"; }
  out.lines = lines;
  out.firstDate = lines[0]?.date ?? null; out.lastDate = lines[lines.length - 1]?.date ?? null;
  if (lines.length === 0) out.problems.push("ไม่พบรายการเคลื่อนไหวในไฟล์");
  return out;
}

// ── importing ───────────────────────────────────────────────────────────────────────────────
export type BankAccount = { id: number; name: string; bankName: string | null; accountLast4: string | null; purpose: string | null; branchId: number | null };
export function listBankAccounts(): BankAccount[] {
  return (getDb().prepare("SELECT id, name, bank_name, account_no, purpose, branch_id FROM accounta_cash_accounts WHERE type = 'bank' AND active = 1 ORDER BY sort_order, name").all() as
    Array<{ id: number; name: string; bank_name: string | null; account_no: string | null; purpose: string | null; branch_id: number | null }>)
    .map((r) => ({ id: r.id, name: r.name, bankName: r.bank_name, accountLast4: r.account_no ? r.account_no.replace(/\D/g, "").slice(-4) || null : null, purpose: r.purpose, branchId: r.branch_id }));
}
const PURPOSES = new Set(["savings", "working", "payroll_tax", "procurement", "other"]);
export function setPurpose(accountId: number, purpose: string | null): void {
  if (purpose != null && !PURPOSES.has(purpose)) throw new ReconError("bad_status");
  if (!getDb().prepare("UPDATE accounta_cash_accounts SET purpose = ? WHERE id = ? AND type = 'bank'").run(purpose, accountId).changes) throw new ReconError("bad_account");
}
const isClosed = (accountId: number, period: string): boolean => !!getDb().prepare("SELECT 1 FROM bank_recon_periods WHERE account_id = ? AND period = ? AND status = 'closed'").get(accountId, period);

export function importStatement(accountId: number, fileName: string, p: ParsedStatement, actorId: number): { statementId: number; inserted: number; duplicates: number; skippedClosed: number; matched: number } {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM accounta_cash_accounts WHERE id = ? AND type = 'bank'").get(accountId)) throw new ReconError("bad_account");
  if (!p.lines.length) throw new ReconError("no_lines");
  return db.transaction(() => {
    const sid = Number(db.prepare("INSERT INTO bank_statements (account_id, file_name, first_date, last_date, opening_balance, closing_balance, line_count, chain_breaks, imported_by) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(accountId, fileName.slice(0, 200), p.firstDate, p.lastDate, p.opening, p.closing, p.lines.length, p.chainBreaks, actorId).lastInsertRowid);
    const ins = db.prepare("INSERT OR IGNORE INTO bank_lines (statement_id, account_id, period, tx_date, description, debit, credit, balance, line_hash) VALUES (?,?,?,?,?,?,?,?,?)");
    const seen = new Map<string, number>();
    let inserted = 0, duplicates = 0, skippedClosed = 0;
    for (const l of p.lines) {
      const period = l.date.slice(0, 7);
      if (isClosed(accountId, period)) { skippedClosed++; continue; }
      const key = `${l.date}|${l.debit}|${l.credit}|${l.balance ?? ""}|${l.description}`;
      const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
      const hash = crypto.createHash("sha1").update(`${key}|${n}`).digest("hex");
      if (ins.run(sid, accountId, period, l.date, l.description, l.debit, l.credit, l.balance, hash).changes) inserted++; else duplicates++;
    }
    const matched = autoMatch(accountId, actorId);
    return { statementId: sid, inserted, duplicates, skippedClosed, matched };
  })();
}

// ── matching ────────────────────────────────────────────────────────────────────────────────
type LineRow = { id: number; account_id: number; period: string; tx_date: string; description: string; debit: number; credit: number; balance: number | null; status: string; match_kind: string | null; match_ref: number | null; reason: string };
const dayDiff = (a: string, b: string) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);

export type Candidate = { kind: "expense" | "income" | "transfer"; ref: number; label: string; amount: number; date: string };
/** What this line could be matched to (nothing is chosen here). */
export function candidatesFor(lineId: number): Candidate[] {
  const db = getDb();
  const l = db.prepare("SELECT * FROM bank_lines WHERE id = ?").get(lineId) as LineRow | undefined;
  if (!l) throw new ReconError("not_found");
  const out: Candidate[] = [];
  if (l.debit > 0) {
    for (const e of db.prepare(`SELECT id, vendor_name, description, amount_total, COALESCE(paid_date, bill_date) AS d FROM accounta_expenses
        WHERE payment_status = 'paid' AND ABS(amount_total - ?) < 0.005 AND COALESCE(review_status, 'confirmed') = 'confirmed'
          AND id NOT IN (SELECT match_ref FROM bank_lines WHERE match_kind = 'expense' AND match_ref IS NOT NULL)`).all(l.debit) as Array<{ id: number; vendor_name: string | null; description: string | null; amount_total: number; d: string }>)
      if (dayDiff(e.d, l.tx_date) <= 5) out.push({ kind: "expense", ref: e.id, label: `${e.vendor_name || e.description || "รายจ่าย"} #${e.id}`, amount: e.amount_total, date: e.d });
    for (const o of db.prepare("SELECT id, account_id, tx_date, credit FROM bank_lines WHERE status = 'unmatched' AND credit > 0 AND ABS(credit - ?) < 0.005 AND account_id <> ? AND id <> ?").all(l.debit, l.account_id, l.id) as Array<{ id: number; account_id: number; tx_date: string; credit: number }>)
      if (dayDiff(o.tx_date, l.tx_date) <= 3) out.push({ kind: "transfer", ref: o.id, label: `เงินเข้าอีกบัญชี #${o.id}`, amount: o.credit, date: o.tx_date });
  } else {
    for (const i of db.prepare(`SELECT id, channel, note, amount, income_date FROM accounta_income WHERE ABS(amount - ?) < 0.005
          AND id NOT IN (SELECT match_ref FROM bank_lines WHERE match_kind = 'income' AND match_ref IS NOT NULL)`).all(l.credit) as Array<{ id: number; channel: string | null; note: string | null; amount: number; income_date: string }>)
      if (dayDiff(i.income_date, l.tx_date) <= 3) out.push({ kind: "income", ref: i.id, label: `${i.channel || "รายรับ"} #${i.id}`, amount: i.amount, date: i.income_date });
    for (const o of db.prepare("SELECT id, account_id, tx_date, debit FROM bank_lines WHERE status = 'unmatched' AND debit > 0 AND ABS(debit - ?) < 0.005 AND account_id <> ? AND id <> ?").all(l.credit, l.account_id, l.id) as Array<{ id: number; account_id: number; tx_date: string; debit: number }>)
      if (dayDiff(o.tx_date, l.tx_date) <= 3) out.push({ kind: "transfer", ref: o.id, label: `เงินออกอีกบัญชี #${o.id}`, amount: o.debit, date: o.tx_date });
  }
  return out;
}

function setMatch(l: LineRow, kind: "expense" | "income" | "transfer", ref: number, actorId: number, auto: boolean): void {
  getDb().prepare("UPDATE bank_lines SET status = 'matched', match_kind = ?, match_ref = ?, reason = '', auto = ?, matched_by = ?, matched_at = datetime('now') WHERE id = ?").run(kind, ref, auto ? 1 : 0, actorId, l.id);
}

/** Matches every line that has exactly one candidate. A vendor name found in the description breaks a tie between expenses. Returns how many lines were matched. */
export function autoMatch(accountId: number | null, actorId: number): number {
  const db = getDb();
  const lines = db.prepare(`SELECT * FROM bank_lines WHERE status = 'unmatched' ${accountId != null ? "AND account_id = ?" : ""} ORDER BY tx_date, id`).all(...(accountId != null ? [accountId] : [])) as LineRow[];
  let n = 0;
  for (const l of lines) {
    if (isClosed(l.account_id, l.period)) continue;
    const cur = db.prepare("SELECT status FROM bank_lines WHERE id = ?").get(l.id) as { status: string };
    if (cur.status !== "unmatched") continue;                 // matched as the other side of a transfer a moment ago
    let c = candidatesFor(l.id);
    const transfers = c.filter((x) => x.kind === "transfer"), others = c.filter((x) => x.kind !== "transfer");
    if (transfers.length === 1 && others.length === 0) {
      const o = db.prepare("SELECT * FROM bank_lines WHERE id = ?").get(transfers[0].ref) as LineRow;
      if (!isClosed(o.account_id, o.period) && candidatesFor(o.id).filter((x) => x.kind === "transfer").length === 1) { setMatch(l, "transfer", o.id, actorId, true); setMatch(o, "transfer", l.id, actorId, true); n += 2; }
      continue;
    }
    if (others.length > 1) { const named = others.filter((x) => l.description && x.label.split(" #")[0] && l.description.toLowerCase().includes(x.label.split(" #")[0].toLowerCase())); if (named.length === 1) c = named; else continue; } else c = others;
    if (c.length === 1 && transfers.length === 0) { setMatch(l, c[0].kind as "expense" | "income", c[0].ref, actorId, true); n++; }
  }
  return n;
}

function lineOf(id: number): LineRow {
  const l = getDb().prepare("SELECT * FROM bank_lines WHERE id = ?").get(id) as LineRow | undefined;
  if (!l) throw new ReconError("not_found");
  if (isClosed(l.account_id, l.period)) throw new ReconError("period_closed");
  return l;
}

/** A person picks the match. The amount must agree; one expense / income row belongs to one bank line only. */
export function matchLine(lineId: number, kind: "expense" | "income" | "transfer", ref: number, actorId: number): void {
  const db = getDb();
  const l = lineOf(lineId);
  db.transaction(() => {
    if (kind === "transfer") {
      const o = lineOf(ref);
      if (o.id === l.id || o.status !== "unmatched" || o.account_id === l.account_id || !(same(o.credit, l.debit) && same(o.debit, l.credit))) throw new ReconError("amount_mismatch");
      setMatch(l, "transfer", o.id, actorId, false); setMatch(o, "transfer", l.id, actorId, false);
      return;
    }
    if (kind === "expense") {
      const e = db.prepare("SELECT amount_total FROM accounta_expenses WHERE id = ?").get(ref) as { amount_total: number } | undefined;
      if (!e) throw new ReconError("not_found");
      if (!(l.debit > 0 && same(e.amount_total, l.debit))) throw new ReconError("amount_mismatch");
    } else {
      const i = db.prepare("SELECT amount FROM accounta_income WHERE id = ?").get(ref) as { amount: number } | undefined;
      if (!i) throw new ReconError("not_found");
      if (!(l.credit > 0 && same(i.amount, l.credit))) throw new ReconError("amount_mismatch");
    }
    if (db.prepare("SELECT 1 FROM bank_lines WHERE match_kind = ? AND match_ref = ? AND id <> ?").get(kind, ref, l.id)) throw new ReconError("already_used");
    setMatch(l, kind, ref, actorId, false);
  })();
}

/** A line that has no system record but is understood (bank fee, interest, saving transfer, tax payment …). A reason is required. */
export function explainLine(lineId: number, reason: string, actorId: number): void {
  const l = lineOf(lineId);
  const why = (reason ?? "").trim();
  if (!why) throw new ReconError("reason_required");
  getDb().prepare("UPDATE bank_lines SET status = 'ignored', match_kind = 'explained', match_ref = NULL, reason = ?, auto = 0, matched_by = ?, matched_at = datetime('now') WHERE id = ?").run(why.slice(0, 200), actorId, l.id);
}

export function unmatchLine(lineId: number): void {
  const db = getDb();
  const l = lineOf(lineId);
  db.transaction(() => {
    const clear = (id: number) => db.prepare("UPDATE bank_lines SET status = 'unmatched', match_kind = NULL, match_ref = NULL, reason = '', auto = 0, matched_by = NULL, matched_at = NULL WHERE id = ?").run(id);
    if (l.match_kind === "transfer" && l.match_ref) { const o = db.prepare("SELECT account_id, period FROM bank_lines WHERE id = ?").get(l.match_ref) as { account_id: number; period: string } | undefined; if (o && isClosed(o.account_id, o.period)) throw new ReconError("period_closed"); clear(l.match_ref); }
    clear(l.id);
  })();
}

// ── a month of one account ──────────────────────────────────────────────────────────────────
export type ReconLine = { id: number; date: string; description: string; debit: number; credit: number; balance: number | null; status: "unmatched" | "matched" | "ignored"; kind: string | null; ref: number | null; reason: string; auto: boolean; matchLabel: string | null };
export type ReconSummary = {
  accountId: number; period: string; closed: boolean; closedAt: string | null; closedByName: string | null; note: string;
  opening: number | null; closing: number | null; totalDebit: number; totalCredit: number; computedClosing: number | null; balanceOk: boolean | null; chainBreaks: number;
  counts: { total: number; matched: number; ignored: number; unmatched: number }; lines: ReconLine[];
  missingInBank: Array<{ id: number; date: string; label: string; amount: number }>;
};

export function monthSummary(accountId: number, period: string): ReconSummary {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM bank_lines WHERE account_id = ? AND period = ? ORDER BY tx_date, id").all(accountId, period) as Array<LineRow & { auto: number }>;
  const label = (kind: string | null, ref: number | null): string | null => {
    if (!kind || !ref) return null;
    if (kind === "expense") { const e = db.prepare("SELECT vendor_name, description, amount_total FROM accounta_expenses WHERE id = ?").get(ref) as { vendor_name: string | null; description: string | null } | undefined; return e ? `รายจ่าย #${ref} ${e.vendor_name || e.description || ""}`.trim() : null; }
    if (kind === "income") { const i = db.prepare("SELECT channel FROM accounta_income WHERE id = ?").get(ref) as { channel: string | null } | undefined; return i ? `รายรับ #${ref} ${i.channel ?? ""}`.trim() : null; }
    const o = db.prepare("SELECT b.tx_date, a.name FROM bank_lines b JOIN accounta_cash_accounts a ON a.id = b.account_id WHERE b.id = ?").get(ref) as { tx_date: string; name: string } | undefined;
    return o ? `โอนระหว่างบัญชี ↔ ${o.name} (${o.tx_date})` : null;
  };
  const lines: ReconLine[] = rows.map((r) => ({ id: r.id, date: r.tx_date, description: r.description, debit: r.debit, credit: r.credit, balance: r.balance, status: r.status as ReconLine["status"], kind: r.match_kind, ref: r.match_ref, reason: r.reason, auto: r.auto === 1, matchLabel: label(r.match_kind, r.match_ref) }));
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0)), totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  const withBal = rows.length > 0 && rows.every((r) => r.balance != null);
  let opening: number | null = null, closing: number | null = null, chainBreaks = 0;
  if (withBal) {
    opening = round2(rows[0].balance! - rows[0].credit + rows[0].debit); closing = round2(rows[rows.length - 1].balance!);
    for (let i = 1; i < rows.length; i++) if (!same(rows[i].balance!, rows[i - 1].balance! + rows[i].credit - rows[i].debit)) chainBreaks++;
  }
  const computedClosing = opening != null ? round2(opening + totalCredit - totalDebit) : null;
  const rec = db.prepare("SELECT p.*, u.display_name AS by_name FROM bank_recon_periods p LEFT JOIN users u ON u.id = p.closed_by WHERE p.account_id = ? AND p.period = ?").get(accountId, period) as
    { status: string; note: string; closed_at: string | null; by_name: string | null } | undefined;
  // paid by transfer in this month according to ACCOUNTA, yet not matched to any bank line of any account
  const missing = (db.prepare(`SELECT id, COALESCE(vendor_name, description, 'รายจ่าย') AS label, amount_total, COALESCE(paid_date, bill_date) AS d FROM accounta_expenses
      WHERE payment_status = 'paid' AND payment_method = 'transfer' AND substr(COALESCE(paid_date, bill_date), 1, 7) = ? AND COALESCE(review_status, 'confirmed') = 'confirmed'
        AND id NOT IN (SELECT match_ref FROM bank_lines WHERE match_kind = 'expense' AND match_ref IS NOT NULL) ORDER BY d LIMIT 100`).all(period) as Array<{ id: number; label: string; amount_total: number; d: string }>)
    .map((e) => ({ id: e.id, date: e.d, label: `${e.label} #${e.id}`, amount: e.amount_total }));
  return {
    accountId, period, closed: rec?.status === "closed", closedAt: rec?.closed_at ?? null, closedByName: rec?.by_name ?? null, note: rec?.note ?? "",
    opening, closing, totalDebit, totalCredit, computedClosing, balanceOk: computedClosing != null && closing != null ? same(computedClosing, closing) : null, chainBreaks,
    counts: { total: rows.length, matched: rows.filter((r) => r.status === "matched").length, ignored: rows.filter((r) => r.status === "ignored").length, unmatched: rows.filter((r) => r.status === "unmatched").length },
    lines, missingInBank: missing
  };
}

/** Close the month: every line matched or explained; a broken balance chain (a missing line) needs a note saying why. */
export function closePeriod(accountId: number, period: string, note: string, actorId: number): void {
  const s = monthSummary(accountId, period);
  if (s.closed) throw new ReconError("period_closed");
  if (s.counts.total === 0) throw new ReconError("no_lines");
  if (s.counts.unmatched > 0) throw new ReconError("unmatched_remain", String(s.counts.unmatched));
  if ((s.chainBreaks > 0 || s.balanceOk === false) && !(note ?? "").trim()) throw new ReconError("reason_required");
  getDb().prepare(`INSERT INTO bank_recon_periods (account_id, period, status, opening_balance, closing_balance, total_debit, total_credit, note, closed_by, closed_at)
    VALUES (?,?, 'closed', ?,?,?,?,?,?, datetime('now')) ON CONFLICT(account_id, period) DO UPDATE SET status = 'closed', opening_balance = excluded.opening_balance, closing_balance = excluded.closing_balance,
      total_debit = excluded.total_debit, total_credit = excluded.total_credit, note = excluded.note, closed_by = excluded.closed_by, closed_at = excluded.closed_at`)
    .run(accountId, period, s.opening, s.closing, s.totalDebit, s.totalCredit, (note ?? "").trim().slice(0, 500), actorId);
}
export function reopenPeriod(accountId: number, period: string): void {
  getDb().prepare("UPDATE bank_recon_periods SET status = 'open', closed_by = NULL, closed_at = NULL WHERE account_id = ? AND period = ?").run(accountId, period);
}

/** Which months have lines, per account, with their state (for the month picker). */
export function periodsOverview(): Array<{ accountId: number; period: string; total: number; unmatched: number; closed: boolean }> {
  return (getDb().prepare(`SELECT l.account_id, l.period, COUNT(*) AS total, SUM(l.status = 'unmatched') AS unmatched, COALESCE(MAX(p.status = 'closed'), 0) AS closed
      FROM bank_lines l LEFT JOIN bank_recon_periods p ON p.account_id = l.account_id AND p.period = l.period GROUP BY l.account_id, l.period ORDER BY l.period DESC`).all() as
    Array<{ account_id: number; period: string; total: number; unmatched: number; closed: number }>).map((r) => ({ accountId: r.account_id, period: r.period, total: r.total, unmatched: r.unmatched, closed: r.closed === 1 }));
}
