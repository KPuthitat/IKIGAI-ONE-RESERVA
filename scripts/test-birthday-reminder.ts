// HR-group birthday heads-up: 3 / 2 / 1 day before (owner 2026-10-10).
// Run: node --import tsx scripts/test-birthday-reminder.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-birthday-reminder.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const B = await import("../src/lib/birthday-reminder");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const mk = (u: string, dob: string | null, status = "active", extra = 0) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,dob,is_test_account,nickname_th) VALUES (?,?,?,'staff',?,?,?,?)").run(u, "x", u, status, dob, extra, u === "d3" ? "นก" : null).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, br);
    return id;
  };
  // today = 2026-10-10 → 13th (3 days), 12th (2), 11th (1)
  mk("d3", "1990-10-13"); mk("d2", "2533-10-12"); mk("d1", "1995-10-11"); mk("d0", "1990-10-10"); mk("d4", "1990-10-14");
  mk("gone", "1990-10-13", "resigned"); mk("test", "1990-10-13", "active", 1); mk("nodob", null);
  const ppl = B.upcomingBirthdays("2026-10-10");
  ok("exactly the 3, 2 and 1-day birthdays, nobody else", ppl.map((p) => `${p.daysAhead}:${p.name}`).join(",") === "1:d1,2:d2,3:d3");
  ok("a Buddhist-year dob still matches by day and month", ppl.some((p) => p.name === "d2"));
  ok("resigned, test and no-dob accounts are skipped", !ppl.some((p) => ["gone", "test", "nodob"].includes(p.name)));
  ok("nickname and branch are carried", ppl.find((p) => p.name === "d3")?.nickname === "นก" && ppl[0].branches[0] === "NAMA");
  ok("month rollover: 30 Dec looks ahead into January", (() => { mk("ny", "1990-01-02"); return B.upcomingBirthdays("2026-12-30").some((p) => p.name === "ny" && p.daysAhead === 3); })());
  ok("29 Feb birthday is announced for 28 Feb in a common year (and on the 29th in a leap year)", (() => {
    mk("leap", "1992-02-29");
    return B.upcomingBirthdays("2027-02-25").some((p) => p.name === "leap" && p.daysAhead === 3)
      && B.upcomingBirthdays("2028-02-26").some((p) => p.name === "leap" && p.daysAhead === 3);
  })());
  const flex = B.birthdayReminderFlex(ppl);
  const txt = JSON.stringify(flex);
  ok("card groups by lead time with Thai wording", txt.includes("อีก 3 วัน") && txt.includes("อีก 2 วัน") && txt.includes("พรุ่งนี้") && flex.altText.includes("3 คน"));
  ok("one reminder per day", !B.birthdayReminderSent("2026-10-10") && (B.markBirthdayReminderSent("2026-10-10", 3), B.birthdayReminderSent("2026-10-10")) && !B.birthdayReminderSent("2026-10-11"));
  cleanup(); process.exit(failed ? 1 : 0);
})();
