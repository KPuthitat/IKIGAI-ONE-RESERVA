// The offer shown on the employee profile. Run: node --import tsx scripts/test-recruita-offer.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-recruita-offer.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { hireOfferFor, hireOffersFor, offerNameKey, setManualOfferConditions } = await import("../src/lib/recruita-offer");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','B')").run().lastInsertRowid);
  const pos = Number(db.prepare("INSERT INTO recruita_positions (branch_id,title) VALUES (?,?)").run(branch, "พนักงานเสิร์ฟ").lastInsertRowid);
  const mkUser = (u: string) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,'staff','active')").run(u, "x", u).lastInsertRowid);
  const cand = () => Number(db.prepare("INSERT INTO recruita_candidates (dedupe_hash) VALUES (?)").run(`h${Math.random()}`).lastInsertRowid);
  const app = (user: number | null, extra: Record<string, unknown>) => {
    const cols = ["candidate_id", "position_id", "stage", "hired_user_id", ...Object.keys(extra)];
    const vals = [cand(), pos, "hired", user, ...Object.values(extra)];
    return Number(db.prepare(`INSERT INTO recruita_applications (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals).lastInsertRowid);
  };

  const withTerms = mkUser("with-terms"), without = mkUser("no-terms"), blank = mkUser("blank-terms"), manual = mkUser("manual"), twice = mkUser("twice");
  app(withTerms, { offer_salary: 15000, offer_salary_type: "monthly", offer_start_date: "2026-03-01", offer_conditions: "  ปรับเงินเดือน 1,000 บาทหลังผ่านโปร  ", hired_at: "2026-03-02" });
  app(without, { offer_salary: 60, offer_salary_type: "hourly" });
  app(blank, { offer_conditions: "   " });
  // an old, superseded hire record and a newer one for the same person
  app(twice, { offer_conditions: "เก่า", hired_at: "2025-01-01" });
  app(twice, { offer_conditions: "ใหม่", hired_at: "2026-01-01" });
  // not hired by this user
  app(null, { offer_conditions: "ไม่ใช่ของใคร" });

  const a = hireOfferFor(withTerms)!;
  ok("special terms are returned, trimmed", a.conditions === "ปรับเงินเดือน 1,000 บาทหลังผ่านโปร");
  ok("position, start date, salary and type come with it", a.positionTitle === "พนักงานเสิร์ฟ" && a.offerStartDate === "2026-03-01" && a.offerSalary === 15000 && a.offerSalaryType === "monthly" && a.hiredAt === "2026-03-02");
  const b = hireOfferFor(without)!;
  ok("an offer without special terms says so (conditions null) and keeps the hourly pay", b.conditions === null && b.offerSalary === 60 && b.offerSalaryType === "hourly");
  ok("whitespace-only terms count as none", hireOfferFor(blank)!.conditions === null);
  ok("the most recent hire record wins", hireOfferFor(twice)!.conditions === "ใหม่");
  ok("someone who was not hired through RECRUITA has no offer card", hireOfferFor(manual) === null);
  ok("an unknown user has none", hireOfferFor(999999) === null);

  // ── People taken on without the hire button: matched by name (+ birth date) ──
  const mkNamed = (u: string, display: string, dob: string | null) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,dob) VALUES (?,?,?,'staff','active',?)").run(u, "x", display, dob).lastInsertRowid);
  const namedApp = (first: string, last: string, dob: string | null, stage: string, extra: Record<string, unknown>) => {
    const c = Number(db.prepare("INSERT INTO recruita_candidates (dedupe_hash, first_name_th, last_name_th, dob) VALUES (?,?,?,?)").run(`n${Math.random()}`, first, last, dob).lastInsertRowid);
    const cols = ["candidate_id", "position_id", "stage", ...Object.keys(extra)];
    return Number(db.prepare(`INSERT INTO recruita_applications (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(c, pos, stage, ...Object.values(extra)).lastInsertRowid);
  };
  ok("name key drops the prefix, spaces and dots", offerNameKey("นางสาว วิชญาพร  แสนสิงห์") === "วิชญาพรแสนสิงห์" && offerNameKey("Miss Ann Lee") === "annlee");
  const named = mkNamed("named", "วิชญาพร แสนสิงห์", "2002-05-01");
  namedApp("วิชญาพร", "แสนสิงห์", "2002-05-01", "accepted", { offer_conditions: "ทดลองงาน 3 เดือน", offer_salary: 50, offer_salary_type: "hourly" });
  const byName = hireOfferFor(named)!;
  ok("someone never tied by the hire button is matched by name and shows the terms sent to them", byName.matchedBy === "name" && byName.conditions === "ทดลองงาน 3 เดือน" && byName.offerSalary === 50);
  const otherDob = mkNamed("otherdob", "สมศรี ใจดี", "1990-01-01");
  namedApp("สมศรี", "ใจดี", "1985-12-12", "hired", { offer_conditions: "ของคนละคน" });
  ok("same name but a different birth date is not matched", hireOfferFor(otherDob) === null);
  const noDob = mkNamed("nodob", "มานะ ขยัน", null);
  namedApp("มานะ", "ขยัน", "1999-09-09", "offered", { offer_start_date: "2026-11-01" });
  ok("no birth date on the employee side still matches on name", hireOfferFor(noDob)?.offerStartDate === "2026-11-01");
  const rej = mkNamed("rej", "ปิติ มีสุข", null);
  namedApp("ปิติ", "มีสุข", null, "rejected", { offer_conditions: "ถูกปฏิเสธ" });
  ok("a rejected application is never matched", hireOfferFor(rej) === null);
  ok("a tied hire wins over a name match", hireOfferFor(withTerms)!.matchedBy === "hire");
  const batch = hireOffersFor([withTerms, named, manual, 999999, noDob]);
  ok("batch: tied and name-matched people are found, others absent", batch.get(withTerms)?.matchedBy === "hire" && batch.get(named)?.matchedBy === "name" && !batch.has(manual) && !batch.has(999999) && batch.get(noDob)?.offerStartDate === "2026-11-01");
  ok("batch agrees with the single lookup", batch.get(named)?.conditions === hireOfferFor(named)?.conditions && hireOffersFor([]).size === 0);

  // ── Conditions typed by an admin ──
  const adminId = mkNamed("adm", "แอดมิน", null);
  const solo = mkNamed("solo", "คนไม่มีใบเสนอ", null);
  ok("manual-only: no offer before typing", hireOfferFor(solo) === null);
  const r1 = setManualOfferConditions(solo, adminId, "  ทดลองงาน 2 เดือน  ");
  const m1 = hireOfferFor(solo)!;
  ok("manual-only: saved trimmed, no application", r1.ok && m1.applicationId === null && m1.matchedBy === "manual" && m1.manualConditions === "ทดลองงาน 2 เดือน" && m1.manualBy === "แอดมิน" && !!m1.manualAt);
  setManualOfferConditions(withTerms, adminId, "เพิ่มเติมโดยแอดมิน");
  const m2 = hireOfferFor(withTerms)!;
  ok("manual + RECRUITA: both kept separately", m2.applicationId != null && m2.conditions === "ปรับเงินเดือน 1,000 บาทหลังผ่านโปร" && m2.manualConditions === "เพิ่มเติมโดยแอดมิน");
  const bm = hireOffersFor([solo, withTerms]);
  ok("batch includes manual", bm.get(solo)?.manualConditions === "ทดลองงาน 2 เดือน" && bm.get(withTerms)?.manualConditions === "เพิ่มเติมโดยแอดมิน");
  setManualOfferConditions(solo, adminId, "   ");
  ok("clearing removes the manual offer", hireOfferFor(solo) === null);
  setManualOfferConditions(solo, adminId, "x".repeat(3000));
  ok("capped at 2000 chars", hireOfferFor(solo)!.manualConditions!.length === 2000);

  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
