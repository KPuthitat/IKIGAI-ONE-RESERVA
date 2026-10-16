// ตำแหน่งงานค่าตอบแทนพิเศษ — booking / assignment rules. Run: node --import tsx scripts/test-special-duty-rules.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-rules.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const codes = (r: ReturnType<typeof R.checkBookingSet>) => (r.ok ? [] : r.errors.map((e) => e.code));
  const NOW = "2026-11-05";
  const YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const off = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind) VALUES (?,?,?,?,?,'day_off')").run(nama, "OFF", "OFF", "00:00", "00:00").lastInsertRowid);
  const rosterPos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "R").lastInsertRowid);
  let rp = 0;
  const mk = (u: string, dept: string | null, branch = nama) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,'staff','active',?)").run(u, "x", u, dept).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, branch);
    return id;
  };
  const onRoster = (uid: number, days: number[], code = shift) => {
    const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, `P${++rp}`).lastInsertRowid);
    for (const d of days) db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(nama, date(d), pos, uid, code);
  };
  const ALL = Array.from({ length: 31 }, (_, i) => i + 1);
  const owner = mk("owner", null);
  const cook = mk("cook", "kitchen");     // may wash dishes
  const waiter = mk("waiter", "service"); // may not
  const cook2 = mk("cook2", "kitchen");
  const other = mk("other-branch", "kitchen", hypo);
  for (const u of [cook, waiter, cook2]) onRoster(u, ALL);
  onRoster(owner, [1]);

  const P = (slot: number, name: string, groups?: Array<"kitchen" | "service" | "management" | "other"> | null) =>
    D.savePosition({ branchId: nama, yearMonth: YM, slotNo: slot, name, eligibleGroups: groups ?? null, actorId: owner, asOf: NOW });
  const dish = P(1, "ล้างจาน", ["kitchen"]).id, toilet = P(2, "ล้างห้องน้ำ").id, plants = P(3, "รดน้ำต้นไม้").id;
  const days = (a: number, n: number) => Array.from({ length: n }, (_, i) => date(a + i));
  const book = (uid: number, pid: number, ds: string[], asOf = NOW) => R.setUserBookings({ userId: uid, branchId: nama, yearMonth: YM, positionId: pid, dates: ds, asOf });

  // month off / roster not published
  ok("month off: refused", codes(R.checkBookingSet({ userId: cook, branchId: nama, yearMonth: YM, positionId: dish, dates: days(1, 6), asOf: NOW })).includes("month_off"));
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  ok("before the roster is published: refused", codes(R.checkBookingSet({ userId: cook, branchId: nama, yearMonth: YM, positionId: dish, dates: days(1, 6), asOf: NOW })).includes("roster_not_published"));
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "booking_open", actorId: owner });

  // happy path
  ok("a kitchen person books 6 days of dish washing", book(cook, dish, days(1, 6)).ok === true);
  ok("the rows are in the database", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(cook) as { n: number }).n === 6);

  // minimum 6
  ok("fewer than 6 days for a position is refused", codes(book(cook2, dish, days(10, 5))).includes("below_minimum_days"));
  ok("…and nothing was saved", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(cook2) as { n: number }).n === 0);
  ok("not booking a position at all is fine (empty set)", book(cook2, toilet, []).ok === true);

  // eligibility
  ok("service staff cannot book dish washing", codes(book(waiter, dish, days(10, 6))).includes("group_not_eligible"));
  ok("…but can book a position open to every group", book(waiter, toilet, days(10, 6)).ok === true);
  ok("a person not in the branch is refused", codes(R.checkBookingSet({ userId: other, branchId: nama, yearMonth: YM, positionId: toilet, dates: days(1, 6), asOf: NOW })).includes("not_in_branch"));

  // roster
  ok("a day not on the roster is refused", codes(book(owner, plants, days(1, 6))).includes("not_in_roster"));
  const dayOff = mk("dayoff", "kitchen"); onRoster(dayOff, ALL.slice(0, 5)); onRoster(dayOff, [20], off);
  ok("a day off on the roster does not count as on the roster", codes(book(dayOff, plants, [date(1), date(2), date(3), date(4), date(5), date(20)])).includes("not_in_roster"));

  // leave
  const onLeave = mk("leaver", "kitchen"); onRoster(onLeave, ALL);
  db.prepare("INSERT INTO leave_requests (user_id,type,date_from,date_to,days,status) VALUES (?, 'personal', ?, ?, 1, 'approved')").run(onLeave, date(3), date(3));
  ok("a day on approved leave is refused", codes(book(onLeave, plants, days(1, 6))).includes("on_leave"));

  // dates
  ok("a date outside the month is refused", codes(book(cook2, toilet, [...days(1, 5), "2027-01-02"])).includes("date_outside_month"));
  ok("a date already in the past is refused (window running into the month)", (() => {
    db.prepare("UPDATE special_duty_months SET booking_close_date = '2026-12-10' WHERE branch_id = ? AND year_month = ?").run(nama, YM);
    const r = codes(R.checkBookingSet({ userId: cook2, branchId: nama, yearMonth: YM, positionId: toilet, dates: days(1, 6), asOf: "2026-12-03" }));
    db.prepare("UPDATE special_duty_months SET booking_close_date = '2026-11-25' WHERE branch_id = ? AND year_month = ?").run(nama, YM);
    return r.includes("date_in_past");
  })());

  // max 2 positions a day
  const busy = mk("busy", "kitchen"); onRoster(busy, ALL);
  ok("busy books dish and toilet on days 16-21", book(busy, dish, days(16, 6)).ok && book(busy, toilet, days(16, 6)).ok);
  ok("a third position on the same days is refused (max 2 a day)", codes(book(busy, plants, days(16, 6))).includes("too_many_per_day"));
  ok("…but the same third position on other days is fine", book(busy, plants, days(22, 6)).ok === true);

  // the same slot: one winner, and the loser is not told who
  const a = mk("racer-a", "kitchen"), b = mk("racer-b", "kitchen"); onRoster(a, ALL); onRoster(b, ALL);
  const ra = book(a, toilet, days(24, 6)), rb = book(b, toilet, days(24, 6));
  ok("two people booking the same slots: exactly one succeeds", ra.ok === true && rb.ok === false);
  ok("the loser only learns the slot is full", !rb.ok && rb.errors.every((e) => e.code === "slot_taken") && !JSON.stringify(rb).includes("racer"));
  ok("the database allows only one holder per position per day", (() => { try { db.prepare("INSERT INTO special_duty_days (position_id,duty_date,user_id,source) VALUES (?,?,?, 'booked')").run(toilet, date(24), b); return false; } catch { return true; } })());

  // changing a booking
  ok("a person can replace their days for a position (still 6 or more)", book(cook, dish, days(1, 8)).ok === true && (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ? AND position_id = ?").get(cook, dish) as { n: number }).n === 8);
  ok("dropping to fewer than 6 is refused, dropping to none cancels", codes(book(cook, dish, days(1, 3))).includes("below_minimum_days") && book(cook, dish, []).ok === true);

  // window and disqualification
  ok("after the closing date booking is refused", codes(R.checkBookingSet({ userId: cook2, branchId: nama, yearMonth: YM, positionId: toilet, dates: days(1, 6), asOf: "2026-11-26" })).includes("booking_closed"));
  // strikes: more than 2 absences in November → cannot self-book in December
  D.enableMonth({ branchId: nama, yearMonth: "2026-11", actorId: owner, asOf: "2026-10-11" });
  const nov = D.savePosition({ branchId: nama, yearMonth: "2026-11", slotNo: 1, name: "ล้างจาน", actorId: owner, asOf: "2026-10-11" });
  const striker = mk("striker", "kitchen"), twice = mk("twice", "kitchen"); onRoster(striker, ALL); onRoster(twice, ALL);
  const absent = (uid: number, d: number) => db.prepare("INSERT INTO special_duty_days (position_id,duty_date,user_id,source,status,absent_by_holder) VALUES (?,?,?,'booked','absent',1)").run(nov.id, `2026-11-${String(d).padStart(2, "0")}`, uid);
  [3, 4, 5].forEach((d) => absent(striker, d)); [6, 7].forEach((d) => absent(twice, d));
  ok("3 missed duties last month: self-booking refused", codes(book(striker, toilet, days(1, 6))).includes("self_booking_disqualified"));
  ok("exactly 2 missed duties is still allowed (the limit is 'more than 2')", book(twice, plants, days(1, 6)).ok === true);

  // manager assignment during filling
  const filler = mk("filler", "kitchen"); onRoster(filler, ALL);
  ok("the back office can assign while booking is still open (checked, not saved)", R.checkAssignment({ userId: filler, branchId: nama, yearMonth: YM, positionId: dish, date: date(28), asOf: NOW }).ok === true);
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "booking_closed", actorId: owner });
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "filling", actorId: owner });
  ok("the manager can assign an open day to someone with 3 strikes (they may still be assigned)", R.assignDay({ userId: striker, branchId: nama, yearMonth: YM, positionId: dish, date: date(28), managerId: owner, asOf: NOW }).ok === true);
  ok("a service person cannot be assigned dish washing", codes(R.checkAssignment({ userId: waiter, branchId: nama, yearMonth: YM, positionId: dish, date: date(29), asOf: NOW })).includes("group_not_eligible"));
  ok("a person not on the roster that day cannot be assigned", codes(R.checkAssignment({ userId: owner, branchId: nama, yearMonth: YM, positionId: dish, date: date(29), asOf: NOW })).includes("not_in_roster"));
  ok("an already-held slot cannot be assigned", codes(R.checkAssignment({ userId: filler, branchId: nama, yearMonth: YM, positionId: dish, date: date(28), asOf: NOW })).includes("slot_taken"));
  ok("a manager may knowingly override roster / group / past-day, and the audit says what was stepped over", (() => {
    const args = { userId: owner, branchId: nama, yearMonth: YM, positionId: dish, date: date(26), managerId: owner, asOf: NOW };
    const refused = codes(R.checkAssignment(args));
    const forced = R.assignDay({ ...args, override: true });
    const entry = db.prepare("SELECT after_json AS a FROM special_duty_audit WHERE entity='assignment' AND action='assign' ORDER BY id DESC LIMIT 1").get() as { a: string } | undefined;
    return refused.includes("not_in_roster") && forced.ok === true && (entry?.a ?? "").includes("not_in_roster");
  })());
  ok("…but never over a taken slot", codes(R.checkAssignment({ userId: filler, branchId: nama, yearMonth: YM, positionId: dish, date: date(26), asOf: NOW, override: true })).includes("slot_taken"));
  ok("assignment respects the 2-positions-a-day limit", (() => {
    R.assignDay({ userId: filler, branchId: nama, yearMonth: YM, positionId: dish, date: date(30), managerId: owner, asOf: NOW });
    R.assignDay({ userId: filler, branchId: nama, yearMonth: YM, positionId: toilet, date: date(30), managerId: owner, asOf: NOW });
    return codes(R.checkAssignment({ userId: filler, branchId: nama, yearMonth: YM, positionId: plants, date: date(30), asOf: NOW })).includes("too_many_per_day");
  })());
  ok("bookings and assignments are audited", (db.prepare("SELECT COUNT(*) n FROM special_duty_audit WHERE entity IN ('booking','assignment')").get() as { n: number }).n >= 10);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
