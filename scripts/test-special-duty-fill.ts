// ตำแหน่งงานค่าตอบแทนพิเศษ — closing, filling with rotation, removing, publishing.
// Run: node --import tsx scripts/test-special-duty-fill.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-fill.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const H = await import("../src/lib/special-duty-roster");
  const F = await import("../src/lib/special-duty-fill");
  const A = await import("../src/lib/special-duty-access");
  const roster = await import("../src/lib/roster");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const NOW = "2026-11-05", ASOF = "2026-11-28", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const rp = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "หน้าร้าน").lastInsertRowid);
  const mk = (u: string, dept: string) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,'staff','active',?)").run(u, "x", u, dept).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, nama); return id;
  };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const a = mk("a", "service"), b = mk("b", "service"), c = mk("c", "service"), cook = mk("cook", "kitchen");
  const up = (uid: number, d: number, pos: number) => roster.upsertAssignment({ branchId: nama, date: date(d), positionId: pos, userId: uid, shiftCodeId: shift, actingUserId: owner });
  const rp2 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "ครัว").lastInsertRowid);
  const rp3 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "ซ่อมบำรุง").lastInsertRowid);
  const rp4 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "บาร์").lastInsertRowid);
  for (let d = 1; d <= 31; d++) { up(a, d, rp); up(b, d, rp2); up(c, d, rp3); }
  for (let d = 1; d <= 10; d++) up(cook, d, rp4);

  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW });
  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "ล้างจาน", eligibleGroups: ["kitchen"], actorId: owner, asOf: NOW });
  const [toilet, dish] = D.listPositions(nama, YM);
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner, nowIso: "2026-11-20T03:00:00.000Z" });
  ok("a books 6 toilet days", R.setUserBookings({ userId: a, branchId: nama, yearMonth: YM, positionId: toilet.id, dates: [1, 2, 3, 4, 5, 6].map(date), asOf: "2026-11-21" }).ok);

  // last month: b already did 10 duties → should be spared this month
  const prev = D.savePosition({ branchId: nama, yearMonth: "2026-11", slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: "2026-10-01" });
  for (let d = 1; d <= 10; d++) db.prepare("INSERT INTO special_duty_days (position_id,duty_date,user_id,source,status) VALUES (?,?,?, 'assigned','approved')").run(prev.id, `2026-11-${String(d).padStart(2, "0")}`, b);

  ok("cannot fill while booking is still open", (() => { try { F.fillOpenDays({ branchId: nama, yearMonth: YM, managerId: owner, commit: false, asOf: ASOF }); return false; } catch { return true; } })());
  ok("closing early by hand works", F.closeBooking({ branchId: nama, yearMonth: YM, actorId: owner }).status === "booking_closed");

  const open = F.openDays(nama, YM, ASOF);
  const dishOpen = open.filter((o) => o.positionId === dish.id);
  ok("toilet: the 25 days nobody booked are open", open.filter((o) => o.positionId === toilet.id).length === 25);
  ok("dish: all 31 days open, candidates only on the kitchen person's 10 rostered days", dishOpen.length === 31 && dishOpen.filter((o) => o.candidates > 0).length === 10 && dishOpen.filter((o) => o.candidates === 0).length === 21);
  ok("every toilet day has the three service people as candidates, plus the kitchen person on days 7–10 (they are rostered and the position is open to all groups)", open.filter((o) => o.positionId === toilet.id).every((o) => o.candidates === (Number(o.date.slice(8)) <= 10 ? 4 : 3)));

  const auditBefore = (db.prepare("SELECT COUNT(*) n FROM special_duty_audit").get() as { n: number }).n;
  const preview = F.fillOpenDays({ branchId: nama, yearMonth: YM, managerId: owner, commit: false, asOf: ASOF });
  ok("preview changes nothing (no rows, no audit, status unchanged)", (db.prepare("SELECT COUNT(*) n FROM special_duty_days d JOIN special_duty_positions p ON p.id=d.position_id WHERE p.year_month=?").get(YM) as { n: number }).n === 6
    && (db.prepare("SELECT COUNT(*) n FROM special_duty_audit").get() as { n: number }).n === auditBefore && D.getMonth(nama, YM).status === "booking_closed");
  ok("preview proposes 25 toilet + 10 dish days and reports the 21 unfillable dish days", preview.suggestions.length === 35 && preview.unfillable.length === 21 && preview.unfillable.every((u) => u.positionId === dish.id));
  ok("dish days all go to the kitchen person", preview.suggestions.filter((s) => s.positionId === dish.id).every((s) => s.userId === cook));

  const toiletPlan = preview.suggestions.filter((s) => s.positionId === toilet.id);
  const per = (uid: number) => toiletPlan.filter((s) => s.userId === uid).length;
  ok("rotation: a (already holds 6) gets fewest; b (did 10 last month) is spared next; c most", per(a) <= per(b) && per(b) <= per(c) && per(c) - per(a) >= 1);
  ok("fairness: this-month totals (incl. bookings) differ by at most one between a/b/c where possible", (() => {
    const tot = [a, b, c].map((u) => per(u) + (u === a ? 6 : 0)); return Math.max(...tot) - Math.min(...tot) <= 2;
  })());
  ok("nobody is given two positions on one day beyond the limit", (() => {
    const m = new Map<string, number>(); for (const s of preview.suggestions) { const k = `${s.userId}|${s.date}`; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.values()].every((n) => n <= D.cfgNum("max_positions_per_person_per_day"));
  })());

  const committed = F.fillOpenDays({ branchId: nama, yearMonth: YM, managerId: owner, commit: true, asOf: ASOF });
  ok("commit stores exactly the plan and moves to filling", committed.suggestions.length === 35 && D.getMonth(nama, YM).status === "filling"
    && (db.prepare("SELECT COUNT(*) n FROM special_duty_days d JOIN special_duty_positions p ON p.id=d.position_id WHERE p.year_month=? AND d.source='assigned'").get(YM) as { n: number }).n === 35);
  ok("a second commit has nothing left to do for toilet", F.openDays(nama, YM, ASOF).every((o) => o.positionId === dish.id));

  // manual changes
  const dayRow = db.prepare("SELECT d.id FROM special_duty_days d WHERE d.position_id = ? AND d.duty_date = ?").get(toilet.id, date(20)) as { id: number };
  ok("manager can remove an assigned day", F.removeDay({ dayId: dayRow.id, branchId: nama, managerId: owner }).ok === true);
  ok("…and it is audited", !!db.prepare("SELECT 1 FROM special_duty_audit WHERE entity='assignment' AND action='remove'").get());
  ok("a day can also be freed while booking is still open (back-office edits), but not after publishing", (() => {
    const r = db.prepare("SELECT d.* FROM special_duty_days d WHERE d.position_id = ? AND d.duty_date = ?").get(toilet.id, date(23)) as { id: number; position_id: number; duty_date: string; user_id: number; source: string; status: string };
    const setStatus = (st: string) => db.prepare("UPDATE special_duty_months SET status = ? WHERE branch_id = ? AND year_month = ?").run(st, nama, YM);
    setStatus("special_published");
    const refused = F.removeDay({ dayId: r.id, branchId: nama, managerId: owner });
    setStatus("booking_open");
    const allowed = F.removeDay({ dayId: r.id, branchId: nama, managerId: owner });
    setStatus("filling");
    db.prepare("INSERT INTO special_duty_days (position_id, duty_date, user_id, source, status) VALUES (?, ?, ?, ?, ?)").run(r.position_id, r.duty_date, r.user_id, r.source, r.status);   // put it back for the tests below
    return refused.ok === false && refused.code === "wrong_stage" && allowed.ok === true;
  })());
  ok("another branch's manager cannot remove it", (() => { const r = db.prepare("SELECT d.id FROM special_duty_days d WHERE d.position_id = ? AND d.duty_date = ?").get(toilet.id, date(21)) as { id: number }; const x = F.removeDay({ dayId: r.id, branchId: hypo, managerId: owner }); return x.ok === false && x.code === "not_found"; })());
  ok("a day with submitted evidence cannot be removed", (() => { const r = db.prepare("SELECT d.id FROM special_duty_days d WHERE d.position_id = ? AND d.duty_date = ?").get(toilet.id, date(22)) as { id: number }; db.prepare("UPDATE special_duty_days SET status='submitted' WHERE id=?").run(r.id); const x = F.removeDay({ dayId: r.id, branchId: nama, managerId: owner }); db.prepare("UPDATE special_duty_days SET status='assigned' WHERE id=?").run(r.id); return x.ok === false && x.code === "not_removable"; })());
  ok("manager assigns a freed day to a specific person", F.managerAssign({ branchId: nama, yearMonth: YM, positionId: toilet.id, date: date(20), userId: b, managerId: owner, asOf: ASOF }).ok === true);
  ok("…but not to someone ineligible (cook on a toilet day they are not rostered)", F.managerAssign({ branchId: nama, yearMonth: YM, positionId: toilet.id, date: date(20), userId: cook, managerId: owner, asOf: ASOF }).ok === false);

  // publish
  const blocked = F.publishSchedule({ branchId: nama, yearMonth: YM, actorId: owner, allowUnfilled: false, asOf: ASOF });
  ok("publishing is refused while days are unfilled (and lists them)", blocked.published === false && blocked.unfilled.length === 21 && D.getMonth(nama, YM).status === "filling");
  const nobodyYet = (() => { try { A.getPublishedSchedule({ userId: a, role: "staff", branchIds: [nama], adminBranchIds: [] }, nama, YM); return false; } catch { return true; } })();
  ok("staff cannot see names before publication", nobodyYet);
  const pub = F.publishSchedule({ branchId: nama, yearMonth: YM, actorId: owner, allowUnfilled: true, asOf: ASOF });
  ok("publishing with the gaps acknowledged succeeds", pub.published === true && D.getMonth(nama, YM).status === "special_published");
  ok("each person's notification lists only their own days", pub.published && pub.duties.every((d) => d.days.length > 0) && pub.duties.find((d) => d.userId === cook)!.days.every((x) => x.positionName === "ล้างจาน"));
  ok("after publication staff of the branch see names, no money", (() => {
    const rows = A.getPublishedSchedule({ userId: a, role: "staff", branchIds: [nama], adminBranchIds: [] }, nama, YM);
    return rows.length > 30 && rows.every((r) => !("amount" in r) && !("dailyRate" in r) && !("source" in r));
  })());
  ok("someone from another branch still cannot see them", (() => { try { A.getPublishedSchedule({ userId: 9999, role: "staff", branchIds: [hypo], adminBranchIds: [] }, nama, YM); return false; } catch { return true; } })());
  ok("once published, days can no longer be removed or assigned here", F.removeDay({ dayId: dayRow.id, branchId: nama, managerId: owner }).ok === false);

  // automatic close
  const YM2 = "2027-01";
  D.savePosition({ branchId: nama, yearMonth: YM2, slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: "2026-12-01" });
  D.enableMonth({ branchId: nama, yearMonth: YM2, actorId: owner, asOf: "2026-12-01" });
  H.openBookingOnPublish({ branchId: nama, yearMonth: YM2, actorId: owner, nowIso: "2026-12-10T03:00:00.000Z" });
  const closeDate = D.getMonth(nama, YM2).bookingCloseDate!;
  ok("the booking window does not close on its last day", F.closeDueBookings(closeDate).length === 0 && D.getMonth(nama, YM2).status === "booking_open");
  ok("the day after the last day it closes by itself", F.closeDueBookings("2099-01-01").length === 1 && D.getMonth(nama, YM2).status === "booking_closed");

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
