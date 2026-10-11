// ตำแหน่งงานค่าตอบแทนพิเศษ — who can see what. Run: node --import tsx scripts/test-special-duty-access.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-access.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const A = await import("../src/lib/special-duty-access");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const denies = (fn: () => unknown, code: string) => { try { fn(); return false; } catch (e) { return e instanceof A.AccessError && e.code === code; } };
  const NOW = "2026-11-05", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  let rp = 0;
  const mk = (u: string, dept: string, role = "staff", branch = nama) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,?, 'active',?)").run(u, "x", `ชื่อ-${u}`, role, dept).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, branch);
    return id;
  };
  const roster = (uid: number, from = 1, to = 31) => {
    const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, `P${++rp}`).lastInsertRowid);
    for (let d = from; d <= to; d++) db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(nama, date(d), pos, uid, shift);
  };
  const owner = mk("owner", "management", "super_admin");
  const manager = mk("manager", "management", "admin");
  const cook1 = mk("cook1", "kitchen"), cook2 = mk("cook2", "kitchen"), waiter = mk("waiter", "service"), outsider = mk("outsider", "kitchen", "staff", hypo);
  for (const u of [cook1, cook2, waiter]) roster(u);
  const V = (id: number, role: "staff" | "admin" | "super_admin", branchIds: number[], adminBranchIds: number[] = []) => ({ userId: id, role, branchIds, adminBranchIds });
  const vCook1 = V(cook1, "staff", [nama]), vCook2 = V(cook2, "staff", [nama]), vWaiter = V(waiter, "staff", [nama]);
  const vOutsider = V(outsider, "staff", [hypo]), vManager = V(manager, "admin", [nama], [nama]), vOwner = V(owner, "super_admin", [nama, hypo]);

  const dish = D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างจาน", eligibleGroups: ["kitchen"], actorId: owner, asOf: NOW }).id;
  const toilet = D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW }).id;
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  ok("before booking opens there is no calendar for staff", denies(() => A.getAnonymousSlots(vCook1, nama, YM), "not_published"));
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "booking_open", actorId: owner });

  // book: cook1 dish 1-6 ; cook2 dish 10-15 ; waiter toilet 1-6
  const bk = (uid: number, pid: number, a: number) => R.setUserBookings({ userId: uid, branchId: nama, yearMonth: YM, positionId: pid, dates: Array.from({ length: 6 }, (_, i) => date(a + i)), asOf: NOW });
  bk(cook1, dish, 1); bk(cook2, dish, 10); bk(waiter, toilet, 1);

  // ── anonymous window ──
  const s2 = A.getAnonymousSlots(vCook2, nama, YM);
  const dishView = s2.positions.find((p) => p.id === dish)!;
  const st = (v: typeof dishView, d: number) => v.days.find((x) => x.date === date(d))?.state;
  ok("a slot held by someone else shows only as full", st(dishView, 1) === "full" && st(dishView, 6) === "full");
  ok("your own slot shows as mine, an untouched one as free", st(dishView, 10) === "mine" && st(dishView, 20) === "free");
  ok("the result carries no user id, name, source or status of anyone", (() => {
    const j = JSON.stringify(s2);
    return !j.includes("ชื่อ-") && !j.includes("cook1") && !/"user_?[iI]d"/.test(j) && !j.includes("booked") && !j.includes('"source"');
  })());
  ok("a service person does not get the kitchen-only position's days", A.getAnonymousSlots(vWaiter, nama, YM).positions.find((p) => p.id === dish)!.eligible === false && A.getAnonymousSlots(vWaiter, nama, YM).positions.find((p) => p.id === dish)!.days.length === 0);
  ok("only the viewer's own roster days appear", (() => { const r = mk("part", "kitchen"); roster(r, 1, 10); return A.getAnonymousSlots(V(r, "staff", [nama]), nama, YM).positions.find((p) => p.id === toilet)!.days.length === 10; })());
  ok("another branch's staff cannot open this branch's calendar", denies(() => A.getAnonymousSlots(vOutsider, nama, YM), "forbidden"));

  // everything full: still anonymous
  for (const u of [cook1, cook2, waiter]) for (const p of [dish, toilet]) for (let d = 1; d <= 31; d++) {
    try { db.prepare("INSERT OR IGNORE INTO special_duty_days (position_id,duty_date,user_id,source,status) VALUES (?,?,?,'booked','booked')").run(p, date(d), u); } catch { /* ignore */ }
  }
  const full = A.getAnonymousSlots(vCook1, nama, YM);
  ok("with every slot booked the view is still just free / full / mine", full.positions.every((p) => p.days.every((d) => ["free", "full", "mine"].includes(d.state))) && !JSON.stringify(full).includes("ชื่อ-"));
  ok("a staff member sees only their own rows (and their pay), nobody else's", A.getMyDuties(vCook2, nama, YM).every((r) => r.amount === 150) && A.getMyDuties(vCook2, nama, YM).length === (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(cook2) as { n: number }).n);
  ok("staff cannot read the published schedule while booking is open", denies(() => A.getPublishedSchedule(vCook1, nama, YM), "not_published"));
  ok("staff cannot use the manager view", denies(() => A.getManagerView(vCook1, nama, YM), "forbidden"));
  ok("the manager of ANOTHER branch cannot either", denies(() => A.getManagerView(V(manager, "admin", [nama], [hypo]), nama, YM), "forbidden"));
  ok("the manager sees names, source and status for their branch", (() => { const r = A.getManagerView(vManager, nama, YM); return r.length > 0 && r.every((x) => x.name.startsWith("ชื่อ-") && ["booked", "assigned"].includes(x.source)); })());
  ok("the owner sees any branch (HYPO is empty but allowed)", A.getManagerView(vOwner, hypo, YM).length === 0);

  // ── after the schedule is published ──
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "booking_closed", actorId: owner });
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "filling", actorId: owner });
  ok("the anonymous calendar is still anonymous during filling", !JSON.stringify(A.getAnonymousSlots(vCook1, nama, YM)).includes("ชื่อ-"));
  ok("names stay hidden until the schedule is published", denies(() => A.getPublishedSchedule(vCook1, nama, YM), "not_published"));
  D.advanceMonth({ branchId: nama, yearMonth: YM, to: "special_published", actorId: owner });
  const pub = A.getPublishedSchedule(vCook1, nama, YM);
  ok("after publishing, staff of the branch see who does each day", pub.length > 0 && pub.every((r) => r.name.startsWith("ชื่อ-")));
  ok("…without money, source or status of anyone", (() => { const j = JSON.stringify(pub); return !/amount|rate|source|booked|assigned|status/i.test(j); })());
  ok("…and the same person's slot looks the same whether booked or assigned", Object.keys(pub[0]).sort().join() === "date,name,positionId,positionName");
  ok("staff of the other branch still cannot see it", denies(() => A.getPublishedSchedule(vOutsider, nama, YM), "forbidden"));
  ok("the anonymous calendar no longer exists after the reveal", denies(() => A.getAnonymousSlots(vCook1, nama, YM), "not_published"));

  // ── nothing else reads the booking table ──
  const allowed = new Set(["src/lib/db.ts", "src/lib/special-duty.ts", "src/lib/special-duty-rules.ts", "src/lib/special-duty-access.ts"]);
  const offenders = walk(path.join(process.cwd(), "src")).map((f) => path.relative(process.cwd(), f)).filter((f) => !allowed.has(f) && !f.startsWith("src/lib/special-duty-")
    && fs.readFileSync(path.join(process.cwd(), f), "utf8").includes("special_duty_days"));
  ok(`no other source file queries special_duty_days (found: ${offenders.join(", ") || "none"})`, offenders.length === 0);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
