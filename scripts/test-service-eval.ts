// Front-of-house service evaluation — scoring, upsert, summaries, cards.
// Run: node --import tsx scripts/test-service-eval.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-service-eval.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const E = await import("../src/lib/service-eval");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const mk = (u: string, b: number) => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,'staff','active')").run(u, "x", u).lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, b); return id; };
  const boss = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('boss','x','Boss','admin','active')").run().lastInsertRowid);
  const a = mk("a", branch), b = mk("b", branch), far = mk("far", other);
  const items = E.listItems();
  const steps = items.filter((i) => i.section === "steps"), donts = items.filter((i) => i.section === "donts");
  ok("checklist is seeded from the SOP: 11 steps and 15 don'ts", steps.length === 11 && donts.length === 15);
  ok("seeding twice does not duplicate", (E.ensureSeed(), E.listItems().length === 26));

  const D1 = "2026-11-16", D2 = "2026-11-17", D3 = "2026-11-18", D4 = "2026-11-19";
  const mark = (fails: number[], passAll = true) => items.map((it, i) => ({ itemId: it.id, result: (fails.includes(i) ? "fail" : passAll ? "pass" : "na") as "pass" | "fail" | "na" }));
  const r1 = E.saveEval({ branchId: branch, date: D1, userId: a, evaluatorId: boss, marks: mark([4, 5]) });
  ok("score = pass ÷ (pass + fail): 24 of 26", r1.score === Math.round((24 / 26) * 100));
  ok("n/a items are left out of the score", E.saveEval({ branchId: branch, date: D2, userId: b, evaluatorId: boss, marks: [{ itemId: items[0].id, result: "pass" }, { itemId: items[1].id, result: "fail" }, { itemId: items[2].id, result: "na" }] }).score === 50);
  ok("all n/a gives no score", E.saveEval({ branchId: branch, date: D3, userId: b, evaluatorId: boss, marks: [{ itemId: items[0].id, result: "na" }] }).score === null);
  const again = E.saveEval({ branchId: branch, date: D1, userId: a, evaluatorId: boss, note: "แก้ไข", marks: mark([]) });
  ok("saving the same person and day again edits it (one row)", again.id === r1.id && again.score === 100 && (db.prepare("SELECT COUNT(*) n FROM service_evals WHERE user_id = ? AND eval_date = ?").get(a, D1) as { n: number }).n === 1
    && (db.prepare("SELECT COUNT(*) n FROM service_eval_marks WHERE eval_id = ?").get(r1.id) as { n: number }).n === 26);
  const throws = (f: () => void) => { try { f(); return ""; } catch (e) { return (e as { code?: string }).code ?? "err"; } };
  ok("a future day is refused", throws(() => E.saveEval({ branchId: branch, date: "2999-01-01", userId: a, evaluatorId: boss, marks: mark([]) })) === "date_in_future");
  ok("someone from another branch is refused", throws(() => E.saveEval({ branchId: branch, date: D1, userId: far, evaluatorId: boss, marks: mark([]) })) === "not_in_branch");
  ok("no marks is refused", throws(() => E.saveEval({ branchId: branch, date: D1, userId: a, evaluatorId: boss, marks: [] })) === "no_marks");
  ok("an unknown item is refused", throws(() => E.saveEval({ branchId: branch, date: D1, userId: a, evaluatorId: boss, marks: [{ itemId: 99999, result: "pass" }] })) === "invalid_item");

  // trend: a goes 100 then 50 → down
  E.saveEval({ branchId: branch, date: D4, userId: a, evaluatorId: boss, marks: [{ itemId: items[0].id, result: "pass" }, { itemId: items[1].id, result: "fail" }] });
  const s = E.summarize(branch, "2026-11-16", "2026-11-22");
  const pa = s.people.find((p) => p.userId === a)!;
  ok("summary: per-person average and trend", pa.evals === 2 && pa.avgScore === 75 && pa.lastScore === 50 && pa.trend === "down");
  ok("summary: lowest average listed first", s.people[0].avgScore! <= s.people[s.people.length - 1].avgScore!);
  ok("summary: most missed item is counted", s.topFails[0].code === items[1].code && s.topFails[0].count === 2);
  ok("weeks run Monday to Sunday", JSON.stringify(E.weekOf("2026-11-19")) === JSON.stringify({ from: "2026-11-16", to: "2026-11-22" }) && E.weekOf("2026-11-22").from === "2026-11-16");

  const day = E.listEvals(branch, D4, D4);
  const digest = JSON.stringify(E.digestFlex({ branchName: "NAMA", date: D4, evals: day, weekly: s }));
  ok("group digest names the person, the score and what was missed", digest.includes("\"a\"") && digest.includes("50%") && digest.includes(items[1].title));
  const personal = JSON.stringify(E.personalFlex({ branchName: "NAMA", e: day[0] }));
  ok("personal card carries the SOP tip for the missed item", !!items[1].tip && personal.includes(items[1].tip!));
  ok("personal card for a clean day says so", JSON.stringify(E.personalFlex({ branchName: "NAMA", e: E.listEvals(branch, D1, D1)[0] })).includes("ผ่านทุกข้อ"));

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
