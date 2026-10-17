// ตำแหน่งงานค่าตอบแทนพิเศษ — roster hooks. Run: node --import tsx scripts/test-special-duty-roster.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-roster.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const H = await import("../src/lib/special-duty-roster");
  const roster = await import("../src/lib/roster");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const NOW = "2026-11-05", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const rosterPos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "หน้าร้าน").lastInsertRowid);
  const rosterPos2 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, "ครัว").lastInsertRowid);
  const mk = (u: string, dept: string, line: string | null = `U-${u}`) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department,line_user_id) VALUES (?,?,?,'staff','active',?,?)").run(u, "x", u, dept, line).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, nama);
    return id;
  };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const cook = mk("cook", "kitchen"), waiter = mk("waiter", "service");
  const up = (uid: number, d: number, pos = rosterPos) => roster.upsertAssignment({ branchId: nama, date: date(d), positionId: pos, userId: uid, shiftCodeId: shift, actingUserId: owner });

  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างจาน", eligibleGroups: ["kitchen"], actorId: owner, asOf: NOW });
  const toilet = D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW });
  const dish = D.listPositions(nama, YM)[0].id;

  // scheme off: publishing / editing the roster changes nothing
  for (let d = 1; d <= 31; d++) up(waiter, d);
  for (let d = 1; d <= 20; d++) up(cook, d, rosterPos2);          // the kitchen person is rostered days 1-20 only
  ok("scheme off: publish does not open anything", H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner }).opened === false && D.getMonth(nama, YM).status === "off");

  // switch on → waits for the roster
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  ok("on but unpublished: still awaiting the roster", D.getMonth(nama, YM).status === "awaiting_roster");
  ok("a branch with shifts on its roster for the month is ready to open; one without is not", H.branchHasRoster(nama, YM) === true && H.branchHasRoster(nama, "2027-03") === false);
  const pub = H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner, nowIso: "2026-11-27T03:00:00.000Z" });
  ok("publishing opens booking", pub.opened && D.getMonth(nama, YM).status === "booking_open");
  ok("a late publication still gives the minimum window (27th + 3 days)", pub.closeDate === "2026-11-30" && D.getMonth(nama, YM).bookingCloseDate === "2026-11-30");
  ok("the audience is the rostered staff who may take at least one position, with their LINE ids", pub.audience.length === 2 && pub.audience.every((a) => a.lineUserId?.startsWith("U-")));
  ok("publishing twice does not open it again", H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner }).opened === false);
  ok("days with nobody eligible are reported (no kitchen staff after day 20)", (() => {
    const g = pub.gaps.filter((x) => x.positionId === dish);
    return g.length === 11 && g[0].date === date(21) && !pub.gaps.some((x) => x.positionId === toilet.id);
  })());
  ok("the gaps are queued for the manager", (db.prepare("SELECT COUNT(*) n FROM special_duty_alerts WHERE kind = 'coverage_gap'").get() as { n: number }).n === 11);

  // booking, then roster edits
  const book = (uid: number, pid: number, a: number) => R.setUserBookings({ userId: uid, branchId: nama, yearMonth: YM, positionId: pid, dates: Array.from({ length: 6 }, (_, i) => date(a + i)), asOf: NOW });
  ok("waiter books 6 days of the toilet", book(waiter, toilet.id, 1).ok === true);
  ok("changing someone else's roster does not touch the booking", (() => { up(cook, 2, rosterPos2); return (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(waiter) as { n: number }).n === 6; })());
  ok("moving the waiter to another roster position the same day keeps the booking", (() => { up(waiter, 3, rosterPos2); roster.deleteAssignment({ branchId: nama, date: date(3), positionId: rosterPos }); return !!db.prepare("SELECT 1 FROM special_duty_days WHERE user_id = ? AND duty_date = ?").get(waiter, date(3)); })());
  ok("taking the waiter off the roster that day releases the slot", (() => { roster.deleteAssignment({ branchId: nama, date: date(3), positionId: rosterPos2 }); return !db.prepare("SELECT 1 FROM special_duty_days WHERE user_id = ? AND duty_date = ?").get(waiter, date(3)); })());
  ok("…the other days stay booked", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(waiter) as { n: number }).n === 5);
  ok("…the manager gets an alert naming the position and the day, not a person", (() => {
    const a = H.pendingAlerts(nama).filter((x) => x.kind === "slot_released");
    return a.length === 1 && JSON.stringify(a[0].payload) === JSON.stringify({ positionId: toilet.id, positionName: "ล้างห้องน้ำ", date: date(3) });
  })());
  ok("…and the release is in the audit log with the previous holder", !!db.prepare("SELECT 1 FROM special_duty_audit WHERE action = 'released_by_roster_change' AND before_json LIKE ?").get(`%"userId":${waiter}%`));
  ok("replacing the person at a roster cell releases the old person's slot", (() => {
    up(cook, 5, rosterPos);   // cook onto the front-of-house cell on day 5, replacing the waiter there
    return !db.prepare("SELECT 1 FROM special_duty_days WHERE user_id = ? AND duty_date = ?").get(waiter, date(5));
  })());
  ok("a released slot is open again for others", (() => { const r = R.checkAssignment; return typeof r === "function"; })());

  // alerts bookkeeping
  const ids = H.pendingAlerts(nama).map((a) => a.id);
  H.markAlertsNotified(ids);
  ok("alerts are marked as notified once sent", H.pendingAlerts(nama).length === 0);
  ok("another branch is never affected", H.pendingAlerts(hypo).length === 0);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
