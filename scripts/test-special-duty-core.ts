// ตำแหน่งงานค่าตอบแทนพิเศษ — core: config, months, positions (max 3), snapshots, budget.
// Run: node --import tsx scripts/test-special-duty-core.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-core.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const throws = (fn: () => unknown, code: string) => { try { fn(); return false; } catch (e) { return e instanceof D.SpecialDutyError && e.code === code; } };
  const NOW = "2026-10-11";

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);

  // config comes from the table, not from code
  ok("config seeded with the owner's values", D.cfgNum("min_days_per_position") === 6 && D.cfgNum("default_daily_rate") === 150 && D.cfgNum("max_positions_per_person_per_day") === 2 && D.cfgNum("absence_strike_limit") === 2 && D.cfgNum("booking_close_day_of_previous_month") === 25 && D.cfgNum("evidence_retention_days") === 90);
  D.setConfig("default_daily_rate", 160, owner);
  ok("a config change is read back and audited with before/after", D.cfgNum("default_daily_rate") === 160 && (db.prepare("SELECT before_json b, after_json a FROM special_duty_audit WHERE entity='config' AND entity_id='default_daily_rate'").get() as { b: string; a: string }).b === "150");
  D.setConfig("default_daily_rate", 150, owner);
  ok("the position cap cannot be raised above 3", throws(() => D.setConfig("max_positions_per_branch", 4, owner), "max_positions_capped"));
  ok("unknown config key rejected", throws(() => D.setConfig("nope", 1, owner), "unknown_config_key"));

  // per-branch criteria (owner 2026-10-18: "ตั้งค่าสาขาใครสาขามัน")
  ok("a branch without its own setting uses the global value", D.cfgNum("booking_close_day_of_previous_month", hypo) === 25 && D.listBranchConfig(hypo).booking_close_day_of_previous_month.overridden === false);
  D.setBranchConfig(hypo, "booking_close_day_of_previous_month", 20, owner);
  ok("a branch's own value applies to that branch only", D.cfgNum("booking_close_day_of_previous_month", hypo) === 20 && D.cfgNum("booking_close_day_of_previous_month", nama) === 25 && D.cfgNum("booking_close_day_of_previous_month") === 25);
  ok("the branch's closing day feeds the default close date", D.bookingCloseDateFor("2026-12", null, hypo) === "2026-11-20" && D.bookingCloseDateFor("2026-12", null, nama) === "2026-11-25");
  ok("listBranchConfig shows effective, global and overridden", (() => { const c = D.listBranchConfig(hypo).booking_close_day_of_previous_month; return c.value === 20 && c.global === 25 && c.overridden; })());
  ok("a branch change is audited with the branch", !!db.prepare("SELECT 1 FROM special_duty_audit WHERE entity='branch_config' AND action='update' AND branch_id = ?").get(hypo));
  D.setBranchConfig(hypo, "booking_close_day_of_previous_month", null, owner);
  ok("clearing returns the branch to the global value", D.cfgNum("booking_close_day_of_previous_month", hypo) === 25 && !D.listBranchConfig(hypo).booking_close_day_of_previous_month.overridden);
  ok("the position cap still cannot exceed 3 for a branch", throws(() => D.setBranchConfig(hypo, "max_positions_per_branch", 4, owner), "max_positions_capped"));
  ok("an unknown key is rejected for a branch too", throws(() => D.setBranchConfig(hypo, "nope", 1, owner), "unknown_config_key"));

  // positions: at most 3 per branch
  const P = (branchId: number, ym: string, slotNo: number, name: string, extra: Partial<Parameters<typeof D.savePosition>[0]> = {}) =>
    D.savePosition({ branchId, yearMonth: ym, slotNo, name, actorId: owner, asOf: NOW, ...extra });
  P(nama, "2026-12", 1, "ล้างจาน", { eligibleGroups: ["kitchen"] });
  P(nama, "2026-12", 2, "ล้างห้องน้ำ");
  P(nama, "2026-12", 3, "รดน้ำต้นไม้");
  ok("default rate comes from config", D.listPositions(nama, "2026-12")[1].dailyRate === 150);
  ok("a 4th position in the same branch is rejected", throws(() => P(nama, "2026-12", 4, "ตำแหน่งที่สี่"), "slot_out_of_range"));
  ok("the schema itself refuses a slot 4 as well", (() => { try { db.prepare("INSERT INTO special_duty_positions (branch_id, year_month, slot_no, name, daily_rate) VALUES (?, '2026-12', 4, 'x', 1)").run(nama); return false; } catch { return true; } })());
  ok("a group outside the list is rejected", throws(() => P(nama, "2026-12", 2, "ล้างห้องน้ำ", { eligibleGroups: ["chef" as never] }), "invalid_group"));
  ok("blank name rejected", throws(() => P(nama, "2026-12", 2, "  "), "name_required"));
  ok("dish washing is restricted to kitchen, the others are open to every group", JSON.stringify(D.listPositions(nama, "2026-12")[0].eligibleGroups) === '["kitchen"]' && D.listPositions(nama, "2026-12")[1].eligibleGroups === null);

  // two branches with different position sets
  P(hypo, "2026-12", 1, "ทำความสะอาดครัว", { dailyRate: 200 });
  P(hypo, "2026-12", 2, "จัดสต๊อก", { dailyRate: 100 });
  ok("each branch keeps its own position set", D.listPositions(hypo, "2026-12").length === 2 && D.listPositions(nama, "2026-12").length === 3);

  // the scheme is off until the owner switches a month on: no budget
  ok("a month that is off has a budget of zero", D.monthBudget(nama, "2026-12") === 0 && D.getMonth(nama, "2026-12").status === "off");
  D.enableMonth({ branchId: nama, yearMonth: "2026-12", actorId: owner, asOf: NOW });
  ok("December 2026 on for NAMA only: awaiting the roster, HYPO still off", D.getMonth(nama, "2026-12").status === "awaiting_roster" && D.getMonth(hypo, "2026-12").status === "off" && D.isEnabled(nama, "2026-12") && !D.isEnabled(hypo, "2026-12"));
  ok("booking closes on the 25th of the previous month by default", D.getMonth(nama, "2026-12").bookingCloseDate === "2026-11-25");
  ok("budget 31 days × 3 positions × 150 = 13,950", D.monthBudget(nama, "2026-12") === 13950);
  ok("a month that is off still has zero budget for the other branch", D.monthBudget(hypo, "2026-12") === 0);

  // budgets for every month length (3 positions at 150)
  for (const [ym, days, expect] of [["2027-02", 28, 12600], ["2028-02", 29, 13050], ["2026-11", 30, 13500], ["2026-12", 31, 13950]] as const) {
    if (ym !== "2026-12") { P(nama, ym, 1, "ล้างจาน"); P(nama, ym, 2, "ล้างห้องน้ำ"); P(nama, ym, 3, "รดน้ำต้นไม้"); D.enableMonth({ branchId: nama, yearMonth: ym, actorId: owner, asOf: NOW }); }
    ok(`budget for ${days} days = ${expect.toLocaleString("en-US")}`, D.daysInMonth(ym) === days && D.monthBudget(nama, ym) === expect);
  }
  ok("two branches: budgets are worked out separately (HYPO 2 positions 200+100)", (() => { D.enableMonth({ branchId: hypo, yearMonth: "2026-12", actorId: owner, asOf: NOW }); return D.monthBudget(hypo, "2026-12") === 31 * 300 && D.monthBudget(nama, "2026-12") === 13950; })());
  ok("an inactive position is left out of the budget", (() => { P(hypo, "2026-12", 2, "จัดสต๊อก", { dailyRate: 100, active: false }); const b = D.monthBudget(hypo, "2026-12"); P(hypo, "2026-12", 2, "จัดสต๊อก", { dailyRate: 100, active: true }); return b === 31 * 200 && D.monthBudget(hypo, "2026-12") === 31 * 300; })());

  // month snapshots: a later month starts from the previous one; editing it does not touch the earlier one
  P(nama, "2027-01", 1, "ล้างจาน", { dailyRate: 180 }); // January starts with its own rate
  D.enableMonth({ branchId: nama, yearMonth: "2027-01", actorId: owner, asOf: NOW });
  ok("the earlier month keeps its rate when January is set differently", D.listPositions(nama, "2026-12")[0].dailyRate === 150 && D.listPositions(nama, "2027-01")[0].dailyRate === 180);
  ok("enabling a month with no positions copies the latest earlier month (snapshot)", (() => {
    D.enableMonth({ branchId: nama, yearMonth: "2027-03", actorId: owner, asOf: NOW });
    const p = D.listPositions(nama, "2027-03");
    return p.length === 3 && p[0].name === "ล้างจาน" && p[0].dailyRate === 150;
  })());
  P(nama, "2027-03", 1, "ล้างจาน", { dailyRate: 999 });   // still awaiting roster → editable
  ok("editing March does not change the months before it", D.listPositions(nama, "2027-02")[0].dailyRate === 150 && D.listPositions(nama, "2026-12")[0].dailyRate === 150);

  // locking and states
  D.advanceMonth({ branchId: nama, yearMonth: "2026-12", to: "booking_open", actorId: owner });
  ok("once booking is open the positions and rates are locked", throws(() => P(nama, "2026-12", 1, "ล้างจาน", { dailyRate: 1 }), "positions_locked"));
  ok("a status cannot skip a step", throws(() => D.advanceMonth({ branchId: nama, yearMonth: "2026-12", to: "filling", actorId: owner }), "invalid_transition"));
  ok("a status cannot go backwards", throws(() => D.advanceMonth({ branchId: nama, yearMonth: "2026-12", to: "awaiting_roster", actorId: owner }), "invalid_transition"));
  ok("an off month cannot be advanced", throws(() => D.advanceMonth({ branchId: hypo, yearMonth: "2027-05", to: "booking_open", actorId: owner }), "month_off"));
  ok("a past month cannot be switched on", throws(() => D.enableMonth({ branchId: nama, yearMonth: "2026-09", actorId: owner, asOf: NOW }), "month_in_past"));

  // late roster publication shortens the window to at least the configured days
  ok("a roster published after the 25th still gives the configured minimum window", D.bookingCloseDateFor("2026-12", "2026-11-27T03:00:00.000Z") === "2026-11-30" && D.bookingCloseDateFor("2026-12", "2026-11-10T03:00:00.000Z") === "2026-11-25");

  // each branch's own closing day while booking is open
  ok("a closing day can be set while booking is open, and is audited", (() => {
    D.enableMonth({ branchId: nama, yearMonth: "2026-12", actorId: owner, asOf: NOW });
    db.prepare("UPDATE special_duty_months SET status = 'booking_open' WHERE branch_id = ? AND year_month = '2026-12'").run(nama);
    const m = D.setBookingCloseDate({ branchId: nama, yearMonth: "2026-12", date: "2026-11-28", actorId: owner, asOf: NOW });
    return m.bookingCloseDate === "2026-11-28" && !!db.prepare("SELECT 1 FROM special_duty_audit WHERE action='set_close_date' AND branch_id = ?").get(nama);
  })());
  ok("a closing day in the past or after the month is refused", throws(() => D.setBookingCloseDate({ branchId: nama, yearMonth: "2026-12", date: "2026-10-01", actorId: owner, asOf: NOW }), "invalid_date") && throws(() => D.setBookingCloseDate({ branchId: nama, yearMonth: "2026-12", date: "2027-01-05", actorId: owner, asOf: NOW }), "invalid_date"));
  ok("another branch's month is not touched", D.getMonth(hypo, "2026-12").bookingCloseDate !== "2026-11-28");
  ok("a closing day cannot be set when booking is not open", throws(() => D.setBookingCloseDate({ branchId: hypo, yearMonth: "2026-12", date: "2026-11-28", actorId: owner, asOf: NOW }), "invalid_transition"));
  // switching off
  ok("a month can be switched off while nothing is booked", (() => { D.enableMonth({ branchId: hypo, yearMonth: "2027-04", actorId: owner, asOf: NOW }); return D.disableMonth({ branchId: hypo, yearMonth: "2027-04", actorId: owner }).status === "off" && D.monthBudget(hypo, "2027-04") === 0; })());
  ok("every change is in the audit log with who / what / before / after", (db.prepare("SELECT COUNT(*) n FROM special_duty_audit WHERE actor_user_id = ? AND (before_json IS NOT NULL OR after_json IS NOT NULL)").get(owner) as { n: number }).n >= 10);
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
