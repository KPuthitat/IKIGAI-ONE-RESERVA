// External examinees (people of a paying company with no account): data structure, clinic-only writes, no leak into staff views.
// Run: node --import tsx scripts/test-health-external.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-external.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return G.isAnnualCheckupForbidden(e) || G.isAnnualCheckupInvalid(e) ? (e as { code: string }).code : (e instanceof Error ? e.message : String(e)); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const nama = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('nama-x','NAMA',?)").run(co).lastInsertRowid);
  const mk = (u: string, extra: Record<string, unknown> = {}, role = "staff", branch: number | null = null) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    if (branch) db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(id, branch);
    return id;
  };
  const owner = mk("owner", {}, "super_admin"), nurse = mk("nurse", { clinical_role: "nurse" }, "staff", clinic), plain = mk("plain", {}, "staff", nama);
  G.grantCapability({ id: owner }, nurse, "recorder", "ทีมคลินิก");

  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบทดสอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th, is_external) VALUES (?, 'บริษัท ทรานซิสเตอร์ ริช จำกัด', 1)").run(round).lastInsertRowid);
  const payer2 = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th, is_external) VALUES (?, 'บริษัท อื่น จำกัด', 1)").run(round).lastInsertRowid);
  const prog = Number(db.prepare("INSERT INTO annual_checkup_programs (round_id, payer_id, name) VALUES (?,?,'p')").run(round, payer).lastInsertRowid);
  for (const c of ["GLUCOSE", "CBC"]) db.prepare("INSERT INTO annual_checkup_program_tests (program_id, test_id, scope) VALUES (?, (SELECT id FROM annual_checkup_tests WHERE code = ?), 'all')").run(prog, c);
  const N = { id: nurse }, P = { id: plain };
  const usersBefore = (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;

  ok("splitThaiName: title, first, last", (() => { const s = G.splitThaiName("นางสาว สมหญิง ใจดี"); return s.title === "นางสาว" && s.first === "สมหญิง" && s.last === "ใจดี"; })());
  ok("sex is read from the title", G.sexFromTitle("นาย") === "M" && G.sexFromTitle("นางสาว") === "F" && G.sexFromTitle("คุณ") === null);

  const a = G.addExternalPerson(N, round, payer, { title: "นาย", firstName: "สมชาย", lastName: "ใจดี", dob: "1985-03-02", idLast4: "1234" });
  ok("a clinic recorder can add an outside examinee; exam code uses the company prefix (TSR69-0001)", a.created && a.examCode === "TSR69-0001");
  ok("the person gets the programme's tests as orders (2), none twice", a.ordersAdded === 2 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_orders WHERE external_id = ?").get(a.externalId) as { n: number }).n === 2);
  ok("no user account is created", (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n === usersBefore);
  const again = G.addExternalPerson(N, round, payer, { firstName: "สมชาย", lastName: "ใจดี", dob: "1985-03-02" });
  ok("adding the same person again finds the same row (idempotent)", !again.created && again.externalId === a.externalId);
  const other = G.addExternalPerson(N, round, payer2, { firstName: "สมชาย", lastName: "ใจดี" });
  ok("the same name at another company is another person", other.created && other.externalId !== a.externalId && other.examCode === null);
  const b = G.addExternalPerson(N, round, payer, { firstName: "สมศรี", lastName: "ดีใจ" });
  ok("running number goes on (TSR69-0002)", b.examCode === "TSR69-0002");

  ok("ordinary staff cannot add or read an outside examinee", err(() => G.addExternalPerson(P, round, payer, { firstName: "x", lastName: "y" })) !== "" && err(() => G.getExternalDetails(P, a.externalId)) !== "");
  ok("a bad date of birth or ID part is refused", err(() => G.addExternalPerson(N, round, payer, { firstName: "ก", lastName: "ข", dob: "02/03/2530" })) === "bad_value" && err(() => G.addExternalPerson(N, round, payer, { firstName: "ก", lastName: "ข", idLast4: "12" })) === "bad_value");

  const d = G.getExternalDetails(N, a.externalId)!;
  ok("details come back with only the last 4 of the ID and consent off by default", d.id_last4 === "1234" && d.sex === "M" && d.consent_release_to_sponsor === false && d.consent_pdpa_at === null);
  G.setExternalConsent(N, a.externalId, { pdpa: true, releaseToSponsor: true });
  const d2 = G.getExternalDetails(N, a.externalId)!;
  ok("consent can be recorded", d2.consent_release_to_sponsor === true && d2.consent_pdpa_at !== null);
  ok("view and create are in the audit log", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action IN ('external.create','external.view','external.consent')").get() as { n: number }).n >= 4);
  ok("an external examinee has no employee-side rows", (db.prepare("SELECT COUNT(*) n FROM users WHERE display_name LIKE '%สมชาย%'").get() as { n: number }).n === 0);
  ok("the details table is gateway-only (listed in the build-risk scan)", fs.readFileSync("scripts/scan-build-risks.mjs", "utf8").includes("external_details"));

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall external examinee checks passed");
})();
