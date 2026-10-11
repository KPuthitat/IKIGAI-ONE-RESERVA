// ตำแหน่งงานค่าตอบแทนพิเศษ — swapping duty days.
// Run: node --import tsx scripts/test-special-duty-swap.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-swap.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const H = await import("../src/lib/special-duty-roster");
  const F = await import("../src/lib/special-duty-fill");
  const S = await import("../src/lib/special-duty-swap");
  const roster = await import("../src/lib/roster");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof S.SwapError ? e.code : `other:${(e as Error).message}`; } };
  const NOW = "2026-11-05", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const rps = [1, 2, 3, 4].map((i) => Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, `P${i}`).lastInsertRowid));
  const mk = (u: string, dept = "service") => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,'staff','active',?)").run(u, "x", u, dept).lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, nama); return id; };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const A = mk("A"), B = mk("B"), C = mk("C"), cook = mk("cook", "kitchen");
  const up = (uid: number, d: number, pos: number) => roster.upsertAssignment({ branchId: nama, date: date(d), positionId: pos, userId: uid, shiftCodeId: shift, actingUserId: owner });
  for (let d = 1; d <= 31; d++) { up(A, d, rps[0]); up(B, d, rps[1]); up(C, d, rps[2]); up(cook, d, rps[3]); }
  // B is rostered only on days 1–20 and 25–31 (day-off 21–24)
  for (let d = 21; d <= 24; d++) db.prepare("DELETE FROM roster_assignments WHERE user_id = ? AND assignment_date = ?").run(B, date(d));

  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW });
  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "ล้างจาน", eligibleGroups: ["kitchen"], actorId: owner, asOf: NOW });
  const [toilet, dish] = D.listPositions(nama, YM);
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner, nowIso: "2026-11-20T03:00:00.000Z" });
  const book = (uid: number, days: number[], pos = toilet.id) => R.setUserBookings({ userId: uid, branchId: nama, yearMonth: YM, positionId: pos, dates: days.map(date), asOf: "2026-11-21" });
  ok("A books days 10–15, B books 16–20 and 25", book(A, [10, 11, 12, 13, 14, 15]).ok && book(B, [16, 17, 18, 19, 20, 25]).ok);
  F.closeBooking({ branchId: nama, yearMonth: YM, actorId: owner });
  F.managerAssign({ branchId: nama, yearMonth: YM, positionId: toilet.id, date: date(22), userId: C, managerId: owner, asOf: "2026-11-28" });
  F.managerAssign({ branchId: nama, yearMonth: YM, positionId: dish.id, date: date(5), userId: cook, managerId: owner, asOf: "2026-11-28" });
  const id = (pos: number, d: number) => (db.prepare("SELECT id FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(pos, date(d)) as { id: number }).id;
  const holder = (pos: number, d: number) => (db.prepare("SELECT user_id u FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(pos, date(d)) as { u: number }).u;
  const today = "2026-12-01";

  ok("not before the schedule is published", code(() => S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 16), today })) === "wrong_stage");
  F.publishSchedule({ branchId: nama, yearMonth: YM, actorId: owner, allowUnfilled: true, asOf: "2026-11-28" });

  ok("you can only offer your own day", code(() => S.proposeSwap({ userId: B, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 16), today })) === "forbidden");
  ok("not with yourself", code(() => S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 11), today })) === "same_person");
  ok("the group rule holds: the service person cannot take the kitchen position's day", code(() => S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(dish.id, 5), today })) === "not_eligible");
  ok("roster rule: B is off on 21–24, so A cannot swap B into a day there — C's day 22", code(() => S.proposeSwap({ userId: C, myDayId: id(toilet.id, 22), theirDayId: id(toilet.id, 16), today })) === "not_eligible");
  ok("notice rule: needs 1 day before the earlier date — too late on the day itself", code(() => S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 16), today: date(10) })) === "too_late");
  ok("…but fine the day before", (() => { try { return S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 16), today: date(9) }) > 0; } catch { return false; } })());
  db.prepare("DELETE FROM special_duty_swaps").run();

  const sid = S.proposeSwap({ userId: A, myDayId: id(toilet.id, 10), theirDayId: id(toilet.id, 16), note: "ติดธุระ", today });
  ok("A proposes (10 ↔ 16): nothing moves yet", holder(toilet.id, 10) === A && holder(toilet.id, 16) === B);
  ok("the same days cannot be in two open requests", code(() => S.proposeSwap({ userId: B, myDayId: id(toilet.id, 16), theirDayId: id(toilet.id, 11), today })) === "already_pending");
  ok("only B can answer", code(() => S.respondToSwap({ swapId: sid, userId: C, accept: true, today })) === "forbidden");
  ok("the manager cannot decide before B accepts", code(() => S.decideSwap({ swapId: sid, branchId: nama, managerId: owner, approve: true, today })) === "wrong_status");
  S.respondToSwap({ swapId: sid, userId: B, accept: true, today });
  ok("B accepts: still nothing moved, waiting for the manager", holder(toilet.id, 10) === A && S.listPendingForManager(nama, YM).length === 1);
  ok("another branch's manager cannot decide it", code(() => S.decideSwap({ swapId: sid, branchId: nama + 99, managerId: owner, approve: true, today })) === "not_found");
  ok("rejecting needs a reason", code(() => S.decideSwap({ swapId: sid, branchId: nama, managerId: owner, approve: false, today })) === "note_required");

  // the situation changes between acceptance and approval: B gets approved leave on day 10
  db.prepare("INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status) VALUES (?, 'sick', ?, ?, 1, 'approved')").run(B, date(10), date(10));
  ok("approval re-checks: B on leave on day 10 → refused, nothing moved", code(() => S.decideSwap({ swapId: sid, branchId: nama, managerId: owner, approve: true, today })) === "not_eligible" && holder(toilet.id, 10) === A && holder(toilet.id, 16) === B);
  db.prepare("DELETE FROM leave_requests").run();

  S.decideSwap({ swapId: sid, branchId: nama, managerId: owner, approve: true, note: "อนุมัติ", today });
  ok("approved: the two days changed hands (10 → B, 16 → A)", holder(toilet.id, 10) === B && holder(toilet.id, 16) === A);
  ok("each person still has the same NUMBER of days (6 and 6), so minimums are unaffected", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ? AND position_id = ?").get(A, toilet.id) as { n: number }).n === 6 && (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ? AND position_id = ?").get(B, toilet.id) as { n: number }).n === 6);
  ok("the swap is audited", !!db.prepare("SELECT 1 FROM special_duty_audit WHERE entity='swap' AND action='approve'").get());
  ok("an approved swap cannot be decided again", code(() => S.decideSwap({ swapId: sid, branchId: nama, managerId: owner, approve: true, today })) === "wrong_status");

  // decline / cancel / reject paths
  const s2 = S.proposeSwap({ userId: A, myDayId: id(toilet.id, 11), theirDayId: id(toilet.id, 17), today });
  S.respondToSwap({ swapId: s2, userId: B, accept: false, today });
  ok("B declines → closed, days untouched", (db.prepare("SELECT status s FROM special_duty_swaps WHERE id=?").get(s2) as { s: string }).s === "declined" && holder(toilet.id, 11) === A);
  const s3 = S.proposeSwap({ userId: A, myDayId: id(toilet.id, 11), theirDayId: id(toilet.id, 17), today });
  ok("only the proposer can cancel", code(() => S.cancelSwap({ swapId: s3, userId: B })) === "forbidden");
  S.cancelSwap({ swapId: s3, userId: A });
  ok("cancelled, and the days are free to be offered again", (() => { const s = S.proposeSwap({ userId: A, myDayId: id(toilet.id, 11), theirDayId: id(toilet.id, 17), today }); S.respondToSwap({ swapId: s, userId: B, accept: true, today }); S.decideSwap({ swapId: s, branchId: nama, managerId: owner, approve: false, note: "ไม่สะดวก", today }); return (db.prepare("SELECT status s FROM special_duty_swaps WHERE id=?").get(s) as { s: string }).s === "rejected" && holder(toilet.id, 11) === A; })());

  // a day already being done cannot be swapped
  db.prepare("UPDATE special_duty_days SET status = 'submitted' WHERE id = ?").run(id(toilet.id, 12));
  ok("a day already submitted/approved/absent cannot be swapped", code(() => S.proposeSwap({ userId: A, myDayId: id(toilet.id, 12), theirDayId: id(toilet.id, 18), today })) === "day_not_swappable");
  db.prepare("UPDATE special_duty_days SET status = 'booked' WHERE id = ?").run(id(toilet.id, 12));

  // lists
  const mine = S.listMySwaps(A, YM);
  ok("A sees 3 sent requests, B sees them as incoming", mine.sent.length >= 3 && S.listMySwaps(B, YM).incoming.length >= 3 && S.listMySwaps(C, YM).sent.length === 0);
  const pick = S.swappableDays(A, nama, YM, today);
  ok("the picker lists my 6 swappable days and only other people's on the other side", pick.mine.length === 6 && pick.others.length > 0 && pick.others.every((o) => o.holderId !== A));
  db.prepare("UPDATE special_duty_days SET status = 'submitted' WHERE id = ?").run(id(toilet.id, 13));
  ok("…and a day already submitted never shows up", !S.swappableDays(A, nama, YM, today).mine.some((m) => m.dayId === id(toilet.id, 13)));
  ok("…and once the notice window has passed a day drops out of the picker", S.swappableDays(A, nama, YM, date(11)).mine.every((m) => m.date >= date(12)));

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
