// Health report PR 7: who may be given which capability (and what happens at once when it is taken away), the doctors' overview,
// and what HR may see — only what the employee agreed to. Run: node --import tsx scripts/test-health-admin.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-admin.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const S = await import("../src/lib/health-report/store");
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
  const owner = mk("owner", {}, "super_admin"), admin = mk("admin", {}, "admin", nama), hr = mk("hr", { is_hr_analytics: 1 }, "staff", nama), plain = mk("plain", {}, "staff", nama);
  const nurse = mk("nurse", { clinical_role: "nurse" }, "staff", clinic);
  const docNoLic = mk("doc-no-licence", { clinical_role: "doctor" }, "staff", clinic);
  const doc = mk("doc", { clinical_role: "doctor", license_no: "ว.1" }, "staff", clinic);
  const outsider = mk("outsider", { employee_code: "IKG-X9" }, "staff", nama);
  const emp = mk("emp", { title_prefix: "นาย", dob: "1980-01-01", gender: "male" }, "staff", nama);
  const O = { id: owner }, U = { licenseUnlocked: true };

  ok("only the owner can list the clinic people, grant, revoke, add or search", ["listClinicPeople", "searchPeopleOutsideClinic"].every(() => true)
    && err(() => G.listClinicPeople({ id: admin })) === "super_admin_only" && err(() => G.grantCapability({ id: admin }, nurse, "recorder", "x")) === "super_admin_only"
    && err(() => G.addToClinic({ id: admin }, outsider, "x")) === "super_admin_only" && err(() => G.searchPeopleOutsideClinic({ id: admin }, "out")) === "super_admin_only");
  const people = G.listClinicPeople(O);
  ok("the list is the clinic roster, with what blocks an approver", people.map((p) => p.name).sort().join() === ["doc", "doc-no-licence", "nurse"].sort().join() && people.find((p) => p.name === "nurse")!.approver_blocker!.includes("แพทย์") && people.find((p) => p.name === "doc-no-licence")!.approver_blocker!.includes("ใบอนุญาต") && people.find((p) => p.name === "doc")!.approver_blocker === null);
  ok("a reason is required for every grant", err(() => G.grantCapability(O, nurse, "recorder", "  ")) === "reason_required");
  G.grantCapability(O, nurse, "recorder", "ทีมคลินิก"); G.grantCapability(O, doc, "approver", "แพทย์ผู้อนุมัติ");
  ok("grants are kept with who, what and why", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_grants WHERE reason IS NOT NULL").get() as { n: number }).n === 2 && G.listGrants(O).length === 2);
  ok("a nurse cannot be made an approver (the database refuses)", /refused|annual_checkup/.test(err(() => G.grantCapability(O, nurse, "approver", "x"))) && err(() => G.grantCapability(O, nurse, "approver", "x")) !== "");
  ok("a person on another branch cannot be given a capability until the owner adds them", err(() => G.grantCapability(O, outsider, "recorder", "x")) !== "");
  ok("search finds people outside the clinic, never clinic people", G.searchPeopleOutsideClinic(O, "outs").length === 1 && G.searchPeopleOutsideClinic(O, "nurse").length === 0 && G.searchPeopleOutsideClinic(O, "o").length === 0);
  G.addToClinic(O, outsider, "ช่วยงานคลินิกชั่วคราว");
  ok("after the owner adds them (with a reason, logged) the grant works", err(() => G.grantCapability(O, outsider, "recorder", "ช่วยกรอกผล")) === "" && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'clinic.add' AND subject_user_id = ?").get(outsider) as { n: number }).n === 1);

  // revoke is immediate
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบทดสอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'บริษัท ก')").run(round).lastInsertRowid);
  const order = (u: number, code: string) => Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(round, u, payer, code).lastInsertRowid);
  const eo = order(emp, "GLUCOSE"); const eo2 = order(plain, "GLUCOSE");
  ok("a recorder can save a result", err(() => G.recordResult({ id: nurse }, eo, { valueNum: 95 })) === "");
  G.revokeCapability(O, nurse, "recorder", "ย้ายงาน");
  ok("the moment the capability is taken away, saving is refused", err(() => G.recordResult({ id: nurse }, eo2, { valueNum: 90 })) !== "" && err(() => G.getRoundOverview({ id: nurse }, round)) === "not_recorder");
  ok("the history shows the revoke with its reason", (G.listGrants(O) as Array<{ action: string; reason: string }>).some((g) => g.action === "revoke" && g.reason === "ย้ายงาน"));

  // dashboard
  G.recordResult({ id: outsider }, eo2, { valueNum: 90 });
  G.submitToDoctor({ id: outsider }, round, { userId: plain });
  G.verifyAllForSubject({ id: doc }, round, { userId: emp }, U);
  G.saveConclusion({ id: doc }, round, { userId: emp }, { summary: "follow_up", doctorComment: "ติดตาม" }, U);
  const dash = G.getRoundDashboard({ id: outsider }, round);
  ok("the overview counts each person once at their step", dash.total === 2 && dash.states.to_release === 1 && dash.states.awaiting_doctor === 1 && Object.values(dash.states).reduce((a, b) => a + b, 0) === 2);
  ok("per company and the follow-up list (doctor's verdict) are there", dash.byPayer[0].payer === "บริษัท ก" && dash.byPayer[0].total === 2 && dash.followUp.length === 1 && dash.followUp[0].label.includes("emp") && dash.followUp[0].summary === "ต้องติดตาม");
  ok("jobs per person: sent counts show for the recorder who sent", dash.byRecorder.some((r) => r.name === "outsider" && r.sent === 1));
  ok("HR and plain staff cannot open the clinical overview", err(() => G.getRoundDashboard({ id: hr }, round)) === "not_recorder" && err(() => G.getRoundDashboard({ id: plain }, round)) === "not_recorder");

  // sharing with HR
  G.releaseSubject({ id: doc }, round, { userId: emp }, U);
  ok("by default HR sees no names and no values", G.getFollowUpForHr({ id: hr }, round).length === 0 && err(() => G.getSharedReportData({ id: hr }, round, emp)) === "not_allowed");
  ok("plain staff cannot use the HR functions at all", err(() => G.getFollowUpForHr({ id: plain }, round)) === "not_allowed" && err(() => G.getSharedReportData({ id: plain }, round, emp)) === "not_allowed");
  ok("an employee's choice starts off", JSON.stringify(G.getMyShare({ id: emp })) === JSON.stringify({ followup: false, values: false }));
  G.setMyShare({ id: emp }, "followup", true);
  const f = G.getFollowUpForHr({ id: hr }, round);
  ok("with 'follow-up' on, HR sees the name and the verdict only", f.length === 1 && f[0].name.includes("emp") && f[0].verdict === "ต้องติดตาม" && !JSON.stringify(f).includes("95") && err(() => G.getSharedReportData({ id: hr }, round, emp)) === "not_allowed");
  G.setMyShare({ id: emp }, "values", true);
  const rd = G.getSharedReportData({ id: hr }, round, emp);
  ok("with 'values' on, HR can open that one report — and the opening is logged under the employee", !!rd && rd.results.length === 1 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'hr.view' AND subject_user_id = ?").get(emp) as { n: number }).n === 1);
  ok("it works for the admin and the owner too, but never for another employee's report", !!G.getSharedReportData({ id: admin }, round, emp) && err(() => G.getSharedReportData({ id: hr }, round, plain)) === "not_allowed");
  G.setMyShare({ id: emp }, "values", false); G.setMyShare({ id: emp }, "followup", false);
  ok("the employee can take it back at once", err(() => G.getSharedReportData({ id: hr }, round, emp)) === "not_allowed" && G.getFollowUpForHr({ id: hr }, round).length === 0);
  ok("switching it on and off is kept in their own audit trail", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE subject_user_id = ? AND action IN ('share.on','share.off')").get(emp) as { n: number }).n === 4);
  void S;

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health admin tests passed");
})();
