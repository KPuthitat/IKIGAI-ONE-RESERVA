// ตำแหน่งงานค่าตอบแทนพิเศษ — core (owner 2026-10-11). Months, positions, config, audit.
//
// A branch can switch the scheme on for a month; it then has at most 3 positions with
// a daily rate and an optional restriction to work groups (users.department). The
// month's positions are a snapshot: editing a later month never changes an earlier one.
// Every limit comes from special_duty_config — no number in this file decides a rule.
// Booking, visibility and pay live in their own modules (special-duty-*.ts).

import { getDb } from "./db";
import { getLastPublish } from "./roster";

export type DutyMonthStatus =
  | "off" | "awaiting_roster" | "booking_open" | "booking_closed"
  | "filling" | "special_published" | "in_progress" | "settled";

export const WORK_GROUPS = ["service", "kitchen", "management", "other"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

export class SpecialDutyError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const daysInMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const prevMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };
const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

// ── config ────────────────────────────────────────────────────────────────

/** A criterion's value. With a branch: that branch's own setting if it has one, otherwise the global value. */
export function cfgNum(key: string, branchId?: number | null): number {
  const db = getDb();
  if (branchId != null) {
    const o = db.prepare("SELECT value FROM special_duty_branch_config WHERE branch_id = ? AND key = ?").get(branchId, key) as { value: string } | undefined;
    const on = Number(o?.value);
    if (o && Number.isFinite(on)) return on;
  }
  const r = db.prepare("SELECT value FROM special_duty_config WHERE key = ?").get(key) as { value: string } | undefined;
  const n = Number(r?.value);
  if (!r || !Number.isFinite(n)) throw new SpecialDutyError("config_missing", `special_duty_config.${key} is not set`);
  return n;
}

export function listConfig(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of getDb().prepare("SELECT key, value FROM special_duty_config").all() as Array<{ key: string; value: string }>) out[r.key] = Number(r.value);
  return out;
}

/** Every criterion as one branch sees it: its effective value, the global one, and whether the branch overrides it. */
export function listBranchConfig(branchId: number): Record<string, { value: number; global: number; overridden: boolean }> {
  const db = getDb();
  const own = new Map((db.prepare("SELECT key, value FROM special_duty_branch_config WHERE branch_id = ?").all(branchId) as Array<{ key: string; value: string }>).map((r) => [r.key, Number(r.value)]));
  const out: Record<string, { value: number; global: number; overridden: boolean }> = {};
  for (const [key, g] of Object.entries(listConfig())) out[key] = { value: own.has(key) ? own.get(key)! : g, global: g, overridden: own.has(key) };
  return out;
}

/** Set (or, with null, clear) one branch's own value of a criterion. Same limits as the global setter. */
export function setBranchConfig(branchId: number, key: string, value: number | null, actorId: number): void {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM special_duty_config WHERE key = ?").get(key)) throw new SpecialDutyError("unknown_config_key");
  const before = listBranchConfig(branchId)[key];
  if (value == null) {
    db.prepare("DELETE FROM special_duty_branch_config WHERE branch_id = ? AND key = ?").run(branchId, key);
  } else {
    if (!Number.isFinite(value) || value < 0) throw new SpecialDutyError("invalid_value");
    if (key === "max_positions_per_branch" && value > 3) throw new SpecialDutyError("max_positions_capped", "the schema holds 3 positions per branch");
    db.prepare(`INSERT INTO special_duty_branch_config (branch_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(branchId, key, String(value), actorId, new Date().toISOString());
  }
  audit({ actorId, branchId, entity: "branch_config", entityId: key, action: value == null ? "clear" : "update", before: before.value, after: value == null ? before.global : value });
}

export function setConfig(key: string, value: number, actorId: number): void {
  const db = getDb();
  const cur = db.prepare("SELECT value FROM special_duty_config WHERE key = ?").get(key) as { value: string } | undefined;
  if (!cur) throw new SpecialDutyError("unknown_config_key");
  if (!Number.isFinite(value) || value < 0) throw new SpecialDutyError("invalid_value");
  if (key === "max_positions_per_branch" && value > 3) throw new SpecialDutyError("max_positions_capped", "the schema holds 3 positions per branch");
  db.prepare("UPDATE special_duty_config SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?")
    .run(String(value), actorId, new Date().toISOString(), key);
  audit({ actorId, entity: "config", entityId: key, action: "update", before: Number(cur.value), after: value });
}

// ── audit ─────────────────────────────────────────────────────────────────

export function audit(a: {
  actorId: number | null; branchId?: number | null; yearMonth?: string | null;
  entity: string; entityId?: string | number | null; action: string; before?: unknown; after?: unknown;
}): void {
  getDb().prepare(`
    INSERT INTO special_duty_audit (at, actor_user_id, branch_id, year_month, entity, entity_id, action, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), a.actorId, a.branchId ?? null, a.yearMonth ?? null, a.entity,
    a.entityId == null ? null : String(a.entityId), a.action,
    a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after));
}

// ── months ────────────────────────────────────────────────────────────────

export type DutyMonth = {
  branchId: number; yearMonth: string; enabled: boolean; status: DutyMonthStatus;
  bookingCloseDate: string | null; bookingOpenedAt: string | null; specialPublishedAt: string | null; settledAt: string | null;
};

type MonthRow = {
  branch_id: number; year_month: string; enabled: number; status: DutyMonthStatus; booking_close_date: string | null;
  booking_opened_at: string | null; special_published_at: string | null; settled_at: string | null;
};
const shapeMonth = (r: MonthRow): DutyMonth => ({
  branchId: r.branch_id, yearMonth: r.year_month, enabled: !!r.enabled, status: r.status,
  bookingCloseDate: r.booking_close_date, bookingOpenedAt: r.booking_opened_at,
  specialPublishedAt: r.special_published_at, settledAt: r.settled_at
});

/** A month with no row (or switched off) is "off": no notices, no booking, no budget, no pay. */
export function getMonth(branchId: number, yearMonth: string): DutyMonth {
  const r = getDb().prepare("SELECT * FROM special_duty_months WHERE branch_id = ? AND year_month = ?")
    .get(branchId, yearMonth) as MonthRow | undefined;
  return r ? shapeMonth(r) : { branchId, yearMonth, enabled: false, status: "off", bookingCloseDate: null, bookingOpenedAt: null, specialPublishedAt: null, settledAt: null };
}

export function isEnabled(branchId: number, yearMonth: string): boolean {
  const m = getMonth(branchId, yearMonth);
  return m.enabled && m.status !== "off";
}

/** Default last booking day: the Nth of the PREVIOUS month; if the roster was
 *  published so late that fewer than min_booking_window_days remain, publish day + window. */
export function bookingCloseDateFor(yearMonth: string, publishedAtIso?: string | null, branchId?: number | null): string {
  const day = String(cfgNum("booking_close_day_of_previous_month", branchId)).padStart(2, "0");
  const standard = `${prevMonth(yearMonth)}-${day}`;
  if (!publishedAtIso) return standard;
  const pub = new Date(new Date(publishedAtIso).getTime() + 7 * 3600_000);
  pub.setUTCDate(pub.getUTCDate() + cfgNum("min_booking_window_days", branchId));
  const earliest = pub.toISOString().slice(0, 10);
  return earliest > standard ? earliest : standard;
}

/** Set this branch's last booking day for the month (owner 2026-10-18: each branch closes on its own date). Only while
 *  booking is open — the day cannot be in the past or after the month's last day. */
export function setBookingCloseDate(args: { branchId: number; yearMonth: string; date: string; actorId: number; asOf?: string }): DutyMonth {
  const { branchId, yearMonth, date, actorId } = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SpecialDutyError("invalid_date");
  const cur = getMonth(branchId, yearMonth);
  if (!cur.enabled || cur.status !== "booking_open") throw new SpecialDutyError("invalid_transition", "booking is not open");
  if (date < (args.asOf ?? bkkToday())) throw new SpecialDutyError("invalid_date", "the closing day cannot be in the past");
  if (date > `${yearMonth}-${String(daysInMonth(yearMonth)).padStart(2, "0")}`) throw new SpecialDutyError("invalid_date", "booking must close within the month");
  getDb().prepare("UPDATE special_duty_months SET booking_close_date = ? WHERE branch_id = ? AND year_month = ?").run(date, branchId, yearMonth);
  audit({ actorId, branchId, yearMonth, entity: "month", entityId: `${branchId}:${yearMonth}`, action: "set_close_date", before: cur.bookingCloseDate, after: date });
  return getMonth(branchId, yearMonth);
}

/** Owner switches the scheme on for one branch + month. Positions are copied from the
 *  branch's most recent configured month when this month has none yet. */
export function enableMonth(args: { branchId: number; yearMonth: string; actorId: number; asOf?: string }): DutyMonth {
  const { branchId, yearMonth, actorId } = args;
  if (!isMonth(yearMonth)) throw new SpecialDutyError("invalid_month");
  const db = getDb();
  const cur = getMonth(branchId, yearMonth);
  if (cur.status === "settled") throw new SpecialDutyError("month_settled");
  if (cur.enabled) return cur;
  if (yearMonth < (args.asOf ?? bkkToday()).slice(0, 7)) throw new SpecialDutyError("month_in_past", "a past month cannot be switched on");
  const pub = getLastPublish(branchId, yearMonth);
  const published = !!pub && !!db.prepare("SELECT 1 FROM roster_publish_log WHERE branch_id = ? AND year_month = ? AND kind = 'publish'").get(branchId, yearMonth);
  const status: DutyMonthStatus = published ? "booking_open" : "awaiting_roster";
  const close = bookingCloseDateFor(yearMonth, published ? new Date().toISOString() : null, branchId);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO special_duty_months (branch_id, year_month, enabled, status, booking_close_date, booking_opened_at)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(branch_id, year_month) DO UPDATE SET enabled = 1, status = excluded.status,
        booking_close_date = excluded.booking_close_date, booking_opened_at = excluded.booking_opened_at
    `).run(branchId, yearMonth, status, close, published ? new Date().toISOString() : null);
    const has = db.prepare("SELECT 1 FROM special_duty_positions WHERE branch_id = ? AND year_month = ? LIMIT 1").get(branchId, yearMonth);
    if (!has) {
      const src = db.prepare("SELECT MAX(year_month) AS m FROM special_duty_positions WHERE branch_id = ? AND year_month < ?")
        .get(branchId, yearMonth) as { m: string | null };
      if (src.m) {
        db.prepare(`
          INSERT INTO special_duty_positions (branch_id, year_month, slot_no, name, description, daily_rate, eligible_groups, active)
          SELECT branch_id, ?, slot_no, name, description, daily_rate, eligible_groups, active
            FROM special_duty_positions WHERE branch_id = ? AND year_month = ?
        `).run(yearMonth, branchId, src.m);
      }
    }
  })();
  audit({ actorId, branchId, yearMonth, entity: "month", entityId: `${branchId}:${yearMonth}`, action: "enable", before: cur.status, after: status });
  return getMonth(branchId, yearMonth);
}

/** Switch a month off again. Refused once anyone has booked or been assigned (the data
 *  would be stranded); settled months are never touched. */
export function disableMonth(args: { branchId: number; yearMonth: string; actorId: number }): DutyMonth {
  const { branchId, yearMonth, actorId } = args;
  const db = getDb();
  const cur = getMonth(branchId, yearMonth);
  if (cur.status === "settled") throw new SpecialDutyError("month_settled");
  if (!cur.enabled) return cur;
  const hasDays = tableExists("special_duty_days") && db.prepare(`
    SELECT 1 FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE p.branch_id = ? AND p.year_month = ? LIMIT 1
  `).get(branchId, yearMonth);
  if (hasDays) throw new SpecialDutyError("has_bookings", "bookings or assignments already exist for this month");
  db.prepare("UPDATE special_duty_months SET enabled = 0, status = 'off' WHERE branch_id = ? AND year_month = ?").run(branchId, yearMonth);
  audit({ actorId, branchId, yearMonth, entity: "month", entityId: `${branchId}:${yearMonth}`, action: "disable", before: cur.status, after: "off" });
  return getMonth(branchId, yearMonth);
}

function tableExists(name: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Move a month along its fixed order. Callers (publish hook, cron, manager actions)
 *  use this so a status can never skip a step or go backwards. */
const ORDER: DutyMonthStatus[] = ["off", "awaiting_roster", "booking_open", "booking_closed", "filling", "special_published", "in_progress", "settled"];
export function advanceMonth(args: { branchId: number; yearMonth: string; to: DutyMonthStatus; actorId: number | null }): DutyMonth {
  const cur = getMonth(args.branchId, args.yearMonth);
  if (!cur.enabled) throw new SpecialDutyError("month_off");
  if (ORDER.indexOf(args.to) !== ORDER.indexOf(cur.status) + 1) throw new SpecialDutyError("invalid_transition", `${cur.status} -> ${args.to}`);
  const now = new Date().toISOString();
  const extra = args.to === "booking_open" ? ", booking_opened_at = ?" : args.to === "special_published" ? ", special_published_at = ?" : args.to === "settled" ? ", settled_at = ?" : "";
  const params: unknown[] = [args.to];
  if (extra) params.push(now);
  params.push(args.branchId, args.yearMonth);
  getDb().prepare(`UPDATE special_duty_months SET status = ?${extra} WHERE branch_id = ? AND year_month = ?`).run(...params);
  audit({ actorId: args.actorId, branchId: args.branchId, yearMonth: args.yearMonth, entity: "month", entityId: `${args.branchId}:${args.yearMonth}`, action: "advance", before: cur.status, after: args.to });
  return getMonth(args.branchId, args.yearMonth);
}

// ── positions (monthly snapshot, at most 3) ───────────────────────────────

export type DutyPosition = {
  id: number; branchId: number; yearMonth: string; slotNo: number; name: string; description: string | null;
  dailyRate: number; eligibleGroups: WorkGroup[] | null; active: boolean;
};
type PosRow = { id: number; branch_id: number; year_month: string; slot_no: number; name: string; description: string | null; daily_rate: number; eligible_groups: string | null; active: number };
const shapePos = (r: PosRow): DutyPosition => ({
  id: r.id, branchId: r.branch_id, yearMonth: r.year_month, slotNo: r.slot_no, name: r.name, description: r.description,
  dailyRate: r.daily_rate, eligibleGroups: r.eligible_groups ? (JSON.parse(r.eligible_groups) as WorkGroup[]) : null, active: !!r.active
});

export function listPositions(branchId: number, yearMonth: string, opts: { activeOnly?: boolean } = {}): DutyPosition[] {
  return (getDb().prepare(`SELECT * FROM special_duty_positions WHERE branch_id = ? AND year_month = ? ${opts.activeOnly ? "AND active = 1" : ""} ORDER BY slot_no`)
    .all(branchId, yearMonth) as PosRow[]).map(shapePos);
}

/** Positions can be edited only while the month has not opened for booking: once people
 *  have seen a rate and booked against it, changing it would break what they agreed to. */
const EDITABLE: DutyMonthStatus[] = ["off", "awaiting_roster"];

export function savePosition(args: {
  branchId: number; yearMonth: string; slotNo: number; actorId: number;
  name: string; description?: string | null; dailyRate?: number; eligibleGroups?: WorkGroup[] | null; active?: boolean; asOf?: string;
}): DutyPosition {
  const { branchId, yearMonth, slotNo, actorId } = args;
  if (!isMonth(yearMonth)) throw new SpecialDutyError("invalid_month");
  if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > cfgNum("max_positions_per_branch", args.branchId)) throw new SpecialDutyError("slot_out_of_range", "a branch has at most 3 positions");
  const name = args.name.trim();
  if (!name) throw new SpecialDutyError("name_required");
  const rate = args.dailyRate ?? cfgNum("default_daily_rate", args.branchId);
  if (!Number.isFinite(rate) || rate < 0) throw new SpecialDutyError("invalid_rate");
  if (args.eligibleGroups) for (const g of args.eligibleGroups) if (!WORK_GROUPS.includes(g)) throw new SpecialDutyError("invalid_group");
  const month = getMonth(branchId, yearMonth);
  if (!EDITABLE.includes(month.status)) throw new SpecialDutyError("positions_locked", "the month is already open for booking or beyond");
  if (yearMonth < (args.asOf ?? bkkToday()).slice(0, 7)) throw new SpecialDutyError("month_in_past");
  const db = getDb();
  const before = db.prepare("SELECT * FROM special_duty_positions WHERE branch_id = ? AND year_month = ? AND slot_no = ?").get(branchId, yearMonth, slotNo) as PosRow | undefined;
  const groups = args.eligibleGroups && args.eligibleGroups.length ? JSON.stringify([...new Set(args.eligibleGroups)]) : null;
  const active = args.active === undefined ? 1 : args.active ? 1 : 0;
  if (before) {
    db.prepare("UPDATE special_duty_positions SET name = ?, description = ?, daily_rate = ?, eligible_groups = ?, active = ? WHERE id = ?")
      .run(name, args.description?.trim() || null, rate, groups, active, before.id);
  } else {
    db.prepare("INSERT INTO special_duty_positions (branch_id, year_month, slot_no, name, description, daily_rate, eligible_groups, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(branchId, yearMonth, slotNo, name, args.description?.trim() || null, rate, groups, active);
  }
  const after = db.prepare("SELECT * FROM special_duty_positions WHERE branch_id = ? AND year_month = ? AND slot_no = ?").get(branchId, yearMonth, slotNo) as PosRow;
  audit({ actorId, branchId, yearMonth, entity: "position", entityId: after.id, action: before ? "update" : "create", before: before ? shapePos(before) : undefined, after: shapePos(after) });
  return shapePos(after);
}

// ── budget ────────────────────────────────────────────────────────────────

/** Budget for a branch + month = Σ (days in the month × daily rate) over the active
 *  positions. A month that is off has a budget of zero. */
export function monthBudget(branchId: number, yearMonth: string): number {
  if (!isEnabled(branchId, yearMonth)) return 0;
  const days = daysInMonth(yearMonth);
  return round2(listPositions(branchId, yearMonth, { activeOnly: true }).reduce((s, p) => s + days * p.dailyRate, 0));
}
