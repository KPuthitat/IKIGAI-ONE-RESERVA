// Fixture: credit-term due_mode + the due-bill reminder query (owner 2026-07-21).
// nextMonday algorithm + normalise rules (replicated) + listDueUnpaidBills SQL
// against an in-memory DB. Run:  node --import tsx scripts/verify-due-mode.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// ── nextMonday (mirrors the client helper) ──────────────────────
function nextMonday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (((1 - d.getUTCDay() + 6) % 7) + 1));
  return d.toISOString().slice(0, 10);
}
assert(nextMonday("2026-07-21") === "2026-07-27", "Tue 21 Jul → next Mon 27 Jul");      // 21 = Tue
assert(nextMonday("2026-07-27") === "2026-08-03", "Mon 27 Jul → next Mon 3 Aug (strictly after)");
assert(nextMonday("2026-07-26") === "2026-07-27", "Sun 26 Jul → Mon 27 Jul");
new Date(`${nextMonday("2026-07-21")}T00:00:00Z`).getUTCDay() === 1 &&
  console.log("✓ result always lands on a Monday");

// ── normalise rules (mirrors accounta-db normalise) ─────────────
function norm(status: "paid" | "unpaid", dueMode: string | null, dueDate: string | null) {
  return {
    due_mode: status === "unpaid" ? (dueMode ?? null) : null,
    due_date: status === "unpaid" && dueMode !== "on_receipt" ? (dueDate || null) : null
  };
}
assert(norm("paid", "date", "2026-08-01").due_mode === null && norm("paid", "date", "2026-08-01").due_date === null,
  "paid bill → due_mode & due_date cleared");
const onRcv = norm("unpaid", "on_receipt", "2026-08-01");
assert(onRcv.due_mode === "on_receipt" && onRcv.due_date === null, "unpaid on_receipt → keeps mode, clears date");
const cyc = norm("unpaid", "cycle", "2026-07-27");
assert(cyc.due_mode === "cycle" && cyc.due_date === "2026-07-27", "unpaid cycle → keeps computed date");
const dt = norm("unpaid", "date", "2026-08-15");
assert(dt.due_date === "2026-08-15", "unpaid date → keeps specified date");

// ── listDueUnpaidBills query (mirrors accounta-db) ──────────────
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE accounta_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, vendor_name TEXT, amount_total REAL,
    review_status TEXT DEFAULT 'confirmed', payment_status TEXT, due_date TEXT, due_reminded_at TEXT
  );
`);
db.prepare("INSERT INTO branches (id,name) VALUES (1,'NAMA')").run();
const ins = db.prepare("INSERT INTO accounta_expenses (branch_id,vendor_name,amount_total,payment_status,due_date,due_reminded_at) VALUES (1,?,?,?,?,?)");
ins.run("A ครบวันนี้", 1000, "unpaid", "2026-07-21", null);        // due today → included
ins.run("B เกินกำหนด", 2000, "unpaid", "2026-07-19", null);        // overdue, not reminded → included
ins.run("C เตือนแล้ว", 3000, "unpaid", "2026-07-21", "2026-07-21"); // already reminded → excluded
ins.run("D ยังไม่ถึง", 4000, "unpaid", "2026-07-25", null);        // future → excluded
ins.run("E จ่ายแล้ว", 5000, "paid", "2026-07-21", null);           // paid → excluded
ins.run("F ไม่มีกำหนด", 6000, "unpaid", null, null);              // on_receipt (no date) → excluded

const today = "2026-07-21";
const due = db.prepare(`
  SELECT e.id, e.vendor_name, e.amount_total, e.due_date
    FROM accounta_expenses e LEFT JOIN branches b ON b.id = e.branch_id
   WHERE e.review_status='confirmed' AND e.payment_status='unpaid'
     AND e.due_date IS NOT NULL AND e.due_date <= ? AND e.due_reminded_at IS NULL
   ORDER BY e.due_date ASC, e.amount_total DESC
`).all(today) as Array<{ vendor_name: string }>;
const names = due.map((d) => d.vendor_name);
assert(JSON.stringify(names) === JSON.stringify(["B เกินกำหนด", "A ครบวันนี้"]),
  `due list = overdue-first then due-today; excludes reminded/future/paid/no-date (got ${JSON.stringify(names)})`);

console.log("\nALL DUE-MODE FIXTURES PASSED");
