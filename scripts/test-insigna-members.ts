// INSIGNA membership (owner 2026-10-03) — member code YYMMXXXX, sign-up /
// edit, link tokens, checkout bill links that resolve on receipt import,
// consent + delete. Run: node --import tsx scripts/test-insigna-members.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-insigna-members.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;
process.env.INSIGNA_SALT = "test-salt-test-salt-test-salt-1234";

(async () => {
  const { getDb } = await import("../src/lib/db");
  const m = await import("../src/lib/insigna");
  const line = await import("../src/lib/line");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);

  // ── member codes ──
  ok("code prefix: 2026-10-03 → '6910' (พ.ศ. 2569, ตุลาคม)", m.memberCodePrefix("2026-10-03") === "6910");
  ok("code prefix: 2027-01-15 → '7001'", m.memberCodePrefix("2027-01-15") === "7001");
  const c1 = m.issueMemberCode("2026-10-03"), c2 = m.issueMemberCode("2026-10-20"), c3 = m.issueMemberCode("2026-11-01");
  ok("codes run per month: 69100001, 69100002, then 69110001", c1 === "69100001" && c2 === "69100002" && c3 === "69110001");
  ok("isMemberCode accepts 8 digits only", m.isMemberCode("69100001") && !m.isMemberCode("6910001") && !m.isMemberCode("IK-ABC123"));

  // ── keyword + deep link ──
  ok("member keyword matches whole-message forms only", line.isMemberKeyword("สมาชิก") && line.isMemberKeyword(" สมัครสมาชิก ") && line.isMemberKeyword("Member") && !line.isMemberKeyword("อยากเป็นสมาชิก"));
  ok("membership deep link from the @ OA url", line.oaKeywordDeepLink("https://line.me/R/ti/p/@ikigai", line.MEMBER_QR_KEYWORD) === "https://line.me/R/oaMessage/@ikigai/?%E0%B8%AA%E0%B8%A1%E0%B8%B2%E0%B8%8A%E0%B8%B4%E0%B8%81");
  ok("review deep link unchanged", line.oaReviewDeepLink("https://line.me/R/ti/p/@ikigai")?.endsWith("/?%E0%B8%A3%E0%B8%B5%E0%B8%A7%E0%B8%B4%E0%B8%A7") === true);

  // ── link tokens ──
  const LINE_U1 = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  const t1 = m.getOrCreateMemberLink(LINE_U1, A);
  ok("link token is stable per LINE user", m.getOrCreateMemberLink(LINE_U1, A) === t1 && t1.length >= 16);
  const link = m.resolveMemberLink(t1);
  ok("link resolves to the user's hash + branch", link?.customer_hash === m.hashLineUserId(LINE_U1) && link?.branch_id === A);
  ok("unknown token → null", m.resolveMemberLink("nope") === null);

  // ── sign-up ──
  const hash1 = m.hashLineUserId(LINE_U1);
  ok("not a member yet", m.getMemberByHash(hash1) === null);
  const p = m.registerMember({
    customer_hash: hash1, signup_branch_id: A, birth_day: 14, birth_month: 2, birth_year: 1990, gender: "F",
    home_area: "  ศรีราชา ", acquisition_source: "friend", consent_marketing: true, todayIso: "2026-10-03"
  });
  ok("sign-up issues the next code of the month (69100003) + a scan token", p.member_code === "69100003" && !!p.scan_token && !!p.member_since);
  ok("profile stored: birthday as three numbers, gender, trimmed area, source, consents", p.birth_day === 14 && p.birth_month === 2 && p.birth_year === 1990 && p.gender === "F" && p.home_area === "ศรีราชา" && p.acquisition_source === "friend" && p.consent_marketing === 1 && p.consent_analytics === 1 && !!p.consent_at && p.signup_branch_id === A);
  ok("no PII columns ever: the row has no name/phone/dob keys", !("name" in p) && !("phone" in p) && !("dob" in p) && !("line_user_id" in p));
  const p2 = m.registerMember({ customer_hash: hash1, signup_branch_id: A, birth_day: 15, birth_month: 2, birth_year: null, gender: "F", home_area: null, acquisition_source: "google", consent_marketing: false, todayIso: "2026-11-09" });
  ok("re-sign-up = edit: keeps code, date and scan token; updates fields; first source sticks", p2.member_code === "69100003" && p2.member_since === p.member_since && p2.scan_token === p.scan_token && p2.birth_day === 15 && p2.birth_year === null && p2.consent_marketing === 0 && p2.acquisition_source === "friend");
  ok("bad birthday rejected", (() => { try { m.registerMember({ customer_hash: hash1, signup_branch_id: A, birth_day: 32, birth_month: 2, birth_year: null, gender: "M", home_area: null, acquisition_source: null, consent_marketing: false }); return false; } catch { return true; } })());
  ok("lookup by code / by scan token / by scanned URL", m.getMemberByCode("69100003")?.customer_hash === hash1 && m.getMemberByScan(p.scan_token!)?.customer_hash === hash1 && m.getMemberByScan(`https://ikigaimedihealth.com/m/s/${p.scan_token}`)?.customer_hash === hash1 && m.getMemberByScan(" 69100003 ")?.customer_hash === hash1 && m.getMemberByScan("zzz") === null);
  m.setMemberMarketingConsent(hash1, true);
  ok("consent flip", m.getMemberByHash(hash1)?.consent_marketing === 1);
  const oldScan = p.scan_token!;
  const newScan = m.rotateScanToken(hash1);
  ok("scan token rotation invalidates the old QR", newScan !== oldScan && m.getMemberByScan(oldScan) === null && m.getMemberByScan(newScan)?.customer_hash === hash1);

  // ── checkout links before / after the receipt import ──
  ok("checkout link before receipts → pending", m.addMemberBill({ customer_hash: hash1, branch_id: A, sale_date: "2026-10-03", bill_no: "1428" }) === "pending");
  ok("same bill again by the same member → already_yours", m.addMemberBill({ customer_hash: hash1, branch_id: A, sale_date: "2026-10-03", bill_no: "1428" }) === "already_yours");
  ok("same bill by another member → pending_other", m.addMemberBill({ customer_hash: m.hashLineUserId("Uother"), branch_id: A, sale_date: "2026-10-03", bill_no: "1428" }) === "pending_other");
  ok("pending count = 1", m.countPendingBills(hash1) === 1);
  ok("nothing to resolve yet", m.resolvePendingBills(A, "2026-10-03") === 0);
  db.prepare("INSERT INTO salesa_receipts (branch_id,sale_date,bill_no,hour,table_name,gross,discount,nett,payment) VALUES (?,?,?,?,?,?,?,?,?)").run(A, "2026-10-03", "1428", 12, "T1", 650, 0, 650, "cash");
  ok("after the receipt import the pending link resolves into a real bill link", m.resolvePendingBills(A, "2026-10-03") === 1 && m.countPendingBills(hash1) === 0 && m.listLinkedBills(hash1).length === 1 && m.listLinkedBills(hash1)[0].nett === 650);
  ok("checkout link when the receipt already exists → linked immediately", (() => {
    db.prepare("INSERT INTO salesa_receipts (branch_id,sale_date,bill_no,hour,table_name,gross,discount,nett,payment) VALUES (?,?,?,?,?,?,?,?,?)").run(A, "2026-10-04", "1500", 19, "T2", 900, 0, 900, "cash");
    return m.addMemberBill({ customer_hash: hash1, branch_id: A, sale_date: "2026-10-04", bill_no: "1500" }) === "linked" && m.customerBillStats(hash1).distinctDays === 2;
  })());
  ok("global resolve (cron) is a no-op when nothing is pending", m.resolvePendingBills() === 0);

  // ── list + reverse lookup for consented pushes ──
  ok("listMembers returns the member (branch filter works)", m.listMembers().length === 1 && m.listMembers({ branchId: A }).length === 1 && m.listMembers({ branchId: 999 }).length === 0);
  // (the analytics block below adds a second member; the delete block at the end removes only the first)
  const ids = m.lineUserIdsForHashes([hash1, "deadbeef"]);
  ok("lineUserIdsForHashes maps hash → LINE id via the operational table only", ids.get(hash1) === LINE_U1 && ids.size === 1);

  // ── member visit analytics (shared engine with the corporate customers) ──
  {
    const LINE_U2 = "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
    const hash2 = m.hashLineUserId(LINE_U2);
    m.getOrCreateMemberLink(LINE_U2, A);
    m.registerMember({ customer_hash: hash2, signup_branch_id: A, birth_day: 20, birth_month: 10, birth_year: 1988, gender: "M", home_area: "บ่อวิน", acquisition_source: "google", consent_marketing: true, todayIso: "2026-10-01" });
    const ins = db.prepare("INSERT INTO salesa_receipts (branch_id,sale_date,bill_no,hour,table_name,gross,discount,nett,payment) VALUES (?,?,?,?,?,?,?,?,?)");
    // Two bills on 2026-08-19 (one visit, 1,000 total), then 2026-09-08 and 2026-09-16 (Wednesdays / Tuesday as in the corporate test).
    ins.run(A, "2026-08-19", "2001", 12, "T", 600, 0, 600, "cash"); ins.run(A, "2026-08-19", "2002", 13, "T", 400, 0, 400, "cash");
    ins.run(A, "2026-09-08", "2003", 12, "T", 1236, 0, 1236, "cash"); ins.run(A, "2026-09-16", "2004", 12, "T", 1413, 0, 1413, "cash");
    for (const b of ["2001", "2002"]) m.addMemberBill({ customer_hash: hash2, branch_id: A, sale_date: "2026-08-19", bill_no: b });
    m.addMemberBill({ customer_hash: hash2, branch_id: A, sale_date: "2026-09-08", bill_no: "2003" });
    m.addMemberBill({ customer_hash: hash2, branch_id: A, sale_date: "2026-09-16", bill_no: "2004" });
    db.prepare("INSERT OR REPLACE INTO public_holidays (date, name_th, name_en) VALUES (?,?,?)").run("2026-09-09", "วันทดสอบสมาชิก", "MemberTest");
    const rep = m.memberReport({ year: 2026, todayIso: "2026-10-02" });
    const row = rep.rows.find((x) => x.customer_hash === hash2)!;
    // member_since is the real sign-up instant, so "new this month" counts both test members when the suite runs in the month of todayIso.
    const realYm = new Date().toISOString().slice(0, 7);
    ok("report: 2 members, 1 with visits, new-this-month from member_since, birthdays this month = member 2", rep.summary.members === 2 && rep.summary.withVisits === 2 && rep.summary.newThisMonth === (realYm === "2026-10" ? 2 : 0) && rep.summary.birthdaysThisMonth === 1 && rep.birthdays[0].member_code === row.member_code && rep.birthdays[0].day === 20);
    ok("report: same-day bills merge into one visit (3 visits, 3,649 this year)", row.pattern?.visitsYear === 3 && row.pattern?.spendYear === 3649 && row.pattern?.avgPerVisit === 1216.33);
    ok("report: pattern fields — กลางเดือน 2/3, วันพุธ 2/3, near the test holiday once, gap 14 days, not overdue", row.pattern?.phase?.key === "mid" && row.pattern?.phase?.count === 2 && row.pattern?.weekday?.label === "พุธ" && row.pattern?.nearHoliday.count === 1 && row.pattern?.avgGapDays === 14 && row.pattern?.overdue === false && row.pattern?.months[7] === 1 && row.pattern?.months[8] === 2);
    ok("report: demographics — gender M, age band 30–39, area, source, consent", row.gender === "M" && row.ageBand === "30–39" && row.home_area === "บ่อวิน" && row.source === "google" && row.consent_marketing && rep.summary.genders.M === 1 && rep.summary.genders.F === 1 && rep.summary.areas[0].area === "บ่อวิน");
    ok("report: rows with visits sort first; the branch filter drops visits of other branches", rep.rows[0].customer_hash === hash2 && m.memberReport({ year: 2026, todayIso: "2026-10-02", branchId: 999 }).summary.withVisits === 0);
    ok("report: a year without visits keeps the member with zero figures", m.memberReport({ year: 2025, todayIso: "2026-10-02" }).rows.find((x) => x.customer_hash === hash2)?.pattern?.visitsYear === 0);
    ok("ageBandOf edges", m.ageBandOf(2010, "2026-10-02") === "ต่ำกว่า 20" && m.ageBandOf(1950, "2026-10-02") === "70 ขึ้นไป" && m.ageBandOf(null, "2026-10-02") === null);
  }

  // ── delete (right to be forgotten) ──
  const r = m.deleteMember(LINE_U1);
  ok("deleteMember removes the customer, bill links and the link token", r.deleted && m.getMemberByHash(hash1) === null && m.listLinkedBills(hash1).length === 0 && m.resolveMemberLink(t1) === null && m.countPendingBills(hash1) === 0);
  ok("deleting an unknown user is a no-op", m.deleteMember("Unobody").deleted === false);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
