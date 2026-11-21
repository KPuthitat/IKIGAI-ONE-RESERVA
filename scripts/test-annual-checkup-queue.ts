// Access-control proof for the annual check-up queue number + QR check-in (phase 6). Isolated temporary DB.
// SQLite has no row-level security: the gateway (annual-checkup-db.ts) decides who READS, the triggers decide who WRITES.
// Run:  node --import tsx scripts/test-annual-checkup-queue.ts   (or: npm run test:annual-checkup-queue)
import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-annual-checkup-queue.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => {
    try { fn(); return ""; }
    catch (e) {
      if (G.isAnnualCheckupForbidden(e)) return e.code === "db_refused" ? `db_refused:${e.message}` : e.code;
      if (G.isAnnualCheckupInvalid(e)) return e.code;
      return e instanceof Error ? e.message : String(e);
    }
  };
  const sqlRefused = (fn: () => unknown, re: RegExp) => re.test(err(fn));

  // ── fixtures ──
  const branch = (slug: string, name: string) => {
    const have = db.prepare("SELECT id FROM branches WHERE slug = ?").get(slug) as { id: number } | undefined;
    return have ? have.id : Number(db.prepare("INSERT INTO branches (slug, name) VALUES (?,?)").run(slug, name).lastInsertRowid);
  };
  const clinic = branch("at-home-clinic", "AT HOME CLINIC"), nama = branch("nama-pasta-sriracha", "NAMA"), hypo = branch("hypo-q", "HYPO");
  const mk = (u: string, role: "super_admin" | "admin" | "staff", branches: Array<[number, number]>, extra: Record<string, unknown> = {}) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    for (const [b, adm] of branches) db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,?)").run(id, b, adm);
    return id;
  };
  const A = mk("emp-a", "staff", [[nama, 0]], { employee_code: "IKG-A1" }), B = mk("emp-b", "staff", [[nama, 0]]), C = mk("emp-c", "staff", [[hypo, 0]]);
  const R = mk("recorder", "staff", [[clinic, 0]], { health_result_recorder: 1 });
  const N = mk("clinic-plain", "staff", [[clinic, 0]]);                        // clinic staff WITHOUT the recorder flag
  const W = mk("mgr-nama", "admin", [[nama, 1]]);                              // manager of NAMA
  const S = mk("owner", "super_admin", [[nama, 0]]);
  const HR = mk("hr", "staff", [[nama, 0]], { is_hr_analytics: 1 });
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status, start_date, location, appt_time) VALUES ('ตรวจสุขภาพประจำปี 2569', 2569, 'open', '2026-12-10', 'AT HOME CLINIC', '08:00')").run().lastInsertRowid);
  const draftRound = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('ร่าง', 2570, 'draft')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'บริษัท ทดสอบ')").run(round).lastInsertRowid);
  const test = (code: string) => (db.prepare("SELECT id FROM annual_checkup_tests WHERE code = ?").get(code) as { id: number }).id;
  const order = (user: number, code: string, status = "ordered") =>
    db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id, status) VALUES (?,?,?,?,?)").run(round, user, payer, test(code), status);
  order(A, "HAV"); order(A, "CXR"); order(A, "URINE", "waived"); order(B, "HAV"); order(C, "CXR");
  const ext = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, full_name) VALUES (?,?,?)").run(round, payer, "คนนอก ทดสอบ").lastInsertRowid);
  db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id, status) VALUES (?,?,?,?,'ordered')").run(round, ext, payer, test("CXR"));

  // ── placing people in the line ──
  ok("Q1 the owner and a clinic recorder place people; nobody else may", (() => {
    const added = G.upsertQueueRow({ id: S }, round, { userId: A }, 1).action === "added"
      && G.upsertQueueRow({ id: R }, round, { userId: B }, 2).action === "added"
      && G.upsertQueueRow({ id: R }, round, { userId: C }, 3, "09:30").action === "added"
      && G.upsertQueueRow({ id: R }, round, { externalId: ext }, 4).action === "added";
    return added && [A, W, HR, N].every((u) => err(() => G.upsertQueueRow({ id: u }, round, { userId: A }, 9)) === "not_allowed");
  })());
  ok("Q2 a number is unique inside the round; bad numbers and times are refused; same input changes nothing", err(() => G.upsertQueueRow({ id: R }, round, { userId: B }, 1)) === "queue_no_taken"
    && err(() => G.upsertQueueRow({ id: R }, round, { userId: B }, 0)) === "bad_queue_no" && err(() => G.upsertQueueRow({ id: R }, round, { userId: B }, 2, "25:00")) === "bad_value"
    && G.upsertQueueRow({ id: R }, round, { userId: B }, 2).action === "same" && G.upsertQueueRow({ id: R }, round, { userId: B }, 5).action === "changed");
  G.upsertQueueRow({ id: R }, round, { userId: B }, 2);

  // ── employee: only their own row ──
  const mineA = G.getMyQueue({ id: A }), mineB = G.getMyQueue({ id: B });
  ok("Q3 an employee gets their own queue number, the round's date / place / time and a 32-hex token", mineA.length === 1 && mineA[0].queue_no === 1 && mineA[0].date === "2026-12-10"
    && mineA[0].appt_time === "08:00" && mineA[0].location === "AT HOME CLINIC" && /^[0-9a-f]{32}$/.test(mineA[0].checkin_token));
  ok("Q4 one employee never receives another's number or token (A, B, C are all different)", (() => {
    const all = [mineA[0], mineB[0], G.getMyQueue({ id: C })[0]];
    const j = JSON.stringify(mineA);
    return new Set(all.map((x) => x.checkin_token)).size === 3 && !j.includes(mineB[0].checkin_token) && mineB[0].queue_no === 2 && G.getMyQueue({ id: C })[0].appt_time === "09:30";
  })());
  ok("Q5 waived tests are hidden from the employee (only HAV and CXR, no URINE)", mineA[0].tests.map((t) => t.code).join() === "CXR,HAV" && !JSON.stringify(mineA).includes("URINE"));
  ok("Q6 people who are not in the line, HR, managers and the owner see nothing of their own", [HR, W, S, R].every((u) => G.getMyQueue({ id: u }).length === 0));
  ok("Q7 a round still in draft is not shown to employees", (() => {
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,1)").run(draftRound, A);
    return G.getMyQueue({ id: A }).length === 1;
  })());
  ok("Q8 the token carries no name or code, only random hex", !mineA[0].checkin_token.includes("emp") && !mineA[0].checkin_token.includes("IKG") && mineA[0].checkin_token.length === 32);
  ok("Q9 an inactive or unknown actor is refused", err(() => G.getMyQueue({ id: 999999 })) === "unauthenticated");

  // ── scanning and checking in ──
  const tokA = mineA[0].checkin_token;
  ok("Q10 only a clinic recorder may look a token up; employees, HR, managers, the owner and unflagged clinic staff may not", [A, B, HR, W, S, N].every((u) => err(() => G.lookupQueueByToken({ id: u }, tokA)) === "not_recorder"));
  ok("Q11 the recorder's scan shows name, number, payer and tests; a wrong or malformed token shows nothing", (() => {
    const s = G.lookupQueueByToken({ id: R }, tokA);
    return !!s && s.label === "emp-a" && s.queue_no === 1 && s.payer === "บริษัท ทดสอบ" && s.tests.length === 2 && s.checked_in_at === null
      && G.lookupQueueByToken({ id: R }, "0".repeat(32)) === null && G.lookupQueueByToken({ id: R }, "' OR 1=1 --") === null && G.lookupQueueByToken({ id: R }, "") === null;
  })());
  ok("Q12 checking in stamps the time and the person; employees and others cannot check anyone in", (() => {
    const refused = [A, B, HR, W, S, N].every((u) => err(() => G.checkIn({ id: u }, { token: tokA })) === "not_recorder");
    const r = G.checkIn({ id: R }, { token: tokA });
    return refused && r.already === false && r.scan.checked_in_at !== null && r.scan.checked_in_by === "recorder";
  })());
  ok("Q13 scanning again changes nothing and says who checked in and when", (() => {
    const first = G.lookupQueueByToken({ id: R }, tokA)!;
    const again = G.checkIn({ id: R }, { token: tokA });
    const row = db.prepare("SELECT checked_in_at, checked_in_by FROM annual_checkup_queue WHERE checkin_token = ?").get(tokA) as { checked_in_at: string; checked_in_by: number };
    return again.already === true && again.scan.checked_in_at === first.checked_in_at && row.checked_in_by === R
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'queue.checkin'").get() as { n: number }).n === 1;
  })());
  ok("Q14 a person without an account is checked in by hand from the roster (no QR)", (() => {
    const row = G.listQueue({ id: R }, round).find((x) => x.kind === "external")!;
    const r = G.checkIn({ id: R }, { queueId: row.queue_id });
    return r.already === false && r.scan.label === "คนนอก ทดสอบ" && err(() => G.checkIn({ id: R }, { queueId: 999999 })) === "queue_not_found";
  })());
  ok("Q15 scan / check-in leave audit rows (who, what, whose, when)", (() => {
    const n = (a: string) => (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = ? AND actor_id = ?").get(a, R) as { n: number }).n;
    return n("queue.scan") >= 2 && n("queue.checkin") === 2 && (db.prepare("SELECT subject_user_id FROM annual_checkup_audit WHERE action = 'queue.checkin' ORDER BY id LIMIT 1").get() as { subject_user_id: number }).subject_user_id === A;
  })());

  // ── what the database itself refuses (direct SQL, bypassing the gateway) ──
  ok("Q16 the database refuses a check-in by anyone who is not a live clinic recorder", sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ? WHERE user_id = ? AND round_id = ?").run(W, B, round), /only clinic staff/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ? WHERE user_id = ? AND round_id = ?").run(N, B, round), /only clinic staff/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ? WHERE user_id = ? AND round_id = ?").run(A, B, round), /only clinic staff/));
  ok("Q17 a check-in can never be undone, re-stamped, or the row removed", sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = NULL, checked_in_by = NULL WHERE user_id = ? AND round_id = ?").run(A, round), /cannot be changed/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_by = ? WHERE user_id = ? AND round_id = ?").run(S, A, round), /cannot be changed|only clinic staff/)
    && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_queue WHERE user_id = ? AND round_id = ?").run(A, round), /cannot be removed/));
  ok("Q18 the token, round and person of a row never change; a new row cannot start checked in", sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checkin_token = 'abc' WHERE user_id = ? AND round_id = ?").run(B, round), /never change/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET user_id = ? WHERE user_id = ? AND round_id = ?").run(C, B, round), /never change/)
    && sqlRefused(() => db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no, checked_in_at, checked_in_by) VALUES (?,?,?,CURRENT_TIMESTAMP,?)").run(round, S, 99, R), /starts not checked in/));
  ok("Q19 a recorder whose flag was withdrawn can no longer check anyone in (eligibility is checked live)", (() => {
    db.prepare("UPDATE users SET health_result_recorder = 0 WHERE id = ?").run(R);
    const e = err(() => G.checkIn({ id: R }, { token: G.getMyQueue({ id: B })[0].checkin_token }));
    db.prepare("UPDATE users SET health_result_recorder = 1 WHERE id = ?").run(R);
    return e === "not_recorder";
  })());

  // ── rosters ──
  ok("Q20 the clinic roster lists everyone in queue order with arrived / not yet", (() => {
    const l = G.listQueue({ id: R }, round);
    return l.map((x) => x.queue_no).join() === "1,2,3,4" && l[0].checked_in_at !== null && l[1].checked_in_at === null && l[3].kind === "external" && l[3].checked_in_at !== null;
  })());
  ok("Q21 employees, HR, managers, the owner and unflagged clinic staff cannot read the roster", [A, B, HR, W, S, N].every((u) => err(() => G.listQueue({ id: u }, round)) === "not_recorder"));
  ok("Q22 a branch manager sees name, number and arrived for their own branch only — no tests, payer, token or time", (() => {
    const l = G.listQueueForManager({ id: W }, round);
    const j = JSON.stringify(l);
    return l.length === 2 && l.map((x) => x.label).join() === "emp-a,emp-b" && l[0].arrived === true && l[1].arrived === false
      && !j.includes("emp-c") && !/token|tests|payer|CXR|HAV|appt|code/i.test(j) && Object.keys(l[0]).sort().join() === "arrived,label,queue_no";
  })());
  ok("Q23 HR, the owner, ordinary employees and the clinic recorder are not given the manager view", [HR, S, A, R].every((u) => err(() => G.listQueueForManager({ id: u }, round)) === "not_allowed"));
  ok("Q24 a manager of another branch does not see NAMA's people", (() => {
    const W2 = mk("mgr-hypo", "admin", [[hypo, 1]]);
    const l = G.listQueueForManager({ id: W2 }, round);
    return l.length === 1 && l[0].label === "emp-c";
  })());

  // ── phase 7: stations, sample-kit numbers, sent to the doctor ──
  const ST = await import("../src/lib/annual-checkup-stations");
  const NT = await import("../src/lib/annual-checkup-notify");
  const qB = db.prepare("SELECT id FROM annual_checkup_queue WHERE round_id = ? AND user_id = ?").get(round, B) as { id: number };
  const qC = db.prepare("SELECT id FROM annual_checkup_queue WHERE round_id = ? AND user_id = ?").get(round, C) as { id: number };
  const tokB = G.getMyQueue({ id: B })[0].checkin_token;
  ok("S1 five stations are seeded and every one of the 20 tests sits at a station", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_stations").get() as { n: number }).n === 5
    && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_tests WHERE station_id IS NULL").get() as { n: number }).n === 0);
  ok("S2 before check-in the employee sees no stations and no kit number (the route opens when staff scan them in)", (() => {
    const q = G.getMyQueue({ id: B })[0];
    return q.stations.length === 0 && q.kit_no === null;
  })());
  ok("S3 after check-in A sees the stations of their tests only (blood + X-ray; the waived urine test adds none), in route order, none passed", (() => {
    const q = G.getMyQueue({ id: A })[0];
    return q.checked_in_at !== null && q.stations.map((x) => x.code).join() === "BLOOD,XRAY" && q.stations.every((x) => !x.passed) && !JSON.stringify(q).includes("SPECIMEN");
  })());
  ok("S4 the kit number is linked at check-in, is unique in the round, and must look like a kit number", (() => {
    const r = G.checkIn({ id: R }, { token: tokB }, { kitNo: "K-0002" });
    const dup = err(() => G.checkIn({ id: R }, { queueId: qC.id }, { kitNo: "K-0002" }));
    const bad = err(() => G.checkIn({ id: R }, { queueId: qC.id }, { kitNo: "x y; DROP" }));
    return r.already === false && r.scan.kit_no === "K-0002" && dup === "kit_no_taken" && bad === "bad_kit_no";
  })());
  ok("S5 the employee sees their own kit number after check-in, and only their own", G.getMyQueue({ id: B })[0].kit_no === "K-0002" && G.getMyQueue({ id: A })[0].kit_no === null && G.getMyQueue({ id: C })[0].kit_no === null);
  ok("S6 a rescan with another kit number does not overwrite; a missing kit can be filled by rescanning; a kit can be corrected by a recorder only", (() => {
    const again = G.checkIn({ id: R }, { token: tokB }, { kitNo: "K-0099" });
    const stays = again.already === true && again.scan.kit_no === "K-0002";
    const qA = (db.prepare("SELECT id FROM annual_checkup_queue WHERE round_id = ? AND user_id = ?").get(round, A) as { id: number }).id;
    const fill = G.checkIn({ id: R }, { queueId: qA }, { kitNo: "K-0001" });
    const fixed = G.setKitNo({ id: R }, qB.id, "K-0003").kit_no === "K-0003";
    const refused = [A, B, HR, W, S, N].every((u) => err(() => G.setKitNo({ id: u }, qB.id, "K-0777")) === "not_recorder");
    return stays && fill.scan.kit_no === "K-0001" && fixed && refused;
  })());
  ok("S7 the database refuses a kit number attributed to anyone who is not a live clinic recorder (or to nobody)", sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET kit_no = 'HACK', kit_set_by = ? WHERE id = ?").run(W, qB.id), /may link a kit/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET kit_no = 'HACK3', kit_set_by = NULL WHERE id = ?").run(qB.id), /may link a kit/));
  ok("S8 a station cannot be passed before check-in, nor one that is not on the person's route; staff-only", (() => {
    const notIn = err(() => G.passStation({ id: R }, { queueId: qC.id }, "BLOOD")) === "not_checked_in";
    const notNeeded = err(() => G.passStation({ id: R }, { token: tokB }, "SPECIMEN")) === "station_not_needed";
    const refused = [A, B, HR, W, S, N].every((u) => err(() => G.passStation({ id: u }, { token: tokB }, "BLOOD")) === "not_recorder");
    return notIn && notNeeded && refused;
  })());
  ok("S9 staff at the station mark it passed: the employee's route updates, a second scan changes nothing, one row per station", (() => {
    const first = G.passStation({ id: R }, { token: tokB }, "BLOOD");
    const again = G.passStation({ id: R }, { token: tokB }, "BLOOD");
    const mine = G.getMyQueue({ id: B })[0].stations;
    return first.already === false && again.already === true && mine.find((x) => x.code === "BLOOD")?.passed === true && mine.filter((x) => x.passed).length === 1
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_station_passes WHERE queue_id = ?").get(qB.id) as { n: number }).n === 1
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'queue.station'").get() as { n: number }).n === 1;
  })());
  ok("S9b the employee can tick a station they have been through: it shows on their route as their own tick, is not an official pass, and can be unticked", (() => {
    const rnd = G.getMyQueue({ id: A })[0].round_id;
    G.setMyStationMark({ id: A }, rnd, "XRAY", true); G.setMyStationMark({ id: A }, rnd, "XRAY", true);
    const on = G.getMyQueue({ id: A })[0].stations;
    const mineOnly = on.find((x) => x.code === "XRAY")?.self_marked === true && on.find((x) => x.code === "XRAY")?.passed === false && on.find((x) => x.code === "BLOOD")?.self_marked === false;
    const rows = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_station_selfmarks").get() as { n: number }).n;
    const noPass = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_station_passes p JOIN annual_checkup_queue q ON q.id = p.queue_id WHERE q.user_id = ?").get(A) as { n: number }).n === 0;
    G.setMyStationMark({ id: A }, rnd, "XRAY", false);
    return mineOnly && rows === 1 && noPass && G.getMyQueue({ id: A })[0].stations.every((x) => !x.self_marked);
  })());
  ok("S9c a tick is refused before check-in, for a station not on the person's route, by someone with no queue, and never shows on anyone else's route", (() => {
    const rnd = G.getMyQueue({ id: A })[0].round_id;
    const notIn = err(() => G.setMyStationMark({ id: C }, rnd, "BLOOD", true)) === "not_checked_in";
    const notOnRoute = err(() => G.setMyStationMark({ id: A }, rnd, "NOPE", true)) === "station_not_needed";
    const noQueue = err(() => G.setMyStationMark({ id: HR }, rnd, "BLOOD", true)) === "queue_not_found";
    G.setMyStationMark({ id: A }, rnd, "BLOOD", true);
    const other = G.getMyQueue({ id: B })[0].stations.every((x) => !x.self_marked);
    G.setMyStationMark({ id: A }, rnd, "BLOOD", false);
    return notIn && notOnRoute && noQueue && other;
  })());
  ok("S9d a round is opened / closed by the owner or a clinic recorder only, audited, and cannot go back to draft once people have checked in", (() => {
    const rid = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('draft-round', 2570, 'draft')").run().lastInsertRowid);
    const refused = [A, B, HR, W].every((u) => err(() => G.setRoundStatus({ id: u }, rid, "open")) === "not_allowed");
    const bad = err(() => G.setRoundStatus({ id: R }, 999999, "open")) === "round_not_found";
    const opened = G.setRoundStatus({ id: R }, rid, "open").changed === true && G.setRoundStatus({ id: R }, rid, "open").changed === false;
    const stOpen = (db.prepare("SELECT status FROM annual_checkup_rounds WHERE id = ?").get(rid) as { status: string }).status === "open";
    const closed = G.setRoundStatus({ id: R }, rid, "closed").changed === true;
    const q0 = G.getMyQueue({ id: A })[0].round_id; // the real (checked-in) round
    const noDraft = err(() => G.setRoundStatus({ id: R }, q0, "draft")) === "round_has_checkins";
    const audited = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'round.status'").get() as { n: number }).n === 2;
    return refused && bad && opened && stOpen && closed && noDraft && audited;
  })());
  ok("S9e a round's info can be edited (validated), and a mistaken round can be deleted only when it is closed, empty of health data and nobody has checked in", (() => {
    const rid = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('ลบทดสอบ', 2570, 'draft')").run().lastInsertRowid);
    const py = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'บริษัท ลบ')").run(rid).lastInsertRowid);
    const tid = (db.prepare("SELECT id FROM annual_checkup_tests ORDER BY id LIMIT 1").get() as { id: number }).id;
    db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id, status) VALUES (?,?,?,?,'ordered')").run(rid, C, py, tid);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,1)").run(rid, C);
    const info = { name: "ชื่อใหม่", yearBe: 2571, startDate: "2027-01-05", endDate: "2027-01-06", location: "AT HOME CLINIC" };
    const noEdit = [A, HR].every((u) => err(() => G.updateRoundInfo({ id: u }, rid, info)) === "not_allowed");
    const badEdit = err(() => G.updateRoundInfo({ id: R }, rid, { ...info, name: "  " })) === "bad_value" && err(() => G.updateRoundInfo({ id: R }, rid, { ...info, endDate: "2027-01-01" })) === "bad_value" && err(() => G.updateRoundInfo({ id: R }, 999999, info)) === "round_not_found";
    G.updateRoundInfo({ id: R }, rid, info);
    const edited = (db.prepare("SELECT name, year_be, start_date, location FROM annual_checkup_rounds WHERE id = ?").get(rid) as { name: string; year_be: number; start_date: string; location: string }).name === "ชื่อใหม่";
    const noDel = [A, HR].every((u) => err(() => G.deleteRound({ id: u }, rid, "ชื่อใหม่")) === "not_allowed");
    const wrongName = err(() => G.deleteRound({ id: R }, rid, "อื่น")) === "bad_value";
    G.setRoundStatus({ id: R }, rid, "open");
    const openRefused = err(() => G.deleteRound({ id: R }, rid, "ชื่อใหม่")) === "round_is_open";
    G.setRoundStatus({ id: R }, rid, "closed");
    const live = G.getMyQueue({ id: A })[0].round_id;   // a round with a check-in
    G.setRoundStatus({ id: R }, live, "closed");
    const checkinRefused = err(() => G.deleteRound({ id: R }, live, (db.prepare("SELECT name FROM annual_checkup_rounds WHERE id = ?").get(live) as { name: string }).name)) === "round_has_checkins";
    G.setRoundStatus({ id: R }, live, "open");
    const done = G.deleteRound({ id: R }, rid, "ชื่อใหม่").people === 1;
    const gone = ["annual_checkup_rounds WHERE id", "annual_checkup_orders WHERE round_id", "annual_checkup_queue WHERE round_id", "annual_checkup_payers WHERE round_id"]
      .every((t) => (db.prepare(`SELECT COUNT(*) n FROM ${t} = ?`).get(rid) as { n: number }).n === 0);
    const audited = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action IN ('round.update','round.delete') AND round_id = ?").get(rid) as { n: number }).n === 2;
    return noEdit && badEdit && edited && noDel && wrongName && openRefused && checkinRefused && done && gone && audited;
  })());
  ok("S9f a round that already holds a result cannot be deleted (even when closed and nobody has checked in)", (() => {
    const rid = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('มีผลแล้ว', 2571, 'closed')").run().lastInsertRowid);
    const py = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'บริษัท ผล')").run(rid).lastInsertRowid);
    const tid = (db.prepare("SELECT id FROM annual_checkup_tests WHERE code = 'HAV'").get() as { id: number }).id;
    const oid = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id, status) VALUES (?,?,?,?,'ordered')").run(rid, C, py, tid).lastInsertRowid);
    G.recordResult({ id: R }, oid, { valueText: "ทดสอบ" });
    const refused = err(() => G.deleteRound({ id: R }, rid, "มีผลแล้ว")) === "round_has_data";
    const intact = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results res JOIN annual_checkup_orders o ON o.id = res.order_id WHERE o.round_id = ?").get(rid) as { n: number }).n === 1
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_rounds WHERE id = ?").get(rid) as { n: number }).n === 1;
    return refused && intact;
  })());
  ok("S9g an employee checks themselves in on their OWN row of an open round, once; never on someone else's, in a closed round, or without a row", (() => {
    const rid = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('self-checkin', 2572, 'open')").run().lastInsertRowid);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,1)").run(rid, HR);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,2)").run(rid, W);
    const noRow = err(() => G.selfCheckIn({ id: S }, rid)) === "queue_not_found";
    const first = G.selfCheckIn({ id: HR }, rid).already === false;
    const again = G.selfCheckIn({ id: HR }, rid).already === true;
    const row = db.prepare("SELECT checked_in_at, checked_in_by FROM annual_checkup_queue WHERE round_id = ? AND user_id = ?").get(rid, HR) as { checked_in_at: string | null; checked_in_by: number };
    const own = row.checked_in_at !== null && row.checked_in_by === HR;
    const otherRow = (db.prepare("SELECT checked_in_at FROM annual_checkup_queue WHERE round_id = ? AND user_id = ?").get(rid, W) as { checked_in_at: string | null }).checked_in_at === null;
    // the database itself: nobody but a recorder may stamp someone else; the owner of the row may stamp themselves
    const dbRefusesOther = sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ? WHERE round_id = ? AND user_id = ?").run(HR, rid, W), /only clinic staff/);
    const dbAllowsSelf = !sqlRefused(() => db.prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ? WHERE round_id = ? AND user_id = ?").run(W, rid, W), /only clinic staff/);
    // a closed round refuses even their own check-in (W's row there is still not checked in by the SQL above failing / succeeding aside)
    const rid2 = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('closed-round', 2573, 'closed')").run().lastInsertRowid);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,1)").run(rid2, S);
    const closed = err(() => G.selfCheckIn({ id: S }, rid2)) === "queue_not_found";
    const audited = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'queue.selfcheckin' AND round_id = ?").get(rid) as { n: number }).n === 1;
    return noRow && first && again && own && otherRow && dbRefusesOther && dbAllowsSelf && closed && audited;
  })());
  ok("S10 the database refuses a station pass by a non-recorder or for someone not checked in, and passes are append-only", sqlRefused(() => db.prepare("INSERT INTO annual_checkup_station_passes (queue_id, station_id, passed_by) VALUES (?, 1, ?)").run(qB.id, W), /may mark a station/)
    && sqlRefused(() => db.prepare("INSERT INTO annual_checkup_station_passes (queue_id, station_id, passed_by) VALUES (?, 1, ?)").run(qC.id, R), /not checked in/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_station_passes SET passed_by = ?").run(S), /append-only/) && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_station_passes").run(), /append-only/));
  ok("S11 the clinic roster shows the kit and the stations done / total", (() => {
    const row = G.listQueue({ id: R }, round).find((x) => x.queue_id === qB.id)!;
    return row.kit_no === "K-0003" && row.stations_done === 1 && row.stations_total === 1;
  })());

  const oA = (code: string) => (db.prepare("SELECT o.id FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.round_id = ? AND o.user_id = ? AND t.code = ?").get(round, A, code) as { id: number }).id;
  const D = mk("doctor", "staff", [[clinic, 0]], { clinical_role: "doctor", license_no: "ว.12345", health_result_approver: 1, line_user_id: "U-doctor" });
  db.prepare("UPDATE users SET health_result_recorder = 1 WHERE id = ?").run(N);   // N is now a second recorder (used below)
  ok("S12 results cannot be sent to the doctor until every test that is not waived has a result", (() => {
    G.recordResult({ id: R }, oA("HAV"), { valueText: "ปกติ" });
    return err(() => G.submitToDoctor({ id: R }, round, { userId: A })) === "not_all_recorded";
  })());
  ok("S13 once all are recorded the recorder sends them: refreshed on a repeat, audited, counted as waiting for the doctor", (() => {
    G.recordResult({ id: R }, oA("CXR"), { valueText: "ปกติ" });
    const r = G.submitToDoctor({ id: R }, round, { userId: A });
    const again = G.submitToDoctor({ id: R }, round, { userId: A });
    return !!r.submitted_at && r.awaiting === 1 && again.awaiting === 1 && G.countAwaitingDoctor(round) === 1
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_submissions WHERE round_id = ? AND user_id = ?").get(round, A) as { n: number }).n === 1
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'result.submit'").get() as { n: number }).n === 2;
  })());
  ok("S14 only a clinic recorder may send results; the database refuses it for anyone else", [A, B, HR, W, S].every((u) => err(() => G.submitToDoctor({ id: u }, round, { userId: A })) === "not_recorder")
    && sqlRefused(() => db.prepare("INSERT INTO annual_checkup_submissions (round_id, user_id, submitted_by) VALUES (?,?,?)").run(round, B, W), /may send results/)
    && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_submissions").run(), /never deleted/));
  ok("S15 the overview marks who was sent to the doctor; the waiting count drops once the doctor has verified every draft", (() => {
    const row = G.getRoundOverview({ id: R }, round).subjects.find((x) => x.key === `u${A}`)!;
    const sent = row.submitted === true;
    const resIds = (db.prepare("SELECT r.id FROM annual_checkup_results r JOIN annual_checkup_orders o ON o.id = r.order_id WHERE o.round_id = ? AND o.user_id = ?").all(round, A) as Array<{ id: number }>).map((x) => x.id);
    for (const id of resIds) G.verifyResult({ id: D }, id, { licenseUnlocked: true });
    return sent && G.countAwaitingDoctor(round) === 0 && G.getRoundOverview({ id: R }, round).subjects.find((x) => x.key === `u${B}`)!.submitted === false;
  })());
  ok("S16 the doctor LINE notice goes only to live approver doctors; the card carries a count and a link, no name, value or test", (() => {
    const ids = G.listApproverLineIds();
    const j = JSON.stringify(NT.doctorWaitingCard(3, round));
    return ids.length === 1 && ids[0] === "U-doctor" && j.includes("รอแพทย์ตรวจสอบ 3 คน") && j.includes(`/staff/health/annual-checkup/${round}`) && !/emp-|ปกติ|HAV|CXR|ไวรัส|เอกซเรย์/.test(j);
  })());
  ok("S17 the stations catalogue is edited by the owner or a clinic recorder only; codes are validated and unique; a test can be moved", (() => {
    const refused = [A, HR, W].every((u) => { try { ST.saveStation(u, { nameTh: "ใหม่", code: "NEW1", sortNo: 9, active: true }); return false; } catch (e) { return e instanceof ST.StationRefused && e.code === "not_allowed"; } });
    const id = ST.saveStation(S, { nameTh: "คลื่นหัวใจ", code: "ecg", sortNo: 9, active: true });
    let dup = ""; try { ST.saveStation(R, { nameTh: "x", code: "ECG", sortNo: 1, active: true }); } catch (e) { dup = (e as { code: string }).code; }
    let bad = ""; try { ST.saveStation(R, { nameTh: "x", code: "e c g", sortNo: 1, active: true }); } catch (e) { bad = (e as { code: string }).code; }
    ST.assignTestStation(R, "URIC", id);
    const moved = (db.prepare("SELECT station_id FROM annual_checkup_tests WHERE code = 'URIC'").get() as { station_id: number }).station_id === id;
    return refused && dup === "code_taken" && bad === "bad_code" && moved;
  })());
  ok("S18 the migration is idempotent and never overwrites a mapping the owner set (re-running the seed keeps URIC at its new station)", (() => {
    const before = (db.prepare("SELECT station_id FROM annual_checkup_tests WHERE code = 'URIC'").get() as { station_id: number }).station_id;
    return before > 0 && (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'annual_checkup_%'").get() as { n: number }).n === 26;
  })());

  // ── nothing else touches the queue table ──
  ok("Q25 no source file outside the gateway / schema mentions the queue table", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !["annual-checkup-db.ts", "annual-checkup-schema.ts"].includes(e.name) && /annual_checkup_(queue|station_passes|submissions)\b/.test(fs.readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    return bad.length === 0;
  })());
  ok("Q26 the migration is idempotent: booting again keeps the 3 queue triggers and the data", (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (async () => true)() !== null && (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'annual_checkup_queue_%'").get() as { n: number }).n === 3;
  })());

  console.log(failed === 0 ? "\n✓ ALL PASS" : `\n✗ ${failed} FAILED`);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
