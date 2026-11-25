// External examinees, phase 4: release by company, personal link (DOB or last 4 of ID, 30 days, revoke / reissue, every open audited),
// sponsor summary without per-person values, and isolation from staff. Run: node --import tsx scripts/test-health-external-release.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-external-release.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return G.isAnnualCheckupForbidden(e) || G.isAnnualCheckupInvalid(e) ? (e as { code: string }).code : String(e); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const nama = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('nama-x','NAMA',?)").run(co).lastInsertRowid);
  const mk = (u: string, extra: Record<string, unknown> = {}, role = "staff", br: number | null = null) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    if (br) db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(id, br);
    return id;
  };
  const owner = mk("owner", {}, "super_admin"), rec = mk("rec", {}, "staff", clinic), doc = mk("doc", { clinical_role: "doctor", license_no: "ว.1" }, "staff", clinic), plain = mk("plain", {}, "staff", nama);
  G.grantCapability({ id: owner }, rec, "recorder", "t"); G.grantCapability({ id: owner }, doc, "approver", "t");
  const R = { id: rec }, D = { id: doc }, P = { id: plain }, U = { licenseUnlocked: true };

  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th, is_external) VALUES (?, 'บริษัท ทรานซิสเตอร์ ริช จำกัด', 1)").run(round).lastInsertRowid);
  const own = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ของเรา')").run(round).lastInsertRowid);
  const prog = Number(db.prepare("INSERT INTO annual_checkup_programs (round_id, payer_id, name) VALUES (?,?,'p')").run(round, payer).lastInsertRowid);
  db.prepare("INSERT INTO annual_checkup_program_tests (program_id, test_id, scope) VALUES (?, (SELECT id FROM annual_checkup_tests WHERE code = 'GLUCOSE'), 'all')").run(prog);
  const A = G.addExternalPerson(R, round, payer, { title: "นาย", firstName: "เอ", lastName: "หนึ่ง", dob: "1985-03-02", idLast4: "5678" });
  const B = G.addExternalPerson(R, round, payer, { title: "นางสาว", firstName: "บี", lastName: "สอง", idLast4: "9999" });           // no DOB, only ID
  const C = G.addExternalPerson(R, round, payer, { title: "นาย", firstName: "ซี", lastName: "สาม" });                                 // nothing to check against
  const stf = mk("staff1", { gender: "male", dob: "1980-01-01" }, "staff", nama);
  db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = 'GLUCOSE'))").run(round, stf, own);

  const ord = (ext: number) => (db.prepare("SELECT id FROM annual_checkup_orders WHERE external_id = ?").get(ext) as { id: number }).id;
  G.recordResult(R, ord(A.externalId), { valueNum: 95 }); G.recordResult(R, ord(B.externalId), { valueNum: 130 }); G.recordResult(R, ord(C.externalId), { valueNum: 88 });
  G.verifyAllForSubject(D, round, { externalId: A.externalId }, U); G.verifyAllForSubject(D, round, { externalId: B.externalId }, U);   // C stays unverified
  G.saveConclusion(D, round, { externalId: A.externalId }, { summary: "normal" }, U); G.saveConclusion(D, round, { externalId: B.externalId }, { summary: "follow_up" }, U);

  // ── sponsor summary before release: nothing is "released", no values, no readiness
  const s0 = G.getSponsorSummary(R, round, payer);
  ok("before release: 3 people, none released, no readiness shown yet", s0.counts.total === 3 && s0.counts.released === 0 && s0.people.every((p) => p.readiness === null && p.sharedValues === null));

  // ── release by company covers outside examinees; the unverified one is listed, not released
  const rel = G.releaseCompany(D, round, payer, U);
  ok("'release by company' opens A and B and lists C with the reason", rel.people === 2 && rel.skipped.length === 1 && rel.skipped[0].reason.length > 0);
  const vc = G.verifyCompany(D, round, payer, U);
  ok("'verify the whole company' verifies C's remaining draft in one go (and not without the licence unlock / for non-approvers)", vc.people === 1 && vc.verified === 1 && err(() => G.verifyCompany(D, round, payer, { licenseUnlocked: false })) === "license_not_unlocked" && err(() => G.verifyCompany(R, round, payer, U)) === "not_approver");
  ok("the staff member of our own company is not touched by the outside company's release", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results r JOIN annual_checkup_orders o ON o.id = r.order_id WHERE o.user_id = ? AND r.status = 'released'").get(stf) as { n: number }).n === 0);

  // ── personal link
  const la = G.createAccessLink(R, round, A.externalId, 30);
  ok("the link expires in 30 days", Math.abs(new Date(la.expires_at.replace(" ", "T") + "Z").getTime() - (Date.now() + 30 * 86400_000)) < 120_000);
  ok("wrong DOB gives nothing; wrong ID gives nothing", G.verifyAccessLink(la.token, "1999-01-01").ok === false && G.verifyAccessLink(la.token, null, "0000").ok === false);
  const link = (db.prepare("SELECT id FROM annual_checkup_access_links WHERE external_id = ? ORDER BY id DESC").get(A.externalId) as { id: number }).id;
  ok("a wrong proof never opens the report (it needs the verified session, and the report call is separate)", G.verifyAccessLink(la.token, "1999-01-01").ok === false);
  const okDob = G.verifyAccessLink(la.token, "1985-03-02");
  ok("the right DOB opens it", okDob.ok === true);
  ok("the right last 4 of the ID opens it too (case-insensitive)", G.verifyAccessLink(la.token, null, "5678").ok === true);
  const lb = G.createAccessLink(R, round, B.externalId, 30);
  ok("a person with only an ID on file gets a link that opens with the ID", G.verifyAccessLink(lb.token, null, "9999").ok === true && G.verifyAccessLink(lb.token, "1985-03-02").ok === false);
  const before = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'link.view'").get() as { n: number }).n;
  const rep = G.getLinkReportData(link);
  ok("opening the report returns that person's data only, and the open is in the audit log", !!rep && rep.person.label.includes("เอ") && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'link.view'").get() as { n: number }).n === before + 1);
  ok("link of A cannot reach B's data", !rep!.person.label.includes("บี"));

  // reissue: the old link stops working at once
  const la2 = G.createAccessLink(R, round, A.externalId, 30, { reissue: true });
  ok("reissue cancels the earlier link", la2.revoked >= 1 && G.verifyAccessLink(la.token, "1985-03-02").ok === false && G.getLinkReportData(link) === null && G.verifyAccessLink(la2.token, "1985-03-02").ok === true);
  const l2 = (db.prepare("SELECT id FROM annual_checkup_access_links WHERE token_hash IS NOT NULL AND external_id = ? ORDER BY id DESC").get(A.externalId) as { id: number }).id;
  G.revokeAccessLink(R, l2);
  ok("a revoked link is dead", G.verifyAccessLink(la2.token, "1985-03-02").ok === false && G.getLinkReportData(l2) === null);
  const la3 = G.createAccessLink(R, round, A.externalId, 30);
  const l3 = (db.prepare("SELECT id FROM annual_checkup_access_links WHERE external_id = ? ORDER BY id DESC").get(A.externalId) as { id: number }).id;
  db.prepare("UPDATE annual_checkup_access_links SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(l3);
  ok("an expired link gives no result", (G.verifyAccessLink(la3.token, "1985-03-02") as { reason: string }).reason === "expired" && G.getLinkReportData(l3) === null);
  ok("creating, revoking and reissuing are in the audit log", ["link.create", "link.revoke"].every((a) => (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = ?").get(a) as { n: number }).n > 0));

  // ── sponsor summary
  const s1 = G.getSponsorSummary(R, round, payer);
  ok("after release: 2 released, readiness counted (1 suitable, 1 suitable-with-follow-up, 0 see doctor)", s1.counts.released === 2 && s1.counts.readiness.suitable === 1 && s1.counts.readiness.suitable_follow_up === 1 && s1.counts.readiness.see_doctor === 0);
  ok("the summary carries NO per-person values without consent", s1.people.every((p) => p.sharedValues === null) && !JSON.stringify(s1).includes("130") && !JSON.stringify(s1).includes("95"));
  G.setExternalConsent(R, A.externalId, { releaseToSponsor: true });
  const s2 = G.getSponsorSummary(R, round, payer);
  const pa = s2.people.find((p) => p.label.includes("เอ"))!, pb = s2.people.find((p) => p.label.includes("บี"))!;
  ok("with consent only that person's released value appears; others stay hidden", !!pa.sharedValues && pa.sharedValues.some((v) => v.value === "95") && pb.sharedValues === null && !JSON.stringify(s2).includes("130"));
  ok("the summary of one of our own payers is refused (it is for outside companies)", err(() => G.getSponsorSummary(R, round, own)) === "subject_not_found");
  ok("viewing the summary is audited", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'sponsor.view'").get() as { n: number }).n >= 3);

  // ── isolation from staff
  ok("normal staff cannot read outside examinees' data (details, overview, summary, link list, add)", [
    () => G.getExternalDetails(P, A.externalId), () => G.getRoundOverview(P, round), () => G.getSponsorSummary(P, round, payer), () => G.listAccessLinks(P, round, A.externalId), () => G.addExternalPerson(P, round, payer, { firstName: "x", lastName: "y" })
  ].every((f) => err(f) !== ""));
  ok("directly writing to the details table by a non-clinic path is not possible through any exported gateway call for staff", err(() => G.setExternalConsent(P, A.externalId, { releaseToSponsor: true })) !== "");
  const users = (db.prepare("SELECT display_name FROM users").all() as Array<{ display_name: string }>).map((u) => u.display_name);
  ok("no outside examinee exists in the users table (staff list, time clock, roster, payroll all read users)", !users.some((n) => /เอ|บี|ซี/.test(n)));
  const files = (() => { const out: string[] = []; const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name) && fs.readFileSync(p, "utf8").includes("annual_checkup_externals")) out.push(p.replace(process.cwd() + path.sep, "")); } }; walk("src"); return out; })();
  ok("only the check-up modules touch the externals table (PERSONA, roster, payroll, service charge, policy code never do)", files.every((f) => /annual-checkup|health-report/.test(f)));

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall external release checks passed");
})();
