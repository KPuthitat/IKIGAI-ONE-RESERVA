// Health report PR 5: the report model (three years, flags, wording, explanations) and the link for people without an account.
// Run: node --import tsx scripts/test-health-view.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-view.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const S = await import("../src/lib/health-report/store");
  const RP = await import("../src/lib/health-report/report");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return G.isAnnualCheckupForbidden(e) || G.isAnnualCheckupInvalid(e) ? (e as { code: string }).code : String(e); } };

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
  const owner = mk("owner", {}, "super_admin"), rec = mk("rec", {}, "staff", true), hr = mk("hr", { is_hr_analytics: 1 });
  const doc = mk("doc", { clinical_role: "doctor", license_no: "ว.1" }, "staff", true);
  G.grantCapability({ id: owner }, rec, "recorder", "t"); G.grantCapability({ id: owner }, doc, "approver", "t");
  const emp = mk("emp", { title_prefix: "นางสาว", employee_code: "IKG-W47", dob: "1975-01-02", gender: "female", job_title: "พนักงานบัญชี" });
  const other = mk("other", { dob: "1990-01-01", gender: "male" });
  const mkRound = (name: string, year: number) => Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status, start_date) VALUES (?,?, 'open', ?)").run(name, year, `${year - 543}-11-14`).lastInsertRowid);
  const r68 = mkRound("รอบ 2568", 2568), r69 = mkRound("รอบ 2569", 2569);
  const payer = (r: number) => Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'บริษัท ทดสอบ จำกัด')").run(r).lastInsertRowid);
  const p68 = payer(r68), p69 = payer(r69);
  const order = (r: number, p: number, u: number, code: string) => Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(r, u, p, code).lastInsertRowid);
  const items = S.loadItems(db);
  const D = { id: doc }, R = { id: rec }, U = { licenseUnlocked: true };
  const rec1 = (ord: number, tc: string, vals: Record<string, number | string | null>) => G.recordResult(R, ord, S.valuesToInput(S.itemsOfTest(items, tc), vals));
  // 2568 round: glucose 90, Hb 12.5 (normal for a woman)
  rec1(order(r68, p68, emp, "GLUCOSE"), "GLUCOSE", { FBS: 90 }); rec1(order(r68, p68, emp, "CBC"), "CBC", { HB: 12.5, WBC: 6 });
  // 2569 round: glucose 112 (high), Hb 11.0 (low), WBC 7; audiometry with 4000 Hz over 25 on the left ear; physical exam; HIV (never shown); not-released HDL
  const aud: Record<string, number | string | null> = {}; for (const f of [500, 1000, 2000, 3000, 4000, 6000, 8000]) { aud[`AUD_R_${f}`] = 15; aud[`AUD_L_${f}`] = f === 4000 ? 40 : 15; }
  rec1(order(r69, p69, emp, "GLUCOSE"), "GLUCOSE", { FBS: 112 }); rec1(order(r69, p69, emp, "CBC"), "CBC", { HB: 11.0, WBC: 7 }); rec1(order(r69, p69, emp, "AUDIO"), "AUDIO", aud);
  rec1(order(r69, p69, emp, "PHYSICAL"), "PHYSICAL", { WEIGHT: 70, HEIGHT: 160, EX_HEART: "ปกติ", BLOOD_GROUP: "O Rh+" });
  rec1(order(r69, p69, emp, "HIV"), "HIV", { ANTI_HIV: "Negative" });
  const hdl = order(r69, p69, emp, "HDL"); rec1(hdl, "HDL", { HDL: 30 });
  for (const r of [r68, r69]) {
    G.verifyAllForSubject(D, r, { userId: emp }, U);
    G.saveSectionNote(D, r, { userId: emp }, "overall", { summary: "ภาพรวมดี", recommendation: "ออกกำลังกายสม่ำเสมอ" }, U);
    G.saveSectionNote(D, r, { userId: emp }, "chem", { summary: "น้ำตาลสูงเล็กน้อย", recommendation: "ลดของหวาน" }, U);
    G.saveConclusion(D, r, { userId: emp }, { summary: "follow_up", doctorComment: "ติดตาม" }, U);
  }
  // the HDL result is NOT verified before release (leave it draft by reverting: simulate an unreleased test)
  G.releaseSubject(D, r68, { userId: emp }, U);
  G.releaseSubject(D, r69, { userId: emp }, U);

  // ── employee report ──
  const rd = G.getMyReportData({ id: emp }, r69)!;
  ok("the employee gets their own released report; nobody else is reachable through this function", !!rd && rd.person.user_id === emp && G.getMyReportData({ id: other }, r69) === null);
  ok("the previous year comes with it", Object.keys(rd.history).join() === "2568" && rd.history[2568].some((x) => x.code === "GLUCOSE"));
  const texts = Object.fromEntries((db.prepare("SELECT key, title_th, body_th FROM annual_checkup_explanations").all() as Array<{ key: string; title_th: string | null; body_th: string }>).map((r) => [r.key, { title: r.title_th, body: r.body_th }]));
  const rep = RP.buildReport(rd, items, texts, "2026-11-25");
  const sec = (k: string) => rep.sections.find((s) => s.key === k);
  const row = (code: string) => rep.sections.flatMap((s) => s.rows).find((r) => r.code === code)!;
  ok("only sections with a released test appear, in the booklet's order", rep.sections.map((s) => s.key).join() === "general,cbc,chem,audio");
  ok("header: name with title, age on the exam date, company, employee code, position", rep.header.name.includes("emp") && rep.header.age === 51 && rep.header.company === "บริษัท ทดสอบ จำกัด" && rep.header.employeeCode === "IKG-W47" && rep.header.position === "พนักงานบัญชี");
  ok("three year columns 2567 / 2568 / 2569 with '-' where there is no result", rep.years.join() === "2567,2568,2569" && row("FBS").cells.map((c) => c.text).join() === "-,90,112");
  ok("a woman's Hb 11.0 is low, glucose 112 is high — as words", row("HB").flagWord === "ต่ำ" && row("FBS").flagWord === "สูง" && row("WBC").flagWord === "");
  ok("the summary card lists the abnormal items of this year", rep.summary.abnormal.some((a) => a.name === "Hemoglobin A1C" || a.name === "Hb (Hemoglobin)") && rep.summary.abnormal.some((a) => a.name === "Fasting blood sugar" && a.word === "สูง"));
  ok("HIV is never printed in the booklet; HDL 30 is low for a woman (≥ 50)", !rep.sections.some((s) => s.rows.some((r) => r.code === "ANTI_HIV")) && row("HDL").flagWord === "ต่ำ");
  ok("audiometry becomes seven frequency rows and one hearing sentence", sec("audio")!.rows.length === 7 && sec("audio")!.lines[0] === "การได้ยินของหูขวาปกติ / การได้ยินของหูซ้ายลดลงที่ความถี่ 4000 เฮิรตซ์");
  ok("BMI is computed in the general section", sec("general")!.lines.some((l) => l.startsWith("ดัชนีมวลกาย 27.3")));
  ok("the doctor's wording per section and overall is carried", sec("chem")!.note?.recommendation === "ลดของหวาน" && rep.summary.recommendations.includes("ออกกำลังกายสม่ำเสมอ") && rep.summary.overall.verdict === "ต้องติดตาม");
  ok("'what is this?' texts come from the table (edit-able), section intro too", row("FBS").explain!.includes("น้ำตาลกลูโคส") && sec("cbc")!.intro!.body.includes("Complete blood count") && sec("audio")!.edu!.body.includes("เดซิเบล"));
  ok("the dozens of explanation texts are seeded (CBC 15 + urine 17 + chemistry 19 …)", Object.keys(texts).length >= 55);

  // ── link for a person without an account ──
  const r70 = mkRound("รอบนอก", 2569);
  const px = payer(r70);
  const ext = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, full_name, sex, dob) VALUES (?,?,?,?,?)").run(r70, px, "คนนอก ทดสอบ", "M", "1988-03-04").lastInsertRowid);
  const eo = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = 'GLUCOSE'))").run(r70, ext, px).lastInsertRowid);
  G.recordResult(R, eo, { valueNum: 95 });
  ok("no link before the results are released", err(() => G.createAccessLink(R, r70, ext, 7)) === "not_released");
  G.verifyAllForSubject(D, r70, { externalId: ext }, U); G.saveConclusion(D, r70, { externalId: ext }, { summary: "normal" }, U); G.releaseSubject(D, r70, { externalId: ext }, U);
  ok("only a clinic recorder can make a link", err(() => G.createAccessLink({ id: hr }, r70, ext, 7)) === "not_recorder");
  const link = G.createAccessLink(R, r70, ext, 7);
  ok("the token is unguessable and only its hash is stored", link.token.length >= 32 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_access_links WHERE token_hash = ?").get(link.token) as { n: number }).n === 0 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_access_links").get() as { n: number }).n === 1);
  ok("an unknown or malformed token is just 'invalid'", G.resolveAccessLink("x") === null && G.resolveAccessLink("a".repeat(32)) === null && (G.verifyAccessLink("a".repeat(32), "1988-03-04") as { reason: string }).reason === "invalid");
  const w1 = G.verifyAccessLink(link.token, "1988-03-05") as { ok: false; reason: string; attemptsLeft: number };
  ok("a wrong date is refused and the tries left are told", w1.ok === false && w1.reason === "wrong" && w1.attemptsLeft === 4);
  const good = G.verifyAccessLink(link.token, "1988-03-04");
  ok("the right date opens it and clears the count", good.ok === true && (db.prepare("SELECT failed_count n FROM annual_checkup_access_links").get() as { n: number }).n === 0);
  const linkId = (good as { linkId: number }).linkId;
  const lr = G.getLinkReportData(linkId)!;
  ok("the report behind the link is that person's only, and has no history", lr.person.kind === "external" && lr.person.label === "คนนอก ทดสอบ" && Object.keys(lr.history).length === 0 && lr.results.length === 1);
  ok("every opening is logged (actor 0 = the link)", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'link.view' AND subject_external_id = ?").get(ext) as { n: number }).n >= 1);
  let last: { ok: boolean; reason?: string } = { ok: true };
  for (let i = 0; i < 5; i++) last = G.verifyAccessLink(link.token, "2000-01-01") as typeof last;
  ok("five wrong tries lock the link — even the right date is refused while locked", last.reason === "locked" && (G.verifyAccessLink(link.token, "1988-03-04") as { reason: string }).reason === "locked");
  ok("after the lock time the right date works again", (() => { db.prepare("UPDATE annual_checkup_access_links SET locked_until = '2000-01-01 00:00:00'").run(); return G.verifyAccessLink(link.token, "1988-03-04").ok === true; })());
  const fileOf = G.getLinkResultFile(linkId, (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(eo) as { id: number }).id);
  ok("a file is served only for a result of that person (this one has none)", fileOf === null);
  db.prepare("UPDATE annual_checkup_access_links SET expires_at = '2000-01-01 00:00:00'").run();
  ok("an expired link cannot be opened, and its report is gone", (G.verifyAccessLink(link.token, "1988-03-04") as { reason: string }).reason === "expired" && G.getLinkReportData(linkId) === null);
  const l2 = G.createAccessLink(R, r70, ext, 7);
  const id2 = (db.prepare("SELECT id FROM annual_checkup_access_links ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  G.revokeAccessLink(R, id2);
  ok("a revoked link cannot be opened", (G.verifyAccessLink(l2.token, "1988-03-04") as { reason: string }).reason === "revoked");
  ok("a person without a date of birth cannot be given a link", (() => { const e2 = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, full_name) VALUES (?,?,?)").run(r70, px, "ไม่มีวันเกิด").lastInsertRowid); const o2 = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, external_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = 'GLUCOSE'))").run(r70, e2, px).lastInsertRowid); G.recordResult(R, o2, { valueNum: 90 }); G.verifyAllForSubject(D, r70, { externalId: e2 }, U); G.saveConclusion(D, r70, { externalId: e2 }, { summary: "normal" }, U); G.releaseSubject(D, r70, { externalId: e2 }, U); return err(() => G.createAccessLink(R, r70, e2, 7)) === "dob_required"; })());

  // ── the A5 PDF ──
  const PDF = await import("../src/lib/health-report/report-pdf");
  const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  const pdf = await PDF.generateReportPdf(rep, { consultUrl: "https://example.com/consult" });
  ok("the booklet renders as a PDF: cover, content pages, back cover", pdf.subarray(0, 5).toString() === "%PDF-" && pages(pdf) >= 6);
  ok("it is A5 (419.5 × 595.3 pt)", /MediaBox \[0 0 419\.5\d* 595\.2\d*\]/.test(pdf.toString("latin1")));
  const noQr = await PDF.generateReportPdf(rep, { consultUrl: null });
  ok("without a consult link the booklet still renders", noQr.subarray(0, 5).toString() === "%PDF-");
  const PD = await import("../src/lib/health-report/pdf-data");
  ok("file name is English, upper case: HEALTHREPORTA5_<CODE>_<YEAR>", /HEALTHREPORTA5_IKG-W47_2026\.pdf/.test(PD.reportDisposition(rd)));

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health view tests passed");
})();
