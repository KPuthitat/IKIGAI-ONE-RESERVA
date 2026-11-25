// LDL by calculation (owner's setting). Run: node --import tsx scripts/test-health-ldl.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-ldl.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const I = await import("../src/lib/health-report/interpret");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  ok("Friedewald: 205 − 48 − 150/5 = 127; TG ≥ 400 or incomplete or negative → null", I.friedewaldLdl(205, 48, 150) === 127 && I.friedewaldLdl(205, 48, 400) === null && I.friedewaldLdl(205, null, 100) === null && I.friedewaldLdl(100, 90, 100) === null);

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const mk = (u: string, role = "staff", extra = "") => Number(db.prepare(`INSERT INTO users (username,password_hash,display_name,role,status${extra ? ",clinical_role" : ""}) VALUES (?,?,?,?, 'active'${extra ? ",'nurse'" : ""})`).run(u, "x", u, role).lastInsertRowid);
  const owner = mk("o", "super_admin"), rec = mk("r", "staff", "n");
  db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(rec, clinic);
  G.grantCapability({ id: owner }, rec, "recorder", "t");
  const R = { id: rec };
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('ร', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ก')").run(round).lastInsertRowid);
  const person = (n: string) => { const u = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?, 'staff','active')").run(n, "x", n).lastInsertRowid); const o: Record<string, number> = {}; for (const c of ["CHOL", "HDL", "TG", "LDL"]) o[c] = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(round, u, payer, c).lastInsertRowid); return o; };
  const ldl = (o: Record<string, number>) => db.prepare("SELECT value_num, ref_text, status FROM annual_checkup_results WHERE order_id = ?").get(o.LDL) as { value_num: number; ref_text: string | null; status: string } | undefined;

  const off = person("off");
  G.recordResult(R, off.CHOL, { valueNum: 205 }); G.recordResult(R, off.HDL, { valueNum: 48 }); G.recordResult(R, off.TG, { valueNum: 150 });
  ok("mode OFF (default): nothing is calculated", !ldl(off) && !G.isLdlAutoOn());

  db.prepare("UPDATE annual_checkup_config SET value = '1' WHERE key = 'ldl_calc_mode'").run();
  const a = person("a");
  G.recordResult(R, a.CHOL, { valueNum: 205 }); G.recordResult(R, a.HDL, { valueNum: 48 });
  ok("mode ON: not yet, only two of three values", !ldl(a));
  G.recordResult(R, a.TG, { valueNum: 150 });
  ok("mode ON: the third value fills LDL = 127, as a draft marked as calculated", ldl(a)?.value_num === 127 && ldl(a)?.status === "draft" && ldl(a)?.ref_text === I.LDL_AUTO_NOTE);
  G.recordResult(R, a.TG, { valueNum: 200 });
  ok("a changed input updates the calculated LDL (205 − 48 − 40 = 117)", ldl(a)?.value_num === 117);

  G.recordResult(R, a.LDL, { valueNum: 99 });
  G.recordResult(R, a.TG, { valueNum: 100 });
  ok("a typed LDL is never overwritten by the calculation", ldl(a)?.value_num === 99);

  const hi = person("hi");
  G.recordResult(R, hi.CHOL, { valueNum: 300 }); G.recordResult(R, hi.HDL, { valueNum: 40 }); G.recordResult(R, hi.TG, { valueNum: 450 });
  ok("TG ≥ 400: no calculation (LDL must be measured)", !ldl(hi));

  const off2 = ldl(off);
  const filled = G.fillMissingLdl(R);
  ok("switching the mode on fills people who already had the three values (and only those without an LDL)", filled === 1 && ldl(off)?.value_num === 127 && off2 === undefined && ldl(a)?.value_num === 99);

  // verified result is never touched
  const v = person("v");
  G.recordResult(R, v.CHOL, { valueNum: 200 }); G.recordResult(R, v.HDL, { valueNum: 50 }); G.recordResult(R, v.TG, { valueNum: 100 });
  db.prepare("UPDATE annual_checkup_results SET status = 'draft' WHERE order_id = ?").run(v.LDL);
  ok("calculated for 'v' = 130", ldl(v)?.value_num === 130);
  const doc = mk("d", "staff", "x"); db.prepare("UPDATE users SET clinical_role='doctor', license_no='ว.1' WHERE id = ?").run(doc); db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(doc, clinic);
  G.grantCapability({ id: owner }, doc, "approver", "t");
  G.verifyResult({ id: doc }, (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(v.LDL) as { id: number }).id, { licenseUnlocked: true });
  G.recordResult(R, v.TG, { valueNum: 20 });
  ok("a verified LDL is not changed when an input changes", ldl(v)?.value_num === 130 && ldl(v)?.status === "verified");

  // reference values follow the booklet: nothing is waiting for a doctor's confirmation, and an old flag is cleared once
  ok("no item is flagged 'to be confirmed' (reference values follow the sample booklet)", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_items WHERE needs_check = 1").get() as { n: number }).n === 0 && !!db.prepare("SELECT 1 FROM annual_checkup_config WHERE key = 'refs_follow_booklet'").get());
  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall LDL checks passed");
})();
