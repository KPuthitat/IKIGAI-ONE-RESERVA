// Backdated OT request helpers (owner 2026-09-26): the OPEN-period guard and the
// eligible-days gathering. Run: node --import tsx scripts/test-ot-backdate.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-ot-backdate.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const ob = await import("../src/lib/ot-backdate");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','A')").run().lastInsertRowid);
  const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?, 'S')").run(branch).lastInsertRowid);
  const shift = Number(db.prepare(
    "INSERT INTO shift_codes (branch_id,code,start_time,end_time,break_start,break_end) VALUES (?, 'D', '09:00','17:00','12:00','13:00')"
  ).run(branch).lastInsertRowid);
  const uid = Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES ('u','x','U','staff','active','pt')"
  ).run().lastInsertRowid);

  const assign = (date: string) => db.prepare(
    "INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)"
  ).run(branch, date, pos, uid, shift);
  const iso = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
  const work = (date: string, inHH: string, outHH: string) => {
    db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(uid, "in", iso(date, inHH), branch);
    db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(uid, "out", iso(date, outHH), branch);
  };
  const period = (start: string, end: string, status: string, target: string) => Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,target,branch_id) VALUES ('monthly',?,?,?,?,?,?)"
  ).run(start, end, end, status, target, branch).lastInsertRowid);

  // Sep = OPEN (draft), pt target. Aug = finalized.
  const sepId = period("2026-09-01", "2026-09-30", "draft", "pt");
  period("2026-08-01", "2026-08-31", "finalized", "pt");

  // Sep assignments: 20 worked, 22 assigned-not-worked, 25 worked. Aug 15 worked.
  for (const d of ["2026-09-20", "2026-09-22", "2026-09-25", "2026-08-15"]) assign(d);
  work("2026-09-20", "09:00", "18:00");
  work("2026-09-25", "09:00", "19:00");
  work("2026-08-15", "09:00", "18:00");

  const today = "2026-09-26";

  // ── openPeriodForUserDate ──
  ok("open period: วันใน Sep (draft) → เจอรอบ", ob.openPeriodForUserDate(db, { branchId: branch, employmentType: "pt", workDate: "2026-09-20" })?.id === sepId);
  ok("open period: วันใน Aug (finalized) → null", ob.openPeriodForUserDate(db, { branchId: branch, employmentType: "pt", workDate: "2026-08-15" }) === null);
  ok("open period: นอกทุกรอบ → null", ob.openPeriodForUserDate(db, { branchId: branch, employmentType: "pt", workDate: "2026-07-01" }) === null);
  ok("open period: target ไม่ตรง (ft vs รอบ pt) → null", ob.openPeriodForUserDate(db, { branchId: branch, employmentType: "ft", workDate: "2026-09-20" }) === null);

  // ── eligibleBackdateDays ──
  const sep = ob.openPeriodForUserDate(db, { branchId: branch, employmentType: "pt", workDate: "2026-09-20" })!;
  const days = ob.eligibleBackdateDays(db, { userId: uid, branchId: branch, period: sep, todayBkk: today });
  ok("eligible: เฉพาะวันที่ทำงานจริง ก่อนวันนี้ (25,20) เรียงใหม่→เก่า", days.map((d) => d.date).join(",") === "2026-09-25,2026-09-20");
  ok("eligible: วันที่ลงกะแต่ไม่ได้ทำงาน (22) ถูกตัดออก", !days.some((d) => d.date === "2026-09-22"));
  ok("eligible: มีชั่วโมงทำงาน + กะ 09:00–17:00", days.every((d) => d.workedMinutes > 0 && d.scheduledStart === "09:00" && d.scheduledEnd === "17:00"));
  ok("eligible: prefill จากเวลาจริง (25→ออก 19:00, 20→ออก 18:00)",
    days.find((d) => d.date === "2026-09-25")?.actualOut === "19:00" && days.find((d) => d.date === "2026-09-20")?.actualOut === "18:00");

  // Existing OT request surfaces on the day.
  db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,status,created_at) VALUES (?,?,?,?,'approved',?)")
    .run(uid, branch, "2026-09-20", "18:00", new Date().toISOString());
  const days2 = ob.eligibleBackdateDays(db, { userId: uid, branchId: branch, period: sep, todayBkk: today });
  const d20 = days2.find((d) => d.date === "2026-09-20");
  ok("eligible: แนบสถานะ OT ที่ขอไว้ (approved · 18:00)", !!d20 && d20.status === "approved" && d20.requestedUntil === "18:00");

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
