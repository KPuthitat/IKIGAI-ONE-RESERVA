// Unit tests for the MEALPASS 2.0 earn/burn engine. Run: npm run test:mealpass
// Pure money logic (no DB) + a small integration pass on a throwaway DB.
//
// IMPORTANT: db.ts captures DATABASE_PATH into a module-level const at import
// time, so we MUST set it BEFORE importing anything that pulls in db.ts. Hence
// only node built-ins are imported statically; everything else is dynamic,
// inside the async IIFE, after DATABASE_PATH points at the throwaway file.
import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-mealpass.db");
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.error(`✗ ${name}: got ${g}, want ${w}`); failed++; }
  else console.log(`✓ ${name} = ${g}`);
}

(async () => {
  const {
    classifyShift, creditsForShift, applyMonthlyCap, burnQuote, resolveMealCharge, ymOf,
    isAfterCutoff, createMealOrder, confirmMealOrder, balanceForUser, MealpassError,
    DEFAULT_FULL_CREDITS, DEFAULT_HALF_CREDITS,
  } = await import("../src/lib/mealpass");

  const cfg = { full_day_credits: DEFAULT_FULL_CREDITS, half_day_credits: DEFAULT_HALF_CREDITS };
  const rates = { special_rate: 0.5, cash_discount: 0.10 };

  // ── classifyShift ──
  eq("full: 8h rostered, worked ≥450", classifyShift(480, 450), "full");
  eq("half: full roster but worked <450 (left early)", classifyShift(480, 449), "half");
  eq("half: 4h rostered, worked ≥210", classifyShift(240, 210), "half");
  eq("none: 4h rostered, worked <210", classifyShift(240, 209), "none");
  eq("none: rostered <4h", classifyShift(239, 239), "none");
  eq("none: no shift", classifyShift(0, 0), "none");
  eq("full: long shift", classifyShift(600, 560), "full");

  // ── creditsForShift ──
  eq("credits full = 60", creditsForShift(480, 460, cfg), 60);
  eq("credits half = 30", creditsForShift(240, 220, cfg), 30);
  eq("credits none = 0", creditsForShift(120, 120, cfg), 0);

  // ── applyMonthlyCap (cap 1500) ──
  eq("cap: room for full", applyMonthlyCap(1440, 60, 1500), 60);
  eq("cap: partial room", applyMonthlyCap(1470, 60, 1500), 30);
  eq("cap: exactly full", applyMonthlyCap(1500, 60, 1500), 0);
  eq("cap: 10 left", applyMonthlyCap(1490, 60, 1500), 10);
  eq("cap: already over → 0 (never negative)", applyMonthlyCap(1520, 60, 1500), 0);

  // ── burnQuote ──
  eq("burn standard = 60 credits", burnQuote({ mealClass: "standard", creditCost: 60, price: 120, cfg: rates }),
    { mealClass: "standard", credits: 60, baht: 0 });
  eq("burn special = 50% of price in credits", burnQuote({ mealClass: "special", creditCost: 60, price: 200, cfg: rates }),
    { mealClass: "special", credits: 100, baht: 0 });
  eq("burn cash = price −10%", burnQuote({ mealClass: "cash", creditCost: 60, price: 200, cfg: rates }),
    { mealClass: "cash", credits: 0, baht: 180 });

  // ── resolveMealCharge (balance-aware) ──
  eq("standard, enough balance → 60 credits",
    resolveMealCharge({ isStandard: true, creditCost: 60, price: 120, balance: 100, cfg: rates }),
    { mealClass: "standard", credits: 60, baht: 0 });
  eq("standard, short balance → cash −10%",
    resolveMealCharge({ isStandard: true, creditCost: 60, price: 120, balance: 50, cfg: rates }),
    { mealClass: "cash", credits: 0, baht: 108 });
  eq("special, enough balance → 50% credits",
    resolveMealCharge({ isStandard: false, creditCost: 60, price: 200, balance: 100, cfg: rates }),
    { mealClass: "special", credits: 100, baht: 0 });
  eq("special, short balance → cash −10%",
    resolveMealCharge({ isStandard: false, creditCost: 60, price: 200, balance: 99, cfg: rates }),
    { mealClass: "cash", credits: 0, baht: 180 });

  // ── ymOf / cutoff ──
  eq("ymOf slices to YYYY-MM", ymOf("2026-08-09"), "2026-08");
  eq("cutoff: before 15:00 ok", isAfterCutoff("14:59", "15:00"), false);
  eq("cutoff: at 15:00 not after", isAfterCutoff("15:00", "15:00"), false);
  eq("cutoff: after 15:00", isAfterCutoff("15:01", "15:00"), true);

  // ── Integration: create → confirm → ledger (throwaway DB) ──
  const { getDb } = await import("../src/lib/db");
  const db = getDb();                 // runs full migrations on TMP
  db.pragma("foreign_keys = OFF");    // seed without full branch/user rows
  const B = 99001, U = 88001, MGR = 1, YM = "2026-08";

  db.prepare(`INSERT INTO mealpass_config
    (branch_id, enabled, monthly_cap, standard_credit_cost, special_rate, cash_discount, redeem_cutoff)
    VALUES (?,1,1500,60,0.5,0.10,'15:00')`).run(B);
  const std = Number(db.prepare(`INSERT INTO delivera_menu_items
    (branch_id, name_th, price, is_available, is_standard_meal, credit_cost) VALUES (?,?,?,1,1,60)`)
    .run(B, "ข้าวมันไก่", 55).lastInsertRowid);
  const special = Number(db.prepare(`INSERT INTO delivera_menu_items
    (branch_id, name_th, price, is_available, is_standard_meal, credit_cost) VALUES (?,?,?,1,0,60)`)
    .run(B, "สเต๊ก", 200).lastInsertRowid);
  db.prepare(`INSERT INTO mealpass_ledger (user_id, ym, entry_type, credits, attendance_date)
    VALUES (?, ?, 'earn', 100, '2026-08-10')`).run(U, YM);
  eq("int: balance after earn = 100", balanceForUser(U, YM, db), 100);

  const o1 = createMealOrder({ userId: U, branchId: B, menuItemId: std, dineInAck: true, dateBkk: "2026-08-10", db });
  eq("int: standard class", o1.mealClass, "standard");
  eq("int: standard burns 60", o1.credits, 60);
  confirmMealOrder({ code: o1.code, confirmerUserId: MGR, nowHhmm: "12:00", db });
  eq("int: balance after standard burn = 40", balanceForUser(U, YM, db), 40);

  let blocked = false;
  try { createMealOrder({ userId: U, branchId: B, menuItemId: std, dineInAck: true, dateBkk: "2026-08-10", db }); }
  catch (e) { blocked = e instanceof MealpassError && e.code === "already_today"; }
  eq("int: 1 meal/day enforced", blocked, true);

  let noAck = false;
  try { createMealOrder({ userId: U, branchId: B, menuItemId: std, dineInAck: false, dateBkk: "2026-08-13", db }); }
  catch (e) { noAck = e instanceof MealpassError && e.code === "dine_in_required"; }
  eq("int: dine-in ack required", noAck, true);

  // special (price 200 → 100 credits) but balance 40 → cash fallback −10%
  const o2 = createMealOrder({ userId: U, branchId: B, menuItemId: special, dineInAck: true, dateBkk: "2026-08-11", db });
  eq("int: short balance → cash", o2.mealClass, "cash");
  eq("int: cash = 200×0.9", o2.baht, 180);
  confirmMealOrder({ code: o2.code, confirmerUserId: MGR, nowHhmm: "12:00", db });
  eq("int: cash meal keeps credits at 40", balanceForUser(U, YM, db), 40);

  // after cutoff → override required
  const o3 = createMealOrder({ userId: U, branchId: B, menuItemId: std, dineInAck: true, dateBkk: "2026-08-12", db });
  let needsOverride = false;
  try { confirmMealOrder({ code: o3.code, confirmerUserId: MGR, nowHhmm: "16:00", db }); }
  catch (e) { needsOverride = e instanceof MealpassError && e.code === "override_required"; }
  eq("int: after cutoff needs override", needsOverride, true);
  confirmMealOrder({ code: o3.code, confirmerUserId: MGR, nowHhmm: "16:00", override: true, overrideReason: "ลูกค้าแน่นช่วงเที่ยง", db });
  const o3row = db.prepare("SELECT status, override_reason FROM mealpass_orders WHERE code = ?").get(o3.code) as { status: string; override_reason: string };
  eq("int: override confirms", o3row.status, "confirmed");
  eq("int: override reason logged", o3row.override_reason, "ลูกค้าแน่นช่วงเที่ยง");

  db.close();
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }

  if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log(`\nAll MEALPASS engine + integration tests passed`);
})();
