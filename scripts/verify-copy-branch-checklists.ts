// Fixture: copyBranchChecklists — the one-off that mirrors one branch's
// checklist/readiness config onto another (owner 2026-07-25). Validates the
// parent_id remap, per-type delete-then-insert dedup (idempotent re-run),
// and sc_* headline copy against an in-memory DB.
// Run:  node --import tsx scripts/verify-copy-branch-checklists.ts
import Database from "better-sqlite3";
import { copyBranchChecklists, CHECKLIST_TYPES } from "./copy-branch-checklists";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
    sc_show_drawer_primary INTEGER DEFAULT 1, sc_show_svc_primary INTEGER DEFAULT 1,
    sc_show_revenue_primary INTEGER DEFAULT 1,
    sc_drawer_label TEXT, sc_svc_label TEXT, sc_revenue_label TEXT,
    sc_drawer_order INTEGER DEFAULT 1, sc_svc_order INTEGER DEFAULT 2, sc_revenue_order INTEGER DEFAULT 3
  );
  CREATE TABLE shift_checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, label TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 100, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    kind TEXT NOT NULL DEFAULT 'checkbox', options_json TEXT,
    parent_id INTEGER REFERENCES shift_checklist_items(id) ON DELETE CASCADE,
    is_headline_amount INTEGER NOT NULL DEFAULT 0, description TEXT,
    income_breakdown INTEGER NOT NULL DEFAULT 0,
    branch_id INTEGER REFERENCES branches(id)
  );
  CREATE TABLE accounta_income_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, name TEXT,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1, show_on_close INTEGER DEFAULT 1, is_credit INTEGER DEFAULT 0
  );
`);

const SRC = (db.prepare("INSERT INTO branches (name, sc_drawer_label, sc_svc_label) VALUES ('NAMA','ลิ้นชัก NAMA','SVC NAMA')").run().lastInsertRowid) as number;
const DST = (db.prepare("INSERT INTO branches (name) VALUES ('HYPO')").run().lastInsertRowid) as number;

const ins = db.prepare(
  `INSERT INTO shift_checklist_items (type,label,display_order,kind,is_headline_amount,parent_id,branch_id)
   VALUES (?,?,?,?,?,?,?)`
);
// Source (NAMA) — a nested shift_close: parent section + 2 children.
const pid = ins.run("shift_close", "ยอดรวม POS", 1, "section", 0, null, SRC).lastInsertRowid as number;
ins.run("shift_close", "Cash", 2, "amount", 1, pid, SRC);
ins.run("shift_close", "PromptPay", 3, "amount", 0, pid, SRC);
ins.run("shift_open", "Empeo work-in", 1, "checkbox", 0, null, SRC);
ins.run("readiness_1130", "อุณหภูมิตู้เย็น", 1, "text", 0, null, SRC);
ins.run("readiness_1600", "เตรียมของรอบบ่าย", 1, "checkbox", 0, null, SRC);

// Target (HYPO) — pretend it was auto-seeded with a DIFFERENT shift_open item.
ins.run("shift_open", "ของเดิม HYPO", 1, "checkbox", 0, null, DST);

const before = db.prepare("SELECT COUNT(*) c FROM shift_checklist_items WHERE branch_id=?").get(DST) as { c: number };
assert(before.c === 1, "target starts with its own seeded row");

// Income channels: NAMA has the real payment channels; HYPO wrongly has only a
// revshare-polluted channel (the bug the owner hit).
const insCh = db.prepare("INSERT INTO accounta_income_channels (branch_id,name,sort_order,show_on_close,is_credit) VALUES (?,?,?,?,?)");
insCh.run(SRC, "เงินสด", 10, 1, 0);
insCh.run(SRC, "QR / พร้อมเพย์", 20, 1, 0);
insCh.run(SRC, "บัตรเครดิต VISA", 30, 1, 0);
insCh.run(DST, "จ้อจี้ & friends", 10, 1, 0);   // pollution

// ── First copy ──────────────────────────────────────────────────────────
db.transaction(() => copyBranchChecklists(db, SRC, DST, {}))();

const dstRows = db.prepare("SELECT * FROM shift_checklist_items WHERE branch_id=? ORDER BY type, display_order").all(DST) as Array<Record<string, unknown>>;
assert(dstRows.length === 6, "target now has all 6 source rows (its old seeded row was replaced)");
assert(!dstRows.some((r) => r.label === "ของเดิม HYPO"), "target's old shift_open row was cleared, not duplicated");

// Parent remap: the child rows must point at the NEW parent in the target,
// never at the source's parent id.
const parent = dstRows.find((r) => r.label === "ยอดรวม POS")!;
const children = dstRows.filter((r) => r.label === "Cash" || r.label === "PromptPay");
assert(parent.parent_id === null, "copied parent is top-level (parent_id null)");
assert(children.length === 2 && children.every((c) => c.parent_id === parent.id),
  "copied children point at the NEW parent id, not the source's");
assert(children.every((c) => c.branch_id === DST), "children are scoped to the target branch");
assert(parent.kind === "section" && children.some((c) => c.is_headline_amount === 1),
  "kind + is_headline_amount carried over");

// Income channels copied → HYPO now mirrors NAMA's payment channels, and the
// polluting "จ้อจี้ & friends" is gone (the shift-close bug the owner reported).
const dstCh = db.prepare("SELECT name FROM accounta_income_channels WHERE branch_id=? ORDER BY sort_order").all(DST) as Array<{ name: string }>;
assert(dstCh.length === 3, "target income channels replaced with the 3 source channels");
assert(dstCh.map((c) => c.name).join(",") === "เงินสด,QR / พร้อมเพย์,บัตรเครดิต VISA", "channels match NAMA in order");
assert(!dstCh.some((c) => c.name === "จ้อจี้ & friends"), "the polluting revshare channel is removed from the target");

// sc_* headline columns copied.
const dstB = db.prepare("SELECT sc_drawer_label, sc_svc_label FROM branches WHERE id=?").get(DST) as Record<string, unknown>;
assert(dstB.sc_drawer_label === "ลิ้นชัก NAMA" && dstB.sc_svc_label === "SVC NAMA", "shift_close sc_* headline columns copied");

// ── Idempotent re-run — same result, no duplicates ──────────────────────
db.transaction(() => copyBranchChecklists(db, SRC, DST, {}))();
const after2 = db.prepare("SELECT COUNT(*) c FROM shift_checklist_items WHERE branch_id=?").get(DST) as { c: number };
assert(after2.c === 6, "re-running the copy is idempotent (still 6 rows, no duplicates)");

// Source is never mutated.
const srcCount = db.prepare("SELECT COUNT(*) c FROM shift_checklist_items WHERE branch_id=?").get(SRC) as { c: number };
assert(srcCount.c === 6, "source branch is left untouched");

// --no-headline / type subset honoured.
db.prepare("UPDATE branches SET sc_drawer_label='CHANGED' WHERE id=?").run(DST);
db.transaction(() => copyBranchChecklists(db, SRC, DST, { types: ["shift_open"], copyHeadline: false }))();
const dstB2 = db.prepare("SELECT sc_drawer_label FROM branches WHERE id=?").get(DST) as Record<string, unknown>;
assert(dstB2.sc_drawer_label === "CHANGED", "copyHeadline:false leaves sc_* columns alone");
assert(CHECKLIST_TYPES.length === 4, "covers all four list types");

console.log("\nALL COPY-BRANCH-CHECKLIST FIXTURES PASSED");
