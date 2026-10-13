// The offer shown on the employee profile. Run: node --import tsx scripts/test-recruita-offer.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-recruita-offer.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { hireOfferFor } = await import("../src/lib/recruita-offer");
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
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
