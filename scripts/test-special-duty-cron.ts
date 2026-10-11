// ตำแหน่งงานค่าตอบแทนพิเศษ — the daily job: auto-close, alerts, reminders, digests, retention.
// Run: node --import tsx scripts/test-special-duty-cron.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-cron.db");
const PHOTOS = fs.mkdtempSync(path.join(os.tmpdir(), "sd-cron-"));
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } try { fs.rmSync(PHOTOS, { recursive: true, force: true }); } catch { /* ignore */ } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP; process.env.SPECIAL_DUTY_PHOTO_DIR = PHOTOS;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const H = await import("../src/lib/special-duty-roster");
  const F = await import("../src/lib/special-duty-fill");
  const C = await import("../src/lib/special-duty-cron");
  const roster = await import("../src/lib/roster");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const NOW = "2026-11-05", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const rps = [1, 2, 3].map((i) => Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, `P${i}`).lastInsertRowid));
  const mk = (u: string, line: string | null, admin = false) => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department,line_user_id) VALUES (?,?,?,?,'active','service',?)").run(u, "x", u, admin ? "admin" : "staff", line).lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id,branch_id,is_admin) VALUES (?,?,?)").run(id, nama, admin ? 1 : 0); return id; };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,line_user_id) VALUES ('boss','x','Boss','super_admin','active','U-owner')").run().lastInsertRowid);
  const mgr = mk("mgr", "U-mgr", true), a = mk("a", "U-a"), b = mk("b", null);
  const up = (uid: number, d: number, pos: number) => roster.upsertAssignment({ branchId: nama, date: date(d), positionId: pos, userId: uid, shiftCodeId: shift, actingUserId: owner });
  for (let d = 1; d <= 31; d++) { up(a, d, rps[0]); up(b, d, rps[1]); }

  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW });
  const toilet = D.listPositions(nama, YM)[0];
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner, nowIso: "2026-11-20T03:00:00.000Z" });
  R.setUserBookings({ userId: a, branchId: nama, yearMonth: YM, positionId: toilet.id, dates: [10, 11, 12, 13, 14, 15].map(date), asOf: "2026-11-21" });
  R.setUserBookings({ userId: b, branchId: nama, yearMonth: YM, positionId: toilet.id, dates: [16, 17, 18, 19, 20, 21].map(date), asOf: "2026-11-21" });

  const sent: Array<{ to: string[]; text: string }> = [];
  const push = async (to: Array<string | null>, flex: { altText: string; contents: unknown }) => { const real = to.filter((x): x is string => !!x); sent.push({ to: real, text: JSON.stringify(flex.contents) }); return real.length; };
  const run = (today: string, hhmm = "09:30") => C.runSpecialDutyDaily({ today, hhmm, push });
  const to = (who: string) => sent.filter((s) => s.to.includes(who));
  const mentions = (who: string, needle: string) => to(who).filter((s) => s.text.includes(needle)).length;
  const closeDate = D.getMonth(nama, YM).bookingCloseDate!;

  let r = await run(closeDate);
  ok("while the booking window is open nothing is closed", r.closed === 0 && D.getMonth(nama, YM).status === "booking_open");
  r = await run(addDay(closeDate, 1), "00:30");
  function addDay(iso: string, n: number) { return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }
  ok("the day after, the window closes by itself", r.closed === 1 && D.getMonth(nama, YM).status === "booking_closed");
  ok("the managers (not staff, not the owner) are told how many days are open", mentions("U-mgr", "ปิดรับการเลือกวัน") === 1 && to("U-a").length === 0 && to("U-owner").length === 0);
  const before = sent.length;
  await run(addDay(closeDate, 1), "00:35");
  ok("running again changes nothing (no duplicate message)", sent.length === before);

  F.fillOpenDays({ branchId: nama, yearMonth: YM, managerId: mgr, commit: true, asOf: "2026-11-28" });
  F.publishSchedule({ branchId: nama, yearMonth: YM, actorId: mgr, allowUnfilled: true, asOf: "2026-11-28" });

  // queued roster alerts go out once, to managers only
  db.prepare("DELETE FROM special_duty_alerts").run();
  db.prepare("INSERT INTO special_duty_alerts (branch_id, year_month, kind, dedupe_key, payload_json, created_at) VALUES (?,?, 'slot_released', 'x', ?, ?)").run(nama, YM, JSON.stringify({ positionName: "ล้างห้องน้ำ", date: date(12) }), new Date().toISOString());
  sent.length = 0;
  await run(date(1), "10:00");
  ok("a queued 'slot released' alert reaches the managers, once", mentions("U-mgr", "วันว่างจากการเปลี่ยนตาราง") === 1 && !!db.prepare("SELECT 1 FROM special_duty_alerts WHERE kind='slot_released' AND notified_at IS NOT NULL").get());
  ok("the first morning after publication the OWNER is told the duty is shared by too few people", mentions("U-owner", "ต่ำกว่าเกณฑ์") === 1 && to("U-a").length === 0);
  sent.length = 0; await run(date(1), "10:05");
  ok("…and not again", mentions("U-mgr", "วันว่างจากการเปลี่ยนตาราง") === 0);

  // reminders
  sent.length = 0;
  await run(date(9), "08:30");
  ok("before 09:00 no reminders go out", to("U-a").length === 0);
  await run(date(9), "09:30");
  ok("the day before (9th, from 09:00) a's 10th gets a reminder naming the position", mentions("U-a", "พรุ่งนี้ท่านมีตำแหน่งงานค่าตอบแทนพิเศษ") === 1);
  const n1 = sent.length; await run(date(9), "09:40");
  ok("the same reminder is not repeated on the next cron run", sent.length === n1);
  sent.length = 0; await run(date(15), "09:30");
  ok("b has no LINE id (day 16): nothing is sent to anyone for b, no crash, and it is not retried forever", !sent.some((x) => x.text.includes("พรุ่งนี้ท่านมี") && x.to.includes("U-b")) && !!db.prepare("SELECT 1 FROM special_duty_alerts WHERE kind='reminder_day' AND dedupe_key LIKE '%:2026-12-16'").get());
  sent.length = 0;
  await run(date(11), "09:30");
  ok("on the last day to send evidence (11th for the 10th) a gets the deadline reminder", mentions("U-a", "วันสุดท้ายในการส่งหลักฐาน") === 1);
  ok("…plus the reminder for the 12th (tomorrow) as usual", mentions("U-a", "พรุ่งนี้") === 1);
  // evidence submitted → no deadline reminder next time for that day
  db.prepare("UPDATE special_duty_days SET status='submitted' WHERE position_id=? AND duty_date=?").run(toilet.id, date(11));
  sent.length = 0; await run(date(12), "09:30");
  ok("a day already submitted gets no deadline reminder", mentions("U-a", "วันสุดท้ายในการส่งหลักฐาน") === 0);
  ok("the managers' digest that morning says one day of evidence is waiting for review", mentions("U-mgr", "หลักฐานรอตรวจ 1 วัน") === 1);
  sent.length = 0; await run(date(20), "09:30");
  ok("after the deadline, days with no evidence are reported to the managers", mentions("U-mgr", "ไม่มีการส่งหลักฐานหลังพ้นกำหนด") === 1);
  ok("the owner alert already sent for this same content is not repeated days later", mentions("U-owner", "ต่ำกว่าเกณฑ์") === 0);
  sent.length = 0; await run(date(21), "09:30");
  ok("…still not repeated the next day while nothing changed", mentions("U-owner", "ต่ำกว่าเกณฑ์") === 0);
  ok("the manager digest repeats daily while there is still work", mentions("U-mgr", "สรุปตำแหน่งงานค่าตอบแทนพิเศษ") === 1);

  // channel not ready: don't burn the message
  const none = async () => 0;
  db.prepare("DELETE FROM special_duty_alerts WHERE kind = 'digest'").run();
  await C.runSpecialDutyDaily({ today: date(22), hhmm: "09:30", push: none });
  ok("when LINE is unreachable the digest is NOT marked sent", !db.prepare("SELECT 1 FROM special_duty_alerts WHERE kind='digest' AND dedupe_key = ?").get(date(22)));
  sent.length = 0; await run(date(22), "09:35");
  ok("…and goes out on the next run once LINE works", mentions("U-mgr", "สรุปตำแหน่งงานค่าตอบแทนพิเศษ") === 1);

  // retention
  const ev = db.prepare("SELECT id FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(toilet.id, date(11)) as { id: number };
  fs.mkdirSync(path.join(PHOTOS, String(nama)), { recursive: true }); fs.writeFileSync(path.join(PHOTOS, String(nama), "old.jpg"), "x");
  db.prepare("INSERT INTO special_duty_evidence (day_id, branch_id, filename, uploaded_by, uploaded_at) VALUES (?,?,?,?,?)").run(ev.id, nama, "old.jpg", a, new Date(Date.now() - 100 * 86_400_000).toISOString());
  const rr = await run(date(23), "03:00");
  ok("the daily job deletes evidence photos older than 90 days (even at night)", rr.swept === 1 && !fs.existsSync(path.join(PHOTOS, String(nama), "old.jpg")));

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
