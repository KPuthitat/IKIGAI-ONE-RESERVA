// Forgotten clock-out gate (owner 2026-11-09): no clock-in until the warning letter is acknowledged (PIN),
// the letter goes out in the afternoon when the next day is a day off, and the lapse ledger feeds the stats.
// Run:  node --import tsx scripts/test-missing-out-gate.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-missing-out-gate.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/discipline");
  const M = await import("../src/lib/missing-out");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const mkUser = (u: string, name: string) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,'x',?,'staff','active')").run(u, name).lastInsertRowid);
  const sc = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind,active) VALUES (?,'D','Day','11:00','21:00','work',1)").run(br).lastInsertRowid);
  const posOf = new Map<number, number>();     // one roster position per person (a position holds one person per day)
  const pos = (uid: number) => { let p = posOf.get(uid); if (!p) { p = Number(db.prepare("INSERT INTO roster_positions (branch_id,title,active) VALUES (?,?,1)").run(br, `ตำแหน่ง${uid}`).lastInsertRowid); posOf.set(uid, p); } return p; };
  const roster = (uid: number, date: string) => db.prepare("INSERT OR REPLACE INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(br, date, pos(uid), uid, sc);
  // Bangkok-local punch: date + HH:MM → UTC ISO.
  const punch = (uid: number, type: "in" | "out", date: string, hhmm: string) =>
    db.prepare("INSERT INTO time_entries (user_id, branch_id, type, ts) VALUES (?,?,?,?)").run(uid, br, type, new Date(`${date}T${hhmm}:00+07:00`).toISOString());

  // ── Person A forgot to clock out on Wed 04 Nov; today is Thu 05 Nov (has a shift) ──
  const a = mkUser("a", "เอ");
  punch(a, "in", "2026-11-04", "11:00");
  roster(a, "2026-11-04"); roster(a, "2026-11-05");
  const g1 = M.missingOutClockInGate(a, br, "2026-11-05");
  ok("a forgotten clock-out blocks the next clock-in and names the day + letter", !!g1 && g1.workDate === "2026-11-04" && g1.warningId > 0);
  ok("the letter was issued by the system, still pending (not acknowledged)", (db.prepare("SELECT acknowledged_at a FROM disciplinary_warnings WHERE id=?").get(g1!.warningId) as { a: string | null }).a === null);
  ok("no certification filed yet → the gate says one is needed too", g1!.needsCert === true);
  const g2 = M.missingOutClockInGate(a, br, "2026-11-05");
  ok("a second attempt reuses the same letter (one lapse = one letter)", g2!.warningId === g1!.warningId && (db.prepare("SELECT COUNT(*) n FROM disciplinary_warnings WHERE user_id=?").get(a) as { n: number }).n === 1);
  ok("blocked attempts are counted in the ledger", (db.prepare("SELECT blocked_attempts b FROM missing_out_lapses WHERE user_id=?").get(a) as { b: number }).b === 2);

  // Filing a certification does not lift the block by itself.
  db.prepare("INSERT INTO time_certifications (entry_id, requested_by, reason, proposed_ts, kind, entry_type, work_date, branch_id, status, created_at) VALUES (NULL,?,?,?,'missing','out','2026-11-04',?,'pending',?)")
    .run(a, "ลืม", new Date("2026-11-04T21:00:00+07:00").toISOString(), br, new Date().toISOString());
  const g3 = M.missingOutClockInGate(a, br, "2026-11-05");
  ok("a certification alone does NOT unblock · needsCert is false once filed", !!g3 && g3.needsCert === false);

  // Leaving the letter page never acknowledges a missing-out letter.
  const wRow = D.getWarning(g1!.warningId)!;
  ok("the letter is recognised as a missing-out letter (auto-ack on page leave is refused)", D.isMissingOutLetter(wRow));

  // PIN-acknowledged → unblocked, ledger updated.
  ok("acknowledging the letter works", D.acknowledgeWarning(g1!.warningId, "pin_explicit") === true);
  ok("clock-in is open after the letter is acknowledged", M.missingOutClockInGate(a, br, "2026-11-05") === null);
  ok("the ledger shows it acknowledged", (db.prepare("SELECT acknowledged_at a FROM missing_out_lapses WHERE user_id=?").get(a) as { a: string | null }).a !== null);

  // ── Person B: the certification form acknowledges the system's letter (no second letter) ──
  const b = mkUser("b", "บี");
  punch(b, "in", "2026-11-04", "11:00"); roster(b, "2026-11-05");
  const gb = M.missingOutClockInGate(b, br, "2026-11-05");
  const viaCert = D.createMissingOutWarning({ branchId: br, userId: b, workDate: "2026-11-04" });
  ok("certification reuses the pending letter and acknowledges it", viaCert.reused && viaCert.id === gb!.warningId && M.missingOutClockInGate(b, br, "2026-11-05") === null);
  ok("the ladder count for that day ignores the letter itself", D.recentMissingOutWarnings(b, "2026-11-04") === 0 && D.recentMissingOutWarnings(b) === 1);

  // ── Person C: overnight shift (out next morning) is not a lapse; person D voided letter is excused ──
  const c = mkUser("c", "ซี");
  punch(c, "in", "2026-11-04", "22:00");
  const overnight = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind,active) VALUES (?,'N','Night','22:00','06:00','work',1)").run(br).lastInsertRowid);
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(br, "2026-11-04", pos(c), c, overnight);
  ok("an overnight shift is not flagged", M.missingOutClockInGate(c, br, "2026-11-05") === null);
  const d = mkUser("d", "ดี");
  punch(d, "in", "2026-11-04", "11:00");
  const gd = M.missingOutClockInGate(d, br, "2026-11-05");
  const admin = mkUser("adm", "แอดมิน");
  D.voidWarning(gd!.warningId, admin, "ระบบขัดข้อง");
  ok("voided letter is not a blocker, and the excused lapse is never re-issued", D.blockingMissingOutLetter(d) === null && M.missingOutClockInGate(d, br, "2026-11-05") === null && (db.prepare("SELECT COUNT(*) n FROM disciplinary_warnings WHERE user_id=?").get(d) as { n: number }).n === 1);

  // ── Afternoon run: next day is a day off → letter goes out from 13:00, once ──
  const e = mkUser("e", "อี");
  punch(e, "in", "2026-11-04", "11:00"); roster(e, "2026-11-04");          // forgot to clock out; NO shift on 05 Nov
  const f = mkUser("f", "เอฟ");
  punch(f, "in", "2026-11-04", "11:00"); roster(f, "2026-11-04"); roster(f, "2026-11-05");   // has a shift 05 Nov → handled at clock-in
  const early = await M.sendMissingOutLetters({ today: "2026-11-05", hhmm: "12:55" });
  ok("before 13:00 nothing is sent", early.sent === 0 && early.checked === 0);
  const run1 = await M.sendMissingOutLetters({ today: "2026-11-05", hhmm: "13:00" });
  ok("at 13:00: the day-off person gets the letter; the rostered person is left for the clock-in gate", run1.sent === 1 && D.blockingMissingOutLetter(e)?.workDate === "2026-11-04" && D.blockingMissingOutLetter(f) === null);
  ok("ledger: detected by the afternoon run, letter marked sent", (() => { const r = db.prepare("SELECT detected_via v, letter_sent_at s FROM missing_out_lapses WHERE user_id=?").get(e) as { v: string; s: string | null }; return r.v === "afternoon" && r.s !== null; })());
  const run2 = await M.sendMissingOutLetters({ today: "2026-11-05", hhmm: "13:05" });
  ok("the next 5-minute tick does not send it again", run2.sent === 0);
  D.acknowledgeWarning(D.blockingMissingOutLetter(e)!.id, "pin_explicit");
  ok("acknowledged in the afternoon → the next working day's clock-in is open", M.missingOutClockInGate(e, br, "2026-11-07") === null);
  ok("an old lapse (beyond the 3-day window) is not sent by the afternoon run", (await M.sendMissingOutLetters({ today: "2026-11-20", hhmm: "14:00" })).sent === 0);

  // ── Statistics ──
  const st = M.missingOutStats(br, "2026-11-05", 6);
  ok("stats: counted lapses exclude the voided one (A, B, E, F? — F has not been flagged yet)", st.total === 3 && st.acknowledged === 3 && st.pending === 0);
  ok("stats: by origin (clock-in 1 · afternoon 1 · certification via B's reused letter stays clock-in)", st.viaClockIn === 2 && st.viaAfternoon === 1 && st.lettersSent === 1);
  ok("stats: blocked attempts and monthly bucket", st.blockedAttempts >= 3 && st.byMonth.length === 6 && st.byMonth[5].month === "2026-11" && st.byMonth[5].count === 3);
  ok("stats: per person list sorted, with the average hours to acknowledge", st.byPerson.length === 3 && st.avgHoursToAck !== null);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
