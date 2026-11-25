// Health report PR 4: the doctor's wording, sending back, releasing a company, telling people about corrections.
// Run: node --import tsx scripts/test-health-doctor.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-doctor.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const N = await import("../src/lib/annual-checkup-notify");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return G.isAnnualCheckupForbidden(e) || G.isAnnualCheckupInvalid(e) ? (e as { code: string }).code : (e instanceof Error ? e.message : String(e)); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const mk = (u: string, extra: Record<string, unknown> = {}, role = "staff", inClinic = false) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    if (inClinic) db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(id, clinic);
    return id;
  };
  const owner = mk("owner", {}, "super_admin");
  const rec = mk("rec", {}, "staff", true), rec2 = mk("rec2", {}, "staff", true);
  const doc = mk("doc", { clinical_role: "doctor", license_no: "ว.1" }, "staff", true);
  for (const r of [rec, rec2]) G.grantCapability({ id: owner }, r, "recorder", "t");
  G.grantCapability({ id: owner }, doc, "approver", "t");
  const a = mk("a", { line_user_id: "Uaaa" }), b = mk("b"), hr = mk("hr", { is_hr_analytics: 1 });
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบทดสอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ผู้จ่าย')").run(round).lastInsertRowid);
  const order = (u: number, code: string) => Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(round, u, payer, code).lastInsertRowid);
  const aGlu = order(a, "GLUCOSE"), bGlu = order(b, "GLUCOSE");
  const R = { id: rec }, R2 = { id: rec2 }, D = { id: doc };
  const U = { licenseUnlocked: true }, L = { licenseUnlocked: false };
  const sa = { userId: a }, sb = { userId: b };
  G.recordResult(R, aGlu, { valueNum: 95 }); G.recordResult(R, bGlu, { valueNum: 105 });
  G.submitToDoctor(R, round, sa); G.submitToDoctor(R, round, sb);

  // ── the doctor's wording ──
  ok("a recorder cannot write the doctor's wording (gateway)", err(() => G.saveSectionNote(R, round, sa, "chem", { summary: "ปกติ" }, U)) === "not_approver");
  ok("a doctor who has not unlocked with the licence number cannot either", err(() => G.saveSectionNote(D, round, sa, "chem", { summary: "ปกติ" }, L)) === "license_not_unlocked");
  ok("and the database refuses it even if the gateway were bypassed", /health_report/.test(err(() => db.prepare("INSERT INTO annual_checkup_section_notes (round_id, user_id, section, summary_text, written_by) VALUES (?,?,?,?,?)").run(round, a, "chem", "x", rec))));
  ok("a bad section key is refused", err(() => G.saveSectionNote(D, round, sa, "Bad Key!", { summary: "x" }, U)) === "bad_value");
  G.saveSectionNote(D, round, sa, "chem", { summary: "ผลปกติ", recommendation: "ออกกำลังกาย" }, U);
  G.saveSectionNote(D, round, sa, "chem", { summary: "ผลปกติมาก", recommendation: null }, U);
  const notes = G.getSectionNotes(R, round, sa);
  ok("a note is saved once per section and overwritten, recorders can read it", notes.length === 1 && notes[0].summary_text === "ผลปกติมาก" && notes[0].recommendation_text === null);
  ok("someone outside the clinic team cannot read the notes", err(() => G.getSectionNotes({ id: hr }, round, sa)) === "not_recorder");
  ok("the person cannot read them before release", G.getMySectionNotes({ id: a }, round).length === 0);

  // ── send back ──
  ok("sending back needs a note", err(() => G.returnToRecorder(D, round, sb, "  ", U)) === "reason_required");
  ok("only an approver doctor can send back (database too)", err(() => G.returnToRecorder(R, round, sb, "แก้", U)) === "not_approver" && /health_report/.test(err(() => db.prepare("INSERT INTO annual_checkup_returns (round_id, user_id, note, returned_by) VALUES (?,?,?,?)").run(round, b, "x", rec))));
  G.returnToRecorder(D, round, sb, "ค่าน้ำตาลต้องตรวจซ้ำ", U);
  const row = (k: string) => G.getRoundOverview(R, round).subjects.find((s) => s.key === k)!;
  ok("the person is no longer waiting for the doctor and shows as returned", row(`u${b}`).returned === true && row(`u${b}`).submitted === false && row(`u${a}`).returned === false);
  ok("the recorder who sent it sees the job; another recorder does not", G.listMyReturns(R, round).length === 1 && G.listMyReturns(R, round)[0].note === "ค่าน้ำตาลต้องตรวจซ้ำ" && G.listMyReturns(R2, round).length === 0);
  ok("anyone opening the person sees the note", G.getOpenReturn(R2, round, sb)?.note === "ค่าน้ำตาลต้องตรวจซ้ำ");
  G.recordResult(R, bGlu, { valueNum: 99 });
  G.submitToDoctor(R, round, sb);
  ok("sending it again closes the job", G.listMyReturns(R, round).length === 0 && row(`u${b}`).returned === false && row(`u${b}`).submitted === true);

  // ── verify all + release a company ──
  ok("verify-all verifies the drafts of one person", G.verifyAllForSubject(D, round, sa, U) === 1 && G.verifyAllForSubject(D, round, sa, U) === 0);
  ok("a recorder cannot verify", err(() => G.verifyAllForSubject(R, round, sb, U)) === "not_approver");
  G.verifyAllForSubject(D, round, sb, U);
  G.saveConclusion(D, round, sa, { summary: "normal", doctorComment: "ok" }, U);          // a has a conclusion, b does not
  const rel = G.releaseCompany(D, round, payer, U);
  ok("releasing the company opens the ready person and lists the other with a reason", rel.people === 1 && rel.released === 1 && rel.skipped.length === 1 && /สรุป/.test(rel.skipped[0].reason));
  ok("the person now reads their own wording, and nothing else", G.getMySectionNotes({ id: a }, round).length === 1 && G.getMySectionNotes({ id: b }, round).length === 0);
  ok("a recorder cannot release a company", err(() => G.releaseCompany(R, round, payer, U)) === "not_approver");
  ok("the first release creates no 'corrected' notice", G.listPendingRevisionNotices().length === 0);

  // ── correction after release ──
  const rid = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(aGlu) as { id: number }).id;
  G.reviseResult(D, rid, { valueNum: 97 }, "พิมพ์ผิด", U);
  ok("after a correction the result is hidden again until it is approved again", (G.getMyReleasedResults({ id: a }, round).results as unknown[]).length === 0);
  G.verifyAllForSubject(D, round, sa, U);
  G.releaseSubject(D, round, sa, U);
  const pend = G.listPendingRevisionNotices();
  ok("approving and releasing again queues one 'corrected' notice for the person", pend.length === 1 && pend[0].user_id === a && pend[0].line_user_id === "Uaaa");
  G.saveSectionNote(D, round, sa, "chem", { summary: "แก้ถ้อยคำ" }, U);
  ok("editing the wording after release queues another notice (still one message to the person)", G.listPendingRevisionNotices().length === 2);
  ok("the notice has no result in it", !/ผลตรวจ.*(\d+\.\d|mg)/.test(JSON.stringify(N.resultsRevisedCard())) && /มีการแก้ไข/.test(JSON.stringify(N.resultsRevisedCard())));
  G.markRevisionNoticed(pend[0].id);
  ok("marking sent removes it", G.listPendingRevisionNotices().length === 1);
  ok("a person without LINE is not queued for a push", (() => { G.saveSectionNote(D, round, sb, "chem", { summary: "x" }, U); return G.listPendingRevisionNotices().every((x) => x.user_id === a); })());

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health doctor tests passed");
})();
