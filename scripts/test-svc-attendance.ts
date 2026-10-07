// SVC attendance criteria engine (owner 2026-10-07): ขาด+ลา+สาย ÷ scheduled days.
// Run:  node --import tsx scripts/test-svc-attendance.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-svc-attendance.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const A = await import("../src/lib/svc-attendance");
  const db = getDb();
  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('CO')").run().lastInsertRowid);
  const b1 = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('b1','B1',?)").run(co).lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('b2','B2',?)").run(co).lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('x','OTHER CO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(b1, "M", "M", "09:00", "17:00").lastInsertRowid);
  const shift2 = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(b2, "M", "M", "09:00", "17:00").lastInsertRowid);
  const off = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind) VALUES (?,?,?,?,?,'day_off')").run(b1, "OFF", "OFF", "00:00", "00:00").lastInsertRowid);

  const mkUser = (u: string, extra = "") => Number(db.prepare(`INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance${extra ? "," + extra.split("=")[0] : ""}) VALUES (?,?,?,'staff','active','ft',${extra ? "?,?" : "1"}${""})`)
    .run(...(extra ? [u, "x", u, 1, extra.split("=")[1]] : [u, "x", u])).lastInsertRowid);
  let pos = 0;
  const posOf = new Map<string, number>();
  const roster = (uid: number, date: string, branch = b1, sh = shift) => {
    const key = `${branch}:${uid}`;
    if (!posOf.has(key)) posOf.set(key, Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(branch, `P${++pos}`).lastInsertRowid));
    db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(branch, date, posOf.get(key), uid, sh);
  };
  const clock = (uid: number, date: string, hhmm: string, branch = b1) => {
    db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?, 'in', ?, ?)").run(uid, new Date(`${date}T${hhmm}:00+07:00`).toISOString(), branch);
  };
  const leave = (uid: number, type: string, from: string, to: string, filed: string, status = "approved") =>
    db.prepare("INSERT INTO leave_requests (user_id,type,date_from,date_to,days,status,created_at) VALUES (?,?,?,?,1,?,?)").run(uid, type, from, to, status, `${filed}T03:00:00.000Z`);
  const TODAY = "2026-09-30";
  const run = (ids: number[], today = TODAY, branches = [b1, b2]) => A.computeSvcAttendance({ branchIds: branches, yearMonth: "2026-09", userIds: ids, todayIso: today });

  // ── Person A: a bit of everything over 11 rostered days ──────────────────────
  const a = mkUser("alice");
  for (const d of ["01", "02", "03", "04", "07", "08", "09", "10", "11", "12", "14"]) roster(a, `2026-09-${d}`);
  clock(a, "2026-09-01", "09:00");
  clock(a, "2026-09-02", "09:20");                 // late 20 min
  /* 09-03: no clock, no leave → ขาด */
  clock(a, "2026-09-04", "09:04");                 // within the 5-min grace
  leave(a, "sick", "2026-09-07", "2026-09-07", "2026-09-07");         // sick, filed same day → counts for nothing
  leave(a, "personal", "2026-09-08", "2026-09-08", "2026-09-01");     // filed in advance, weekday → no event
  leave(a, "personal", "2026-09-09", "2026-09-09", "2026-09-09");     // filed on the day → abnormal
  clock(a, "2026-09-10", "09:00");
  leave(a, "personal", "2026-09-11", "2026-09-11", "2026-09-01", "pending");   // not approved, no clock → ขาด with a hint
  leave(a, "annual", "2026-09-12", "2026-09-12", "2026-09-01");       // Saturday, filed early → restricted day
  clock(a, "2026-09-14", "09:00");
  const ra = run([a]).get(a)!;
  const kinds = ra.events.map((e) => `${e.date.slice(8)}:${e.kind}`).join(",");
  ok("A: 11 rostered days", ra.scheduledDays === 11);
  ok("A: events are late 02, absent 03, leave 09 (abnormal), absent 11 (pending leave), leave 12 (Saturday)", kinds === "02:late,03:absent,09:leave,11:absent,12:leave");
  ok("A: grace, sick leave and an advance weekday leave count for nothing", !ra.events.some((e) => ["04", "07", "08"].includes(e.date.slice(8))));
  ok("A: counts = 1 late · 2 absent · 2 leave", ra.late === 1 && ra.absent === 2 && ra.leave === 2 && ra.counted === 5);
  ok("A: 5 ÷ 11 = 45.5% → half tier", ra.pct === 45.5 && ra.tier === "half");
  ok("A: the pending-leave absence carries a hint for the reviewer", ra.events.find((e) => e.date.endsWith("-11"))!.detail.includes("ยังไม่อนุมัติ"));
  ok("A: late event carries the minutes", ra.events.find((e) => e.kind === "late")!.minutes === 20);

  // Waive events one by one (per person/day/kind).
  const admin = mkUser("admin");
  A.setSvcAttendanceExemption({ userId: a, date: "2026-09-03", kind: "absent", exempted: true, byUserId: admin, reason: "ลืมกดเข้างาน" });
  let r2 = run([a]).get(a)!;
  ok("waive 1 event → 4 ÷ 11 = 36.4% (half), waived count 1, the event stays listed", r2.counted === 4 && r2.waived === 1 && r2.pct === 36.4 && r2.tier === "half" && r2.events.find((e) => e.date.endsWith("-03"))!.exempted);
  A.setSvcAttendanceExemption({ userId: a, date: "2026-09-11", kind: "absent", exempted: true, byUserId: admin });
  A.setSvcAttendanceExemption({ userId: a, date: "2026-09-12", kind: "leave", exempted: true, byUserId: admin });
  r2 = run([a]).get(a)!;
  ok("waive 3 events → 2 ÷ 11 = 18.2% → full tier", r2.counted === 2 && r2.pct === 18.2 && r2.tier === "full");
  A.setSvcAttendanceExemption({ userId: a, date: "2026-09-03", kind: "absent", exempted: false, byUserId: admin });
  ok("un-waiving puts the event back", run([a]).get(a)!.counted === 3);

  // ── Cross-branch clock-in counts; a branch outside the company does not ───────
  const c = mkUser("cara");
  roster(c, "2026-09-01", b2, shift2); roster(c, "2026-09-02", b2, shift2);
  clock(c, "2026-09-01", "09:00", b1);               // clocked at the OTHER company branch → present
  clock(c, "2026-09-02", "09:00", other);            // clocked outside the company → still ขาด
  const rc = run([c]).get(c)!;
  ok("cross-branch: a clock-in at any company branch counts as present", !rc.events.some((e) => e.date.endsWith("-01")));
  ok("a clock-in at a branch outside the company does not", rc.events.some((e) => e.date.endsWith("-02") && e.kind === "absent"));

  // ── Someone who does not clock in: only leave can count ──────────────────────
  const x = mkUser("exec");
  db.prepare("UPDATE users SET track_attendance = 0 WHERE id = ?").run(x);
  for (const d of ["01", "02", "03", "12"]) roster(x, `2026-09-${d}`);
  leave(x, "annual", "2026-09-12", "2026-09-12", "2026-09-01");
  const rx = run([x]).get(x)!;
  ok("no-clock staff: no ขาด/สาย, but a restricted-day leave still counts", rx.tracksAttendance === false && rx.absent === 0 && rx.late === 0 && rx.leave === 1);

  // ── Late excusal, hire date, "today" ─────────────────────────────────────────
  const e = mkUser("eve");
  for (const d of ["01", "02", "03", "04"]) roster(e, `2026-09-${d}`);
  clock(e, "2026-09-01", "09:30"); clock(e, "2026-09-02", "09:30"); clock(e, "2026-09-03", "09:00");
  db.prepare("INSERT INTO late_excusals (user_id, work_date, late_minutes, reason, status, created_at) VALUES (?, '2026-09-01', 30, 'x', 'approved', '2026-09-01T10:00:00.000Z')").run(e);
  const re = run([e]).get(e)!;
  ok("approved late excusal: that day is not counted as สาย", !re.events.some((v) => v.date.endsWith("-01")));
  ok("the other 09:30 arrival is สาย; the 4th (no clock) is ขาด", re.late === 1 && re.absent === 1);
  const f = mkUser("frank");
  for (const d of ["01", "02", "03"]) roster(f, `2026-09-${d}`);
  db.prepare("UPDATE users SET hire_date = '2026-09-03' WHERE id = ?").run(f);
  const rf = run([f]).get(f)!;
  ok("rostered days before the hire date are never ขาด", rf.absent === 1 && rf.events[0].date === "2026-09-03");
  const rToday = run([e], "2026-09-04").get(e)!;
  ok("ขาด is judged only for days BEFORE today", rToday.absent === 0);

  // ── Tier boundaries on 10 scheduled days ─────────────────────────────────────
  const tierFor = (absentDays: number) => {
    const u = mkUser(`t${absentDays}`);
    const days = ["01", "02", "03", "04", "07", "08", "09", "10", "11", "14"];
    days.forEach((d, i) => { roster(u, `2026-09-${d}`); if (i >= absentDays) clock(u, `2026-09-${d}`, "09:00"); });
    return run([u]).get(u)!;
  };
  ok("2 of 10 = 20% → still full (the limit is 'over 20%')", tierFor(2).tier === "full");
  ok("3 of 10 = 30% → half", tierFor(3).tier === "half");
  ok("5 of 10 = 50% → half (the limit is 'over 50%')", tierFor(5).tier === "half");
  ok("6 of 10 = 60% → none", tierFor(6).tier === "none");

  // ── Edges ────────────────────────────────────────────────────────────────────
  ok("a person with no roster is not computable and stays full", (() => { const z = mkUser("zed"); const r = run([z]).get(z)!; return !r.computable && r.tier === "full" && r.counted === 0; })());
  ok("rule start month: September 2026 onwards", A.svcAttendanceApplies("2026-09") && A.svcAttendanceApplies("2026-10") && !A.svcAttendanceApplies("2026-08"));
  ok("empty input → empty map", run([]).size === 0);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
