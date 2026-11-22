// Partner daily income must never be mirrored into the selling branch (double count). Run: node --import tsx scripts/test-revshare-seller-income.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-revshare-seller-income.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/revshare");
  const C = await import("../src/lib/revshare-income-cleanup");
  const A = await import("../src/lib/accounta-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPOPLARAEMIA')").run().lastInsertRowid);
  const sala = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('sala','ศาลาชิลล์')").run().lastInsertRowid);
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const mk = (name: string, seller: number, incomeBranch: number | null) => Number(db.prepare("INSERT INTO revshare_partners (branch_id,name,start_date,income_branch_id) VALUES (?,?,?,?)").run(seller, name, "2026-01-01", incomeBranch).lastInsertRowid);
  mk("จ้อจี้ & friends", hypo, hypo);       // configured to the selling branch (the mistake)
  mk("ร้านอื่น", hypo, sala);               // booked in the partner's own branch (correct)

  ok("a partner whose income branch is the selling branch is not mirrored", R.incomeBranchToPost({ branch_id: hypo, income_branch_id: hypo }) === null);
  ok("a partner booked in its own branch still is", R.incomeBranchToPost({ branch_id: hypo, income_branch_id: sala }) === sala);
  ok("no income branch means no mirroring", R.incomeBranchToPost({ branch_id: hypo, income_branch_id: null }) === null);

  A.postRevshareDailyIncome({ branchId: hypo, date: "2026-11-19", channel: "จ้อจี้ & friends", amount: 1732.33, isVat: true, userId: owner });
  A.postRevshareDailyIncome({ branchId: hypo, date: "2026-11-20", channel: "จ้อจี้ & friends", amount: 500, isVat: true, userId: owner });
  A.postRevshareDailyIncome({ branchId: sala, date: "2026-11-19", channel: "ร้านอื่น", amount: 900, isVat: true, userId: owner });
  db.prepare("INSERT INTO accounta_income (branch_id, income_date, channel, amount, source, is_revenue) VALUES (?,?,?,?, 'shift_close', 1)").run(hypo, "2026-11-19", "QR / พร้อมเพย์", 19930);

  const found = C.findSellerBranchRevshareIncome();
  ok("only the double-counted rows are found (the selling branch's copy of the partner's sales)", found.length === 2 && found.every((r) => r.branchId === hypo && r.channel === "จ้อจี้ & friends"));
  const dry = C.removeSellerBranchRevshareIncome(false);
  ok("a dry run changes nothing and reports the total", dry.rows.length === 2 && dry.total === 2232.33 && (db.prepare("SELECT COUNT(*) n FROM accounta_income").get() as { n: number }).n === 4);
  const done = C.removeSellerBranchRevshareIncome(true);
  const left = db.prepare("SELECT branch_id, channel, source FROM accounta_income ORDER BY id").all() as Array<{ branch_id: number; channel: string; source: string }>;
  ok("applying removes them, and leaves the partner's own-branch row and the shop's own sales alone", done.rows.length === 2 && left.length === 2
    && left.some((r) => r.branch_id === sala && r.channel === "ร้านอื่น") && left.some((r) => r.source === "shift_close"));
  ok("a second run finds nothing", C.findSellerBranchRevshareIncome().length === 0);

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
