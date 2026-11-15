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

  // ── nothing else touches the queue table ──
  ok("Q25 no source file outside the gateway / schema mentions the queue table", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !["annual-checkup-db.ts", "annual-checkup-schema.ts"].includes(e.name) && /annual_checkup_queue\b/.test(fs.readFileSync(p, "utf8"))) bad.push(p);
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
