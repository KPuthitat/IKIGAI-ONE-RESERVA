// Move ACCOUNTA bills / income to another branch (owner 2026-11-25: "เผื่อกรณีลงผิดสาขา จะได้ไม่ต้องลบลงใหม่"). One or many rows at once.
// The row keeps its date, amount, vendor, receipt and payment status — only the branch changes, and the company follows the new branch
// (a bill belongs to the company that owns its branch). Every move is written to accounta_branch_moves, so it can be seen and reversed
// (move it back). Rows the system owns are refused with the reason instead of being moved and then silently rebuilt.
import type Database from "better-sqlite3";
import { getDb, logPersonaAction } from "./db";
import { accountaAccessFor } from "./accounta-access";
import { verifyAdminPin } from "./admin-pin";

export type MoveKind = "expense" | "income";
export type MoveResult = { id: number; status: "moved" | "same_branch" | "not_found" | "blocked"; reason?: string; from?: string | null };

// income.source values that the system rebuilds or posts by itself — moving them would be undone (shift_close, clinic) or break a settlement (revshare)
const SYSTEM_INCOME = new Set(["shift_close", "clinic", "revshare"]);

export function ensureMoveTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounta_branch_moves (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL CHECK (kind IN ('expense','income')),
      row_id       INTEGER NOT NULL,
      from_branch  INTEGER REFERENCES branches(id),
      to_branch    INTEGER NOT NULL REFERENCES branches(id),
      from_company INTEGER,
      to_company   INTEGER,
      summary      TEXT,
      reason       TEXT,
      moved_by     INTEGER NOT NULL REFERENCES users(id),
      moved_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounta_branch_moves_row ON accounta_branch_moves(kind, row_id);
  `);
}

export class MoveRefused extends Error { constructor(public code: "no_target" | "no_access" | "nothing" | "bad_pin" | "no_pin", msg: string) { super(msg); } }

/** Moving money between branches needs the person's own PIN every time (owner 2026-11-26); a wrong PIN is written to the log as well. */
export function moveRows(user: { id: number; role: string }, kind: MoveKind, ids: number[], toBranchId: number, reason: string | null, pin: string): MoveResult[] {
  const p = verifyAdminPin(user.id, (pin ?? "").trim());
  if (!p.ok) {
    logPersonaAction(user.id, `accounta.move_branch.pin_failed.${kind}`, toBranchId);
    throw new MoveRefused(p.reason === "no_pin" ? "no_pin" : "bad_pin", p.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN (ตั้งที่หน้าลงเวลา)" : "PIN ไม่ถูกต้อง");
  }
  const db = getDb();
  ensureMoveTable(db);
  const target = db.prepare("SELECT id, name, company_id FROM branches WHERE id = ? AND status != 'closed'").get(toBranchId) as { id: number; name: string; company_id: number | null } | undefined;
  if (!target) throw new MoveRefused("no_target", "ไม่พบสาขาปลายทาง");
  const access = accountaAccessFor(user.id, user.role);
  if (access.get(toBranchId) !== "confirm") throw new MoveRefused("no_access", "ท่านไม่มีสิทธิ์จัดการข้อมูลของสาขาปลายทาง");
  const uniq = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (uniq.length === 0) throw new MoveRefused("nothing", "ยังไม่ได้เลือกรายการ");

  const table = kind === "expense" ? "accounta_expenses" : "accounta_income";
  const get = db.prepare(`SELECT t.*, b.name AS branch_name FROM ${table} t LEFT JOIN branches b ON b.id = t.branch_id WHERE t.id = ?`);
  const upd = db.prepare(`UPDATE ${table} SET branch_id = ?, company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  const log = db.prepare("INSERT INTO accounta_branch_moves (kind, row_id, from_branch, to_branch, from_company, to_company, summary, reason, moved_by) VALUES (?,?,?,?,?,?,?,?,?)");
  const linkedPo = db.prepare("SELECT 1 FROM purchase_order_bills WHERE expense_id = ?");
  const out: MoveResult[] = [];
  db.transaction(() => {
    for (const id of uniq) {
      const r = get.get(id) as Record<string, unknown> | undefined;
      if (!r) { out.push({ id, status: "not_found" }); continue; }
      const from = (r.branch_id as number | null) ?? null;
      if (from === toBranchId) { out.push({ id, status: "same_branch", from: r.branch_name as string | null }); continue; }
      if (from != null && access.get(from) !== "confirm") { out.push({ id, status: "blocked", reason: "ท่านไม่มีสิทธิ์จัดการข้อมูลของสาขาต้นทาง", from: r.branch_name as string | null }); continue; }
      if (kind === "income" && SYSTEM_INCOME.has(String(r.source))) { out.push({ id, status: "blocked", reason: r.source === "shift_close" ? "สร้างจากยอดขายรายวัน/ปิดกะ — ให้แก้ที่ยอดขายรายวันของสาขานั้น" : r.source === "clinic" ? "สร้างจากไฟล์คลินิก — ให้แก้ที่ต้นทาง" : "สร้างจากส่วนแบ่งพันธมิตร — ให้แก้ที่หน้าส่วนแบ่ง", from: r.branch_name as string | null }); continue; }
      if (kind === "expense" && linkedPo.get(id)) { out.push({ id, status: "blocked", reason: "ผูกกับใบสั่งซื้อ — ปลดออกจากใบสั่งซื้อก่อน", from: r.branch_name as string | null }); continue; }
      const summary = kind === "expense" ? `${r.bill_date} ${r.vendor_name ?? ""} ฿${r.amount_total}`.trim() : `${r.income_date} ${r.channel ?? ""} ฿${r.amount}`.trim();
      upd.run(toBranchId, target.company_id, id);
      log.run(kind, id, from, toBranchId, (r.company_id as number | null) ?? null, target.company_id, summary, reason?.trim() || null, user.id);
      out.push({ id, status: "moved", from: r.branch_name as string | null });
    }
  })();
  const moved = out.filter((x) => x.status === "moved").length;
  if (moved > 0) logPersonaAction(user.id, `accounta.move_branch.${kind}`, toBranchId);
  return out;
}

export type MoveLogRow = { id: number; kind: MoveKind; row_id: number; from_name: string | null; to_name: string; summary: string | null; reason: string | null; by_name: string; moved_at: string; from_branch: number | null };
export function listMoves(user: { id: number; role: string }, limit = 40): MoveLogRow[] {
  const db = getDb();
  ensureMoveTable(db);
  const access = accountaAccessFor(user.id, user.role);
  const ids = [...access.keys()];
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT m.id, m.kind, m.row_id, fb.name AS from_name, tb.name AS to_name, m.summary, m.reason, u.display_name AS by_name, m.moved_at, m.from_branch
      FROM accounta_branch_moves m LEFT JOIN branches fb ON fb.id = m.from_branch JOIN branches tb ON tb.id = m.to_branch JOIN users u ON u.id = m.moved_by
     WHERE m.to_branch IN (${ph}) OR m.from_branch IN (${ph}) ORDER BY m.id DESC LIMIT ?
  `).all(...ids, ...ids, limit) as MoveLogRow[];
}
