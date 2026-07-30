// Fixture (owner 2026-07-30): food-credit SVC clawback decision + the approved
// early-leave lookup. The clawback is the money-driving rule — a staffer who
// redeemed the free lunch but left the ≥8h shift early (worked < 480−30) without
// an approved early-leave forfeits that day's credit from their SVC share.
//   node --import tsx scripts/verify-food-clawback.ts
import Database from "better-sqlite3";
import { computeFoodClawbacks, FOOD_CLAWBACK_MIN_MINUTES } from "../src/lib/service-charge";
import { approvedEarlyLeaveKeys, hasApprovedEarlyLeave } from "../src/lib/early-leave";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

assert(FOOD_CLAWBACK_MIN_MINUTES === 450, "threshold = 480 − 30 grace = 450 นาที");

// ── computeFoodClawbacks (pure) ─────────────────────────────────────
// workedByDay: date → (user → clamped worked minutes)
const workedByDay = new Map<string, Map<number, number>>([
  ["2026-07-05", new Map([[10, 300], [11, 400]])],   // 10 short, 11 short (not roster)
  ["2026-07-06", new Map([[10, 480]])],               // 10 stayed full
  ["2026-07-07", new Map([[10, 400]])],               // 10 short but will be approved
  ["2026-07-08", new Map([[10, 449]])],               // 10 one min under threshold
  ["2026-07-09", new Map([[10, 450]])],               // 10 exactly at threshold (OK)
  // 2026-07-10 intentionally ABSENT → abnormal/uncertified day (no minutes)
]);
const redeemedFood = [
  { uid: 10, d: "2026-07-05", credit: 60 },   // short → claw 60
  { uid: 10, d: "2026-07-06", credit: 120 },  // full → no claw
  { uid: 10, d: "2026-07-07", credit: 60 },   // short but approved → no claw
  { uid: 10, d: "2026-07-08", credit: 120 },  // 449 < 450 → claw 120
  { uid: 10, d: "2026-07-09", credit: 60 },   // 450 >= 450 → no claw
  { uid: 10, d: "2026-07-10", credit: 60 },   // no minutes → skip (not double-penalised)
  { uid: 11, d: "2026-07-05", credit: 60 },   // short but NOT roster member → no claw
];
const approved = new Set<string>(["10:2026-07-07"]);
const isMember = (uid: number) => uid === 10;   // 11 is another branch's staff

const claw = computeFoodClawbacks(redeemedFood, workedByDay, approved, isMember);
const days10 = claw.get(10) ?? [];
const total10 = days10.reduce((s, x) => s + x.credit, 0);
assert(total10 === 180, "user10 clawback = 180 (60 วันที่ 05 + 120 วันที่ 08)");
assert(days10.length === 2, "user10 โดนหัก 2 วัน");
assert(days10.some((d) => d.date === "2026-07-05" && d.credit === 60), "หัก 60 วันที่ 05 (ทำ 300 นาที)");
assert(days10.some((d) => d.date === "2026-07-08" && d.credit === 120), "หัก 120 วันที่ 08 (ทำ 449 นาที)");
assert(!days10.some((d) => d.date === "2026-07-06"), "ไม่หักวันที่ 06 (ทำครบ 480)");
assert(!days10.some((d) => d.date === "2026-07-07"), "ไม่หักวันที่ 07 (ได้รับอนุมัติออกก่อน)");
assert(!days10.some((d) => d.date === "2026-07-09"), "ไม่หักวันที่ 09 (ทำ 450 = เกณฑ์พอดี)");
assert(!days10.some((d) => d.date === "2026-07-10"), "ไม่หักวันที่ 10 (ไม่มีเวลาที่วัดได้ — ไม่ปรับซ้ำ)");
assert(!claw.has(11), "user11 ไม่โดนหัก (ไม่ได้อยู่ใน SVC roster สาขานี้)");

// ── early-leave lookups (SQL) ───────────────────────────────────────
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE early_leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, branch_id INTEGER, work_date TEXT, reason TEXT,
    status TEXT DEFAULT 'pending', decided_by INTEGER, decided_at TEXT,
    created_at TEXT, UNIQUE(user_id, work_date)
  );
`);
const ins = db.prepare("INSERT INTO early_leave_requests (user_id,branch_id,work_date,status) VALUES (?,?,?,?)");
ins.run(10, 20, "2026-07-07", "approved");
ins.run(10, 20, "2026-07-08", "pending");    // filed but not yet approved
ins.run(11, 20, "2026-07-15", "rejected");
ins.run(12, 20, "2026-08-01", "approved");   // next month

const keys = approvedEarlyLeaveKeys(db, "2026-07");
assert(keys.has("10:2026-07-07"), "approvedEarlyLeaveKeys มี 10:2026-07-07 (อนุมัติแล้ว)");
assert(!keys.has("10:2026-07-08"), "ไม่มี 10:2026-07-08 (ยัง pending)");
assert(!keys.has("11:2026-07-15"), "ไม่มี 11 (rejected)");
assert(!keys.has("12:2026-08-01"), "ไม่มีเดือนอื่น (ส.ค.)");
assert(hasApprovedEarlyLeave(db, 10, "2026-07-07"), "hasApprovedEarlyLeave 10/07-07 → true");
assert(!hasApprovedEarlyLeave(db, 10, "2026-07-08"), "hasApprovedEarlyLeave 10/07-08 (pending) → false");

console.log("\nAll food-clawback + early-leave checks passed.");
