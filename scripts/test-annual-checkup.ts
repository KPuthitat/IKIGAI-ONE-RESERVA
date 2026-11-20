// Access-control proof for the annual health check-up programme (phase 2, docs/annual-checkup-plan.md §10).
//
// SQLite has no row-level security. This script proves the two layers that stand in for it, against an isolated temporary DB:
//   • the gateway (src/lib/annual-checkup-db.ts) — who may READ and who may call each write
//   • the triggers in annual-checkup-schema.ts — what the DATABASE itself refuses for writes, even when SQL is run directly
//
// Run:  node --import tsx scripts/test-annual-checkup.ts   (or: npm run test:annual-checkup)
import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-annual-checkup.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { ensureAnnualCheckupSchema } = await import("../src/lib/annual-checkup-schema");
  const G = await import("../src/lib/annual-checkup-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  /** error code (gateway) or the trigger message (direct SQL), "" when nothing was thrown */
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
  const company = (n: string) => Number(db.prepare("INSERT INTO companies (name_th) VALUES (?)").run(n).lastInsertRowid);
  const coClinic = company("บริษัท อิคิไก เมดิเฮลท์ จำกัด"), coWell = company("บริษัท อิคิไก เวลล์เทรด จำกัด");
  // a fresh DB already seeds the clinic and OMNIA branches (by slug) — reuse them and point them at our companies
  const branch = (slug: string, name: string, co: number) => {
    const have = db.prepare("SELECT id FROM branches WHERE slug = ?").get(slug) as { id: number } | undefined;
    if (have) { db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id); return have.id; }
    return Number(db.prepare("INSERT INTO branches (slug, name, company_id) VALUES (?,?,?)").run(slug, name, co).lastInsertRowid);
  };
  const clinic = branch("at-home-clinic", "AT HOME CLINIC", coClinic);
  const nama = branch("nama-pasta-sriracha", "NAMA PASTA SRIRACHA", coWell);
  const omnia = branch("omnia-health-lab", "OMNIA HEALTH LABORATORY", coClinic);
  const mkUser = (u: string, role: "super_admin" | "admin" | "staff", branches: number[], extra: Record<string, unknown> = {}) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    for (const b of branches) db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,?)").run(id, b, role === "admin" ? 1 : 0);
    return id;
  };
  const A = mkUser("emp-a", "staff", [nama]), B = mkUser("emp-b", "staff", [nama]);
  const R = mkUser("recorder", "staff", [clinic]);                                       // clinic staff, will be granted recorder
  const N = mkUser("nurse", "staff", [clinic], { clinical_role: "nurse" });              // clinic nurse: may record, never approve
  const D = mkUser("doctor", "staff", [clinic], { clinical_role: "doctor", license_no: "ว.12345" });
  const W = mkUser("admin-nama", "admin", [nama]);                                       // well-trade branch admin
  const O = mkUser("admin-omnia", "admin", [omnia]);                                     // OMNIA admin (same company as the clinic, other branch)
  const S = mkUser("owner", "super_admin", [nama, omnia]);                               // super_admin, NOT on the clinic roster
  const HR = mkUser("hr", "staff", [nama], { is_hr_analytics: 1 });
  const M = mkUser("manager", "admin", [nama]);

  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('ตรวจสุขภาพประจำปี 2569', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, company_id, name_th) VALUES (?,?,?)").run(round, coWell, "บริษัท อิคิไก เวลล์เทรด จำกัด").lastInsertRowid);
  const test = (code: string) => (db.prepare("SELECT id FROM annual_checkup_tests WHERE code = ?").get(code) as { id: number }).id;
  const order = (user: number, code: string, status = "ordered") =>
    Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id, status) VALUES (?,?,?,?,?)").run(round, user, payer, test(code), status).lastInsertRowid);
  const oHav = order(A, "HAV"), oCxr = order(A, "CXR"), oUrine = order(A, "URINE", "waived"), oStool = order(A, "STOOL", "external_lab");
  const bHav = order(B, "HAV");
  const ext = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, full_name) VALUES (?,?,?)").run(round, payer, "คนนอก ทดสอบ").lastInsertRowid);
  const oExt = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id, status) VALUES (?,?,?,?,'ordered')").run(round, ext, payer, test("CXR")).lastInsertRowid);

  const rawInsertResult = (orderId: number, by: number) =>
    db.prepare("INSERT INTO annual_checkup_results (order_id, value_text, recorded_by) VALUES (?, 'x', ?)").run(orderId, by);

  // ── catalogue + migration ──
  ok("catalogue seeded with the 20 tests of the programme", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_tests").get() as { n: number }).n === 20);
  ok("migration is idempotent (run again: still 20 tests, 26 triggers, no error)", (() => {
    ensureAnnualCheckupSchema(db); ensureAnnualCheckupSchema(db);
    return (db.prepare("SELECT COUNT(*) n FROM annual_checkup_tests").get() as { n: number }).n === 20
      && (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'annual_checkup%'").get() as { n: number }).n === 26;
  })());
  ok("orders have no medical / reason column (HR-readable by design)", !(db.prepare("PRAGMA table_info(annual_checkup_orders)").all() as Array<{ name: string }>).some((c) => /reason|waive|clinical/i.test(c.name)));
  ok("the same person cannot be ordered the same test twice in a round (also for people without an account)", err(() => order(A, "HAV")) !== "" && err(() => db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id) VALUES (?,?,?,?)").run(round, ext, payer, test("CXR"))) !== "");

  // ── 1. grants: only a super_admin, only to clinic staff ──
  ok("1a an admin who is not super_admin cannot grant", err(() => G.grantCapability({ id: W }, R, "recorder", "x")) === "super_admin_only");
  ok("1b a grant needs a reason", err(() => G.grantCapability({ id: S }, R, "recorder", "  ")) === "reason_required");
  ok("1c super_admin cannot grant it to a well-trade branch admin (not clinic staff) — refused by the database", /db_refused:.*only clinic staff/.test(err(() => G.grantCapability({ id: S }, W, "recorder", "ลองให้"))));
  ok("1d …nor to the OMNIA admin (same company as the clinic, other branch)", /db_refused/.test(err(() => G.grantCapability({ id: S }, O, "recorder", "ลองให้"))));
  G.grantCapability({ id: S }, R, "recorder", "เจ้าหน้าที่ลงผลของคลินิก");
  ok("1e super_admin grants recorder to clinic staff: flag set, grant row written", (db.prepare("SELECT health_result_recorder f FROM users WHERE id = ?").get(R) as { f: number }).f === 1
    && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_grants WHERE user_id = ? AND capability='recorder' AND action='grant' AND by_user_id = ?").get(R, S) as { n: number }).n === 1);
  ok("1f the approver must be a doctor with a licence number (R is not a doctor)", /db_refused:.*doctor/.test(err(() => G.grantCapability({ id: S }, R, "approver", "ลองให้"))));
  G.grantCapability({ id: S }, D, "approver", "แพทย์ผู้อนุมัติผล");
  G.grantCapability({ id: S }, N, "recorder", "พยาบาลลงผล");
  ok("1g the doctor is an approver and, through that, also a recorder", G.isApproverEligible(D) && G.isRecorderEligible(D) && G.isRecorderEligible(R) && !G.isApproverEligible(R) && !G.isApproverEligible(N));
  ok("1h grants are listed for super_admin only", G.listGrants({ id: S }).length >= 3 && err(() => G.listGrants({ id: W })) === "super_admin_only");
  ok("1i a flag set by hand on a well-trade admin / the OMNIA admin / the owner changes nothing: not eligible", (() => {
    db.prepare("UPDATE users SET health_result_recorder = 1, health_result_approver = 1 WHERE id IN (?,?,?)").run(W, O, S);
    return !G.isRecorderEligible(W) && !G.isRecorderEligible(O) && !G.isRecorderEligible(S) && !G.isApproverEligible(S);
  })());

  // ── 2. writing results: gateway AND database ──
  for (const [who, name] of [[W, "well-trade admin"], [O, "OMNIA admin"], [S, "super_admin off the clinic roster"], [HR, "HR"], [M, "manager"], [A, "the employee"]] as const) {
    ok(`2a ${name} cannot record a result (gateway)`, err(() => G.recordResult({ id: who }, oHav, { valueText: "x" })) === "not_recorder");
  }
  ok("2b …and a direct INSERT naming the well-trade admin / OMNIA admin / owner as recorder is refused by the database", [W, O, S].every((u) => sqlRefused(() => rawInsertResult(oHav, u), /recorder not eligible/)));
  ok("2c a direct INSERT naming someone with no flag at all is refused too", sqlRefused(() => rawInsertResult(oHav, HR), /recorder not eligible/));
  ok("2d invalid values are refused", err(() => G.recordResult({ id: R }, oHav, { interpretation: "bad" as never })) === "bad_interpretation");
  const resHav = G.recordResult({ id: R }, oHav, { valueText: "ไม่พบภูมิ", interpretation: "abnormal" });
  ok("2e the recorder records a draft", (db.prepare("SELECT status, revision, recorded_by FROM annual_checkup_results WHERE id = ?").get(resHav) as { status: string; revision: number; recorded_by: number }).status === "draft");
  ok("2f a draft can be overwritten by the recorder", G.recordResult({ id: R }, oHav, { valueText: "ไม่พบภูมิคุ้มกัน", interpretation: "follow_up" }) === resHav);
  ok("2g a waived test cannot have a result (gateway and database)", err(() => G.recordResult({ id: R }, oUrine, { valueText: "x" })) === "order_waived" && sqlRefused(() => rawInsertResult(oUrine, R), /waived test cannot have a result/));
  ok("2h an external-lab test needs the lab's file", err(() => G.recordResult({ id: R }, oStool, { valueText: "ไม่พบเชื้อ" })) === "external_lab_needs_file");
  const resStool = G.recordResult({ id: N }, oStool, { valueText: "ไม่พบเชื้อ", filePath: "data/health/annual-checkup/lab-001.pdf", fileMime: "application/pdf" });
  ok("2i …and the nurse (recorder flag, clinic) can record it with the file", resStool > 0);
  const resCxr = G.recordResult({ id: R }, oCxr, { valueText: "ปกติ", interpretation: "normal" });
  ok("2j a clinic recorder moved off the clinic roster stops at once (checked live, not at grant time)", (() => {
    db.prepare("DELETE FROM user_branches WHERE user_id = ? AND branch_id = ?").run(R, clinic);
    const refused = err(() => G.recordResult({ id: R }, oCxr, { valueText: "แก้" })) === "not_recorder" && sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET value_text='แก้', recorded_by = ? WHERE id = ?").run(R, resCxr), /recorder not eligible/);
    db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,0)").run(R, clinic);
    return refused && G.isRecorderEligible(R);
  })());
  ok("2k a resigned recorder is not eligible", (() => {
    db.prepare("UPDATE users SET status = 'resigned' WHERE id = ?").run(N);
    const r = !G.isRecorderEligible(N) && err(() => G.recordResult({ id: N }, oCxr, { valueText: "x" })) === "unauthenticated";
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(N);
    return r;
  })());
  ok("2l the optional company lock: clinic branch must belong to the configured company", (() => {
    db.prepare("UPDATE system_settings SET annual_checkup_clinic_company_id = ? WHERE id = 1").run(coWell);
    const locked = !G.isRecorderEligible(R) && sqlRefused(() => rawInsertResult(oCxr, R), /./) ;
    db.prepare("UPDATE system_settings SET annual_checkup_clinic_company_id = ? WHERE id = 1").run(coClinic);
    const right = G.isRecorderEligible(R);
    db.prepare("UPDATE system_settings SET annual_checkup_clinic_company_id = NULL WHERE id = 1").run();
    return locked && right && G.isRecorderEligible(R);
  })());

  // ── 3. approving: doctor + licence unlock; the lock; revisions ──
  ok("3a a recorder (not a doctor) cannot verify (gateway) nor by direct SQL", err(() => G.verifyResult({ id: R }, resHav, { licenseUnlocked: true })) === "not_approver"
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET status='verified', verified_by=?, verified_at=CURRENT_TIMESTAMP WHERE id=?").run(R, resHav), /status change not allowed/));
  ok("3b the doctor without the session licence unlock cannot verify", err(() => G.verifyResult({ id: D }, resHav, { licenseUnlocked: false })) === "license_not_unlocked");
  ok("3c the licence check compares digits only; wrong number / non-doctor refused", G.verifyApproverLicense({ id: D }, "ว. 12345") && G.verifyApproverLicense({ id: D }, "12345") && !G.verifyApproverLicense({ id: D }, "99999") && !G.verifyApproverLicense({ id: R }, "12345"));
  ok("3d a draft cannot skip straight to released (database)", sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET status='released', released_by=?, released_at=CURRENT_TIMESTAMP WHERE id=?").run(D, resHav), /status change not allowed/));
  G.verifyResult({ id: D }, resHav, { licenseUnlocked: true });
  ok("3e the doctor verifies a draft", (db.prepare("SELECT status, verified_by FROM annual_checkup_results WHERE id = ?").get(resHav) as { status: string; verified_by: number }).verified_by === D);
  ok("3f a verified result is locked: recorder refused, direct edit refused", err(() => G.recordResult({ id: R }, oHav, { valueText: "แก้" })) === "result_locked"
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET value_text='แก้ไขตรง ๆ' WHERE id=?").run(resHav), /result is locked/));
  ok("3g…even by the doctor, directly", sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET value_text='แก้ไขตรง ๆ', recorded_by=? WHERE id=?").run(D, resHav), /result is locked/));
  ok("3h a revision needs the approver, the licence unlock and a reason", err(() => G.reviseResult({ id: R }, resHav, { valueText: "ใหม่" }, "เหตุผล", { licenseUnlocked: true })) === "not_approver"
    && err(() => G.reviseResult({ id: D }, resHav, { valueText: "ใหม่" }, "เหตุผล", { licenseUnlocked: false })) === "license_not_unlocked"
    && err(() => G.reviseResult({ id: D }, resHav, { valueText: "ใหม่" }, " ", { licenseUnlocked: true })) === "reason_required");
  G.reviseResult({ id: D }, resHav, { valueText: "พบภูมิคุ้มกันแล้ว", interpretation: "normal" }, "แล็บแก้ผล", { licenseUnlocked: true });
  ok("3i a revision snapshots the old version, bumps the revision and returns to draft", (() => {
    const r = db.prepare("SELECT status, revision, value_text, verified_by FROM annual_checkup_results WHERE id = ?").get(resHav) as { status: string; revision: number; value_text: string; verified_by: number | null };
    const rev = db.prepare("SELECT revision, snapshot_json FROM annual_checkup_result_revisions WHERE result_id = ?").all(resHav) as Array<{ revision: number; snapshot_json: string }>;
    return r.status === "draft" && r.revision === 2 && r.value_text === "พบภูมิคุ้มกันแล้ว" && r.verified_by === null && rev.length === 1 && rev[0].revision === 1 && JSON.parse(rev[0].snapshot_json).value_text === "ไม่พบภูมิคุ้มกัน";
  })());
  ok("3j revisions and audit are append-only (UPDATE / DELETE refused)", sqlRefused(() => db.prepare("UPDATE annual_checkup_result_revisions SET reason='x'").run(), /append-only/)
    && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_result_revisions").run(), /append-only/)
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_audit SET action='x'").run(), /append-only/)
    && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_audit").run(), /append-only/));
  ok("3k a revision cannot be faked without a snapshot (database)", sqlRefused(() => {
    G.verifyResult({ id: D }, resHav, { licenseUnlocked: true });
    db.prepare("UPDATE annual_checkup_results SET revision = revision + 1, status = 'draft', value_text = 'ปลอม', recorded_by = ? WHERE id = ?").run(D, resHav);
  }, /result is locked/));
  ok("3l results are never deleted", sqlRefused(() => db.prepare("DELETE FROM annual_checkup_results WHERE id = ?").run(resHav), /never deleted/));
  ok("3m a test that has a result cannot be waived or removed afterwards", sqlRefused(() => db.prepare("UPDATE annual_checkup_orders SET status='waived' WHERE id = ?").run(oHav), /cannot be waived/) && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_orders WHERE id = ?").run(oHav), /cannot be removed/));

  // ── 4. waive reasons are clinical-only ──
  G.setOrderClinical({ id: R }, oUrine, { waiveReason: "งดตามคำสั่งแพทย์ (ตั้งครรภ์)" });
  G.setOrderClinical({ id: R }, oStool, { externalLabName: "แล็บภายนอก ก." });
  ok("4a the recorder can store and read the waive reason", G.getOrderClinical({ id: R }, oUrine)?.waive_reason === "งดตามคำสั่งแพทย์ (ตั้งครรภ์)");
  ok("4b HR / manager / admin / super_admin / the employee cannot read it or write it", [HR, M, W, S, A].every((u) => err(() => G.getOrderClinical({ id: u }, oUrine)) === "not_recorder" && err(() => G.setOrderClinical({ id: u }, oUrine, { waiveReason: "x" })) === "not_recorder"));
  ok("4c the database also refuses a waive reason set by a non-clinic admin", sqlRefused(() => db.prepare("INSERT OR REPLACE INTO annual_checkup_order_clinical (order_id, waive_reason, set_by) VALUES (?,?,?)").run(oCxr, "x", W), /recorder not eligible/));

  // ── 5. conclusion + release ──
  ok("5a only the approver doctor writes the conclusion", err(() => G.saveConclusion({ id: R }, round, { userId: A }, { summary: "normal" }, { licenseUnlocked: true })) === "not_approver"
    && sqlRefused(() => db.prepare("INSERT INTO annual_checkup_conclusions (round_id, user_id, summary, verified_by) VALUES (?,?,?,?)").run(round, A, "normal", R), /approver doctor/));
  ok("5b release needs the conclusion", err(() => G.releaseSubject({ id: D }, round, { userId: A }, { licenseUnlocked: true })) === "no_conclusion");
  G.saveConclusion({ id: D }, round, { userId: A }, { summary: "follow_up", doctorComment: "ติดตามภูมิคุ้มกันตับอักเสบเอ" }, { licenseUnlocked: true });
  ok("5c release is refused while any required test is not verified", err(() => G.releaseSubject({ id: D }, round, { userId: A }, { licenseUnlocked: true })) === "not_all_verified");
  G.verifyResult({ id: D }, resCxr, { licenseUnlocked: true });
  G.verifyResult({ id: D }, resStool, { licenseUnlocked: true });
  ok("5d a recorder cannot release (gateway and database)", err(() => G.releaseSubject({ id: R }, round, { userId: A }, { licenseUnlocked: true })) === "not_approver"
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_results SET status='released', released_by=?, released_at=CURRENT_TIMESTAMP WHERE id=?").run(R, resCxr), /status change not allowed/));
  ok("5e the employee sees nothing before release (drafts / verified are hidden)", G.getMyReleasedResults({ id: A }, round).results.length === 0 && G.getMyReleasedResults({ id: A }, round).conclusion === null);
  ok("5f the doctor releases: the 3 required tests (the waived one excluded)", G.releaseSubject({ id: D }, round, { userId: A }, { licenseUnlocked: true }) === 3);
  ok("5g releasing again changes nothing", G.releaseSubject({ id: D }, round, { userId: A }, { licenseUnlocked: true }) === 0);
  ok("5h a released conclusion is locked", err(() => G.saveConclusion({ id: D }, round, { userId: A }, { summary: "normal" }, { licenseUnlocked: true })) === "conclusion_released"
    && sqlRefused(() => db.prepare("UPDATE annual_checkup_conclusions SET doctor_comment = 'แก้' WHERE user_id = ?").run(A), /locked/));

  // ── 6. the employee: own released results only ──
  const mine = G.getMyReleasedResults({ id: A }, round);
  ok("6a the employee sees their 3 released results and the conclusion", mine.results.length === 3 && mine.conclusion?.doctor_comment === "ติดตามภูมิคุ้มกันตับอักเสบเอ");
  ok("6b …with no waive reason, no lab name, no recorder, no draft data anywhere in what they get", (() => {
    const j = JSON.stringify(mine);
    return !j.includes("งดตามคำสั่งแพทย์") && !j.includes("แล็บภายนอก ก.") && !/waive|recorded_by|verified_by/.test(j);
  })());
  ok("6c employee B sees none of A's results (B has only a draft of their own)", (() => {
    G.recordResult({ id: R }, bHav, { valueText: "ปกติ" });
    const b = G.getMyReleasedResults({ id: B }, round);
    return b.results.length === 0 && b.conclusion === null;
  })());
  ok("6d a verified but unreleased result of B stays hidden from B", (() => {
    const id = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(bHav) as { id: number }).id;
    G.verifyResult({ id: D }, id, { licenseUnlocked: true });
    return G.getMyReleasedResults({ id: B }, round).results.length === 0;
  })());
  ok("6e nobody but clinical staff can open another person's results through the gateway", [A, B, HR, M, W, S].every((u) => err(() => G.getSubjectClinical({ id: u }, round, { userId: A })) === "not_recorder"));
  ok("6f an unknown or inactive actor is refused everywhere", err(() => G.getMyReleasedResults({ id: 999999 }, round)) === "unauthenticated" && err(() => G.getProgress({ id: 999999 }, round)) === "unauthenticated");
  ok("6g clinical staff read a person's full record, drafts included, with the waive reason", (() => {
    const c = G.getSubjectClinical({ id: R }, round, { userId: A });
    return c.results.length === 4 && c.results.some((x) => x.waive_reason === "งดตามคำสั่งแพทย์ (ตั้งครรภ์)") && c.conclusion !== null;
  })());
  ok("6h people without an account are handled the same way (clinical staff only)", (() => {
    const r = G.recordResult({ id: R }, oExt, { valueText: "ปกติ" });
    const c = G.getSubjectClinical({ id: R }, round, { externalId: ext });
    return r > 0 && c.results.length === 1 && err(() => G.getSubjectClinical({ id: HR }, round, { externalId: ext })) === "not_recorder";
  })());

  // ── 7. HR / admin / super_admin: counts only ──
  const prog = G.getProgress({ id: HR }, round);
  ok("7a HR sees counts: A released; B awaiting (all required tests recorded, none released); the outside person checked/awaiting", prog.total === 3 && prog.byState.released === 1 && prog.byState.awaiting_result >= 1);
  ok("7b the progress object holds only counts and the payer name — no value, test, comment or reason", (() => {
    const j = JSON.stringify(prog);
    return !/value|ปกติ|HAV|CXR|งด|ตั้งครรภ์|doctor_comment|interpretation/.test(j) && Object.keys(prog).sort().join() === "byPayer,byState,total";
  })());
  ok("7c admin and super_admin may see the counts; a plain employee may not", !!G.getProgress({ id: W }, round) && !!G.getProgress({ id: S }, round) && err(() => G.getProgress({ id: A }, round)) === "not_allowed");
  ok("7d the all-waived person counts as not checked and never as released", (() => {
    const lone = mkUser("emp-waived", "staff", [nama]);
    order(lone, "CXR", "waived");
    return G.getProgress({ id: HR }, round).byState.not_checked >= 1 && !G.getMyReleasedResults({ id: lone }, round).results.length;
  })());

  // ── 8. audit trail ──
  const actions = (db.prepare("SELECT DISTINCT action FROM annual_checkup_audit").all() as Array<{ action: string }>).map((x) => x.action);
  ok("8a every kind of access left an audit row", ["result.record", "result.update", "result.verify", "result.revise", "conclusion.save", "subject.release", "subject.view", "order_clinical.set", "order_clinical.view", "self.view"].every((a) => actions.includes(a)));
  ok("8b an audit row says who did what to whose result and when", (() => {
    const row = db.prepare("SELECT actor_id, subject_user_id, round_id, created_at FROM annual_checkup_audit WHERE action = 'subject.release' AND subject_user_id = ?").get(A) as { actor_id: number; subject_user_id: number; round_id: number; created_at: string } | undefined;
    return !!row && row.actor_id === D && row.round_id === round && !!row.created_at;
  })());
  ok("8c the employee's own 'who opened my results' lists the clinic people, not themselves", (() => {
    const t = G.getMyAuditTrail({ id: A });
    return t.length > 0 && t.some((x) => x.by_name === "recorder") && t.some((x) => x.by_name === "doctor") && !t.some((x) => x.by_name === "emp-a" && x.action === "self.view");
  })());
  ok("8d a refused write leaves no result behind (transaction rolled back)", (() => {
    const before = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results").get() as { n: number }).n;
    err(() => G.recordResult({ id: R }, oUrine, { valueText: "x" }));
    return (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results").get() as { n: number }).n === before;
  })());

  // ── 8b. phase 4: the clinical screens' reads, files and the unforgeable tokens ──
  const SES = await import("../src/lib/annual-checkup-session");
  const NOW = Date.UTC(2026, 10, 15, 8, 0, 0);
  ok("S1 an unlock token works for its user only, and only until it expires", (() => {
    const t = SES.makeUnlockToken(D, NOW);
    return SES.readUnlockToken(t, D, NOW + 1000) !== null && SES.readUnlockToken(t, R, NOW + 1000) === null && SES.readUnlockToken(t, D, NOW + 31 * 60_000) === null && SES.readUnlockToken(t, D, NOW + 29 * 60_000) !== null;
  })());
  ok("S2 a token that was edited, made for another purpose, or is just a user id is refused", (() => {
    const t = SES.makeUnlockToken(D, NOW);
    const forged = t.replace(`${D}|`, `${R}|`);
    return SES.readUnlockToken(forged, R, NOW + 1000) === null && SES.readUnlockToken(String(D), D, NOW + 1000) === null && SES.readUnlockToken("", D, NOW) === null
      && SES.readFileToken(t, 1, D, NOW + 1000) === false && SES.readUnlockToken(SES.makeFileToken(1, D, NOW), D, NOW + 1000) === null;
  })());
  ok("S3 a file link is for one result and one person and lasts 5 minutes", (() => {
    const t = SES.makeFileToken(77, R, NOW);
    return SES.readFileToken(t, 77, R, NOW + 60_000) && !SES.readFileToken(t, 78, R, NOW + 60_000) && !SES.readFileToken(t, 77, D, NOW + 60_000) && !SES.readFileToken(t, 77, R, NOW + 6 * 60_000);
  })());

  ok("S4 a station QR token carries the station code, never expires, and a forged / edited / other-purpose token is refused", (() => {
    const t = SES.makeStationToken("BLOOD");
    return SES.readStationToken(t) === "BLOOD" && SES.readStationToken(t.replace("BLOOD", "XRAY")) === null && SES.readStationToken("BLOOD") === null && SES.readStationToken("") === null
      && SES.readStationToken(SES.makeUnlockToken(D, NOW)) === null && SES.readUnlockToken(t, D, NOW) === null && SES.makeStationToken("BLOOD") === t && SES.makeStationToken("XRAY") !== t;
  })());

  ok("S5 the registration poster's token is a normal signed station token (forged edits are refused)", (() => {
    const t = SES.makeStationToken(SES.REGISTER_CODE);
    return SES.REGISTER_CODE === "REGISTER" && SES.readStationToken(t) === "REGISTER" && SES.readStationToken(t.replace("REGISTER", "BLOOD")) === null;
  })());

  ok("L1 only clinical staff list the rounds; HR / admin / super_admin / the employee are refused", G.listRoundsClinical({ id: R }).length === 1 && [HR, M, W, S, A].every((u) => err(() => G.listRoundsClinical({ id: u })) === "not_recorder"));
  const ov = G.getRoundOverview({ id: R }, round);
  ok("L2 the round overview lists every person with their progress and the tests with counts", ov.subjects.length >= 4 && ov.tests.length > 0 && ov.subjects.every((x) => x.required >= 0) && !!ov.subjects.find((x) => x.label.includes("emp-a")));
  ok("L3 the overview carries no value, comment or waive reason", !/ติดตามภูมิคุ้มกัน|งดตามคำสั่งแพทย์|value_|doctor_comment/.test(JSON.stringify(ov)));
  ok("L4 the overview is clinical-only (HR / manager / admin / employee refused)", [HR, M, W, S, A].every((u) => err(() => G.getRoundOverview({ id: u }, round)) === "not_recorder"));
  const aRow = ov.subjects.find((x) => x.key === `u${A}`)!;
  ok("L5 person A shows all required tests recorded and released, conclusion released", aRow.required === 3 && aRow.recorded === 3 && aRow.released === 3 && aRow.conclusionReleased);
  ok("L6 the person header gives the name and payer; an unknown person is refused", G.getSubjectHeader({ id: R }, round, { userId: A }).label === "emp-a" && err(() => G.getSubjectHeader({ id: R }, round, { externalId: 999999 })) === "subject_not_found" && err(() => G.getSubjectHeader({ id: HR }, round, { userId: A })) === "not_recorder");
  ok("L7 key helpers round-trip", G.subjectKey({ userId: 5 }) === "u5" && G.subjectKey({ externalId: 9 }) === "e9" && G.parseSubjectKey("u5")?.userId === 5 && G.parseSubjectKey("e9")?.externalId === 9 && G.parseSubjectKey("x5") === null && G.parseSubjectKey("u5; DROP") === null);

  const ph = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, is_placeholder, sort_no) VALUES (?,?,1,1)").run(round, payer).lastInsertRowid);
  const oPh = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id, status) VALUES (?,?,?,?,'ordered')").run(round, ph, payer, test("CXR")).lastInsertRowid);
  ok("E1 a 'waiting for a name' place shows that way, then takes the name a recorder gives it", (() => {
    const before = G.getSubjectHeader({ id: R }, round, { externalId: ph }).label;
    G.setExternalName({ id: R }, ph, { fullName: "นาย คนนอก สอง", sex: "M", dob: "1990-05-01" });
    const after = G.getSubjectHeader({ id: R }, round, { externalId: ph });
    return /รอเพิ่มรายชื่อ คนที่ 1/.test(before) && after.label === "นาย คนนอก สอง" && after.sex === "M";
  })());
  ok("E2 naming needs a name, valid values, and a recorder", err(() => G.setExternalName({ id: R }, ph, { fullName: " " })) === "name_required" && err(() => G.setExternalName({ id: R }, ph, { fullName: "x", dob: "ไม่ใช่วันที่" })) === "bad_value"
    && [HR, M, W, S, A].every((u) => err(() => G.setExternalName({ id: u }, ph, { fullName: "แก้ชื่อ" })) === "not_recorder"));

  const bCxr = order(B, "CXR"), bEye = order(B, "EYE");
  const sheet = G.getTestSheet({ id: R }, round, "CXR");
  ok("T1 the test sheet lists everyone ordered that test, waived ones flagged, no server path or reason leaks", sheet.rows.length >= 4 && sheet.test.code === "CXR" && !JSON.stringify(sheet).includes("lab-001.pdf") && !/งดตามคำสั่งแพทย์/.test(JSON.stringify(sheet)));
  ok("T2 the test sheet is clinical-only; an unknown test is refused", [HR, M, W, S, A].every((u) => err(() => G.getTestSheet({ id: u }, round, "CXR")) === "not_recorder") && err(() => G.getTestSheet({ id: R }, round, "NOPE")) === "test_not_found");

  ok("F1 attaching a file creates a draft that holds only the file", (() => {
    const id = G.attachResultFile({ id: R }, bEye, { filePath: "annual-checkup/1/eye-b.pdf", fileMime: "application/pdf" });
    const r = db.prepare("SELECT status, file_path, value_text FROM annual_checkup_results WHERE id = ?").get(id) as { status: string; file_path: string; value_text: string | null };
    return r.status === "draft" && r.file_path === "annual-checkup/1/eye-b.pdf" && r.value_text === null;
  })());
  ok("F2 editing the values afterwards does NOT drop the attached file", (() => {
    G.recordResult({ id: R }, bEye, { valueText: "สายตาปกติ", interpretation: "normal" });
    return (db.prepare("SELECT file_path, value_text FROM annual_checkup_results WHERE order_id = ?").get(bEye) as { file_path: string; value_text: string }).file_path === "annual-checkup/1/eye-b.pdf";
  })());
  ok("F3 sending a file explicitly replaces it; sending null removes it", (() => {
    G.recordResult({ id: R }, bEye, { valueText: "สายตาปกติ", filePath: "annual-checkup/1/eye-b2.pdf", fileMime: "application/pdf" });
    const a = (db.prepare("SELECT file_path FROM annual_checkup_results WHERE order_id = ?").get(bEye) as { file_path: string }).file_path;
    G.recordResult({ id: R }, bEye, { valueText: "สายตาปกติ", filePath: null, fileMime: null });
    return a === "annual-checkup/1/eye-b2.pdf" && (db.prepare("SELECT file_path FROM annual_checkup_results WHERE order_id = ?").get(bEye) as { file_path: string | null }).file_path === null;
  })());
  ok("F4 an external-lab test is satisfied by a file attached earlier (values saved later keep it)", (() => {
    const bLab = order(B, "STOOL", "external_lab");
    G.attachResultFile({ id: R }, bLab, { filePath: "annual-checkup/1/lab-b.pdf", fileMime: "application/pdf" });
    G.recordResult({ id: R }, bLab, { valueText: "ไม่พบเชื้อ" });
    return (db.prepare("SELECT file_path FROM annual_checkup_results WHERE order_id = ?").get(bLab) as { file_path: string }).file_path === "annual-checkup/1/lab-b.pdf";
  })());
  ok("F5 a locked result takes no file; a waived test takes none; non-clinical callers are refused", err(() => G.attachResultFile({ id: R }, oCxr, { filePath: "x.pdf", fileMime: "application/pdf" })) === "result_locked"
    && err(() => G.attachResultFile({ id: R }, oUrine, { filePath: "x.pdf", fileMime: "application/pdf" })) === "order_waived"
    && [HR, M, W, S, A].every((u) => err(() => G.attachResultFile({ id: u }, bCxr, { filePath: "x.pdf", fileMime: "application/pdf" })) === "not_recorder"));
  ok("F6 the file's location is given to clinical staff only, and each open is audited", (() => {
    const id = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(oStool) as { id: number }).id;
    const f = G.getResultFileClinical({ id: R }, id);
    const refusedAll = [HR, M, W, S, A].every((u) => err(() => G.getResultFileClinical({ id: u }, id)) === "not_recorder");
    return f?.path === "data/health/annual-checkup/lab-001.pdf" && refusedAll && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'file.view' AND actor_id = ?").get(R) as { n: number }).n === 1
      && G.getResultFileClinical({ id: R }, 999999) === null;
  })());
  ok("F7 the person page rows say a file exists but never give its path", (() => {
    const c = G.getSubjectClinical({ id: R }, round, { userId: A });
    return c.results.some((x) => x.has_file === 1) && !JSON.stringify(c).includes("lab-001.pdf");
  })());

  // ── 8b. phase 5: the employee's own view, the LINE notice, the printable report for outside people ──
  const EN = await import("../src/lib/annual-checkup-employee");
  const SS = await import("../src/lib/annual-checkup-session");
  const NT = await import("../src/lib/annual-checkup-notify");
  const bcrypt = (await import("bcryptjs")).default;
  const E = mkUser("emp-e", "staff", [nama]);
  db.prepare("UPDATE users SET line_user_id = 'U-test-e', pin_hash = ? WHERE id = ?").run(bcrypt.hashSync("1234", 4), E);
  const oE = order(E, "HAV", "ordered");
  const resE = G.recordResult({ id: R }, oE, { valueText: "ปกติ", filePath: "annual-checkup/e/hav.pdf", fileMime: "application/pdf" });
  ok("P1 before release the employee has no rounds, no file, and is not on the notify list", G.getMyRounds({ id: E }).length === 0 && G.getMyResultFile({ id: E }, resE) === null
    && !G.listPendingNotifications().some((x) => x.user_id === E));
  G.verifyResult({ id: D }, resE, { licenseUnlocked: true });
  G.saveConclusion({ id: D }, round, { userId: E }, { summary: "normal", doctorComment: "สุขภาพดี" }, { licenseUnlocked: true });
  G.releaseSubject({ id: D }, round, { userId: E }, { licenseUnlocked: true });
  ok("P2 after release: one round listed; own file opens, with an audit row; someone else's result id gives nothing", (() => {
    const f = G.getMyResultFile({ id: E }, resE);
    const own = G.getMyRounds({ id: E });
    const other = [A, B, HR, M, W, S].every((u) => G.getMyResultFile({ id: u }, resE) === null);
    return own.length === 1 && own[0].id === round && f?.path === "annual-checkup/e/hav.pdf" && other
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'self.file' AND actor_id = ?").get(E) as { n: number }).n === 1;
  })());
  ok("P3 the employee's result list carries a result id and a file flag but never the stored path", (() => {
    const j = JSON.stringify(G.getMyReleasedResults({ id: E }, round));
    return !j.includes("hav.pdf") && !j.includes("file_path") && j.includes("result_id") && j.includes("has_file");
  })());
  ok("P4 a verified-but-unreleased file of B cannot be opened by B", (() => {
    const id = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(bHav) as { id: number }).id;
    return G.getMyResultFile({ id: B }, id) === null;
  })());
  ok("P5 the notify list holds E (LINE linked) and not A (no LINE); marking it twice sends nothing more", (() => {
    const first = G.listPendingNotifications().filter((x) => x.user_id === E);
    const noA = !G.listPendingNotifications().some((x) => x.user_id === A);
    G.markNotified(first[0].conclusion_id); G.markNotified(first[0].conclusion_id);
    return first.length === 1 && first[0].line_user_id === "U-test-e" && noA && !G.listPendingNotifications().some((x) => x.user_id === E);
  })());
  ok("P6 recorders see who has no LINE (names only); nobody else may ask", (() => {
    const gaps = G.getRoundLineGaps({ id: R }, round);
    return gaps.length >= 1 && gaps.every((x) => typeof x === "string") && !gaps.some((x) => /emp-e/.test(x))
      && [A, HR, M, W, S].every((u) => err(() => G.getRoundLineGaps({ id: u }, round)) === "not_recorder");
  })());
  ok("P7 the LINE card says the results are ready and nothing else: no value, no verdict, no test name", (() => {
    const j = JSON.stringify(NT.resultsReadyCard());
    return j.includes("ผลตรวจสุขภาพประจำปีของท่านพร้อมแล้ว") && !/ผิดปกติ|ปกติ|ต้องติดตาม|HAV|CXR|ไวรัส|เอกซเรย์|[0-9]+(\.[0-9]+)? ?(mg|g\/dL|%)/.test(j) && j.includes("/staff/health/annual");
  })());
  ok("P8 consent: a default text exists, nobody has agreed yet, agreeing is recorded once per version", (() => {
    const v = EN.getActiveConsent();
    if (!v.body || EN.hasConsented(E)) return false;
    EN.recordConsent(E, "10.0.0.1"); EN.recordConsent(E, "10.0.0.1");
    return EN.hasConsented(E) && !EN.hasConsented(A) && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_consents WHERE user_id = ?").get(E) as { n: number }).n === 1;
  })());
  ok("P9 a new consent text is published by a super_admin only, and everyone is asked again", (() => {
    let refused = false; try { EN.publishConsentVersion(W, "2.0", "ข้อความใหม่"); } catch { refused = true; }
    EN.publishConsentVersion(S, "2.0", "ข้อความใหม่");
    const again = !EN.hasConsented(E) && EN.getActiveConsent().version === "2.0";
    let dup = false; try { EN.publishConsentVersion(S, "2.0", "x"); } catch { dup = true; }
    return refused && again && dup && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_consent_versions WHERE active = 1").get() as { n: number }).n === 1;
  })());
  ok("P10 PIN: right PIN passes; wrong ones are counted and the 6th try is blocked even with the right PIN; no PIN is its own answer", (() => {
    const t0 = Date.now();
    const good = EN.checkViewPin(E, "1234", t0) === "ok";
    for (let i = 0; i < 5; i++) if (EN.checkViewPin(E, "0000", t0 + i) !== "wrong") return false;
    const blocked = EN.checkViewPin(E, "1234", t0 + 10) === "too_many";
    const later = EN.checkViewPin(E, "1234", t0 + 11 * 60_000) === "ok";
    return good && blocked && later && EN.checkViewPin(A, "1234") === "no_pin";
  })());
  ok("P11 the viewing window: valid for its owner, not for another person, not after 15 minutes, not if tampered", (() => {
    const now = Date.now(), t = SS.makeViewToken(E, now);
    return SS.readViewToken(t, E, now + 60_000) !== null && SS.readViewToken(t, A, now + 60_000) === null
      && SS.readViewToken(t, E, now + 16 * 60_000) === null && SS.readViewToken(t + "x", E, now) === null && SS.readViewToken(undefined, E, now) === null;
  })());
  ok("P12 the printable report for an outside person: refused before release, then clinical staff only, audited", (() => {
    const before = err(() => G.getExternalReport({ id: R }, round, ext)) === "not_released";
    const resExt = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(oExt) as { id: number }).id;
    G.verifyResult({ id: D }, resExt, { licenseUnlocked: true });
    G.saveConclusion({ id: D }, round, { externalId: ext }, { summary: "normal", doctorComment: "ปกติ" }, { licenseUnlocked: true });
    G.releaseSubject({ id: D }, round, { externalId: ext }, { licenseUnlocked: true });
    const rep = G.getExternalReport({ id: R }, round, ext);
    const refused = [A, B, HR, M, W, S].every((u) => err(() => G.getExternalReport({ id: u }, round, ext)) === "not_recorder");
    return before && rep.person.label === "คนนอก ทดสอบ" && rep.results.length === 1 && rep.conclusion.doctor === "doctor" && refused
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'external.report' AND actor_id = ?").get(R) as { n: number }).n === 1;
  })());

  // ── 9. revoking ──
  ok("9a only a super_admin revokes; the flag drops and the recorder is refused at once", (() => {
    const notSuper = err(() => G.revokeCapability({ id: W }, R, "recorder", "x")) === "super_admin_only";
    G.revokeCapability({ id: S }, R, "recorder", "ย้ายหน้าที่");
    return notSuper && !G.isRecorderEligible(R) && err(() => G.recordResult({ id: R }, oExt, { valueText: "x" })) === "not_recorder";
  })());
  ok("9b grants are append-only and cannot be written by anyone but a super_admin", sqlRefused(() => db.prepare("UPDATE annual_checkup_grants SET reason = 'x'").run(), /append-only/)
    && sqlRefused(() => db.prepare("DELETE FROM annual_checkup_grants").run(), /append-only/)
    && sqlRefused(() => db.prepare("INSERT INTO annual_checkup_grants (user_id, capability, action, by_user_id) VALUES (?, 'recorder', 'grant', ?)").run(R, W), /only a super_admin/));
  ok("9c a revoke is recorded in the history", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_grants WHERE user_id = ? AND action = 'revoke'").get(R) as { n: number }).n === 1);

  // ── 10. nothing else in the code base touches the result tables ──
  ok("10 no source file outside the gateway / schema mentions the result tables", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !["annual-checkup-db.ts", "annual-checkup-schema.ts"].includes(e.name)
          && /annual_checkup_(results|order_clinical|conclusions|result_revisions|queue|station_passes|submissions)\b/.test(fs.readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    return bad.length === 0;
  })());

  console.log(failed === 0 ? "\n✓ ALL PASS" : `\n✗ ${failed} FAILED`);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
