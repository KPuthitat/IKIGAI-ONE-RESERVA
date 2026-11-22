// Corporate Goal 2027 monitor — phase 1 (owner 2026-11-22). Sales against the monthly targets, per branch and
// for the company, summarised every Monday to the executive LINE group(s). All numbers come from the database;
// the owl only delivers them.
//
// Sales definition (goal document §1.2): before VAT and before service charge, i.e. Gross − discount from the
// Feedme daily import (salesa_daily: gross + discount, where discount is stored negative). The page shows the
// 2026 back-test of this definition against the document's baseline so a mismatch is visible, not hidden.

import { getDb } from "./db";
import { getMonthlyTargetFor, setMonthlyTargetFor } from "./salesa-db";
import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";

export const GOAL_YEAR = 2027;

/** Provisional 2027 plan from the goal document §1.4.2: sales base after calendar and price (≈17.2M).
 *  Spread by open days until the seasonality index of section 2 replaces it. Matched to branches by name. */
export const GOAL_PLAN: Array<{ key: string; label: string; match: RegExp; annual: number; closed: string[] }> = [
  { key: "nama", label: "Nama", match: /nama/i, annual: 7_400_000, closed: ["2027-01-01", "2027-12-29", "2027-12-30", "2027-12-31"] },
  { key: "hypo", label: "Hypo", match: /hypo/i, annual: 9_800_000, closed: ["2027-01-01", "2027-01-02", "2027-01-03", "2027-12-31"] }
];

export const BASELINE_2026 = { nama: { label: "Nama ม.ค.–ต.ค. 2026", from: "2026-01-01", to: "2026-10-31", doc: 6_000_000 }, hypo: { label: "Hypo 25 ก.ค.–31 ต.ค. 2026", from: "2026-07-25", to: "2026-10-31", doc: 2_180_000 } };

export const daysInMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

type BranchRow = { id: number; name: string };
export function goalBranches(): Array<{ id: number; name: string; plan: (typeof GOAL_PLAN)[number] }> {
  const rows = getDb().prepare("SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name").all() as BranchRow[];
  const out: Array<{ id: number; name: string; plan: (typeof GOAL_PLAN)[number] }> = [];
  for (const plan of GOAL_PLAN) { const b = rows.find((r) => plan.match.test(r.name)); if (b) out.push({ id: b.id, name: b.name, plan }); }
  return out;
}

/** Provisional monthly split of an annual figure by open days, rounded to 100 baht, the remainder on the last month. */
export function monthlySplit(annual: number, year: number, closed: string[]): number[] {
  const open = Array.from({ length: 12 }, (_, i) => { const ym = `${year}-${String(i + 1).padStart(2, "0")}`; return daysInMonth(ym) - closed.filter((c) => c.startsWith(ym)).length; });
  const total = open.reduce((s, x) => s + x, 0);
  const parts = open.map((d) => Math.round((annual * d) / total / 100) * 100);
  parts[11] += annual - parts.reduce((s, x) => s + x, 0);
  return parts;
}

/** Writes the provisional 2027 targets. Existing figures are replaced only when `overwrite` is true. */
export function seedGoalTargets(overwrite: boolean): Array<{ branch: string; months: number }> {
  const out: Array<{ branch: string; months: number }> = [];
  for (const b of goalBranches()) {
    const parts = monthlySplit(b.plan.annual, GOAL_YEAR, b.plan.closed);
    let n = 0;
    parts.forEach((t, i) => {
      const ym = `${GOAL_YEAR}-${String(i + 1).padStart(2, "0")}`;
      const has = !!getDb().prepare("SELECT 1 FROM salesa_monthly_targets WHERE branch_id = ? AND ym = ? AND target > 0").get(b.id, ym);
      if (has && !overwrite) return;
      setMonthlyTargetFor(b.id, ym, t); n++;
    });
    out.push({ branch: b.name, months: n });
  }
  return out;
}

// ── sales ────────────────────────────────────────────────────────────────

/** Gross − discount (before VAT and service charge) from the Feedme import. */
export function goalSales(branchId: number, from: string, to: string): number {
  const r = getDb().prepare("SELECT COALESCE(SUM(gross + discount), 0) AS s FROM salesa_daily WHERE branch_id = ? AND sale_date BETWEEN ? AND ?").get(branchId, from, to) as { s: number };
  return Math.round(r.s * 100) / 100;
}

/** The candidate definitions side by side, for the back-test. */
export function salesMeasures(branchId: number, from: string, to: string) {
  const r = getDb().prepare(`SELECT COALESCE(SUM(gross + discount),0) AS grossLessDiscount, COALESCE(SUM(nett),0) AS nett,
      COALESCE(SUM(nett - vat - service_charge),0) AS nettLessVatSc, COALESCE(SUM(gross),0) AS gross, COUNT(*) AS days
      FROM salesa_daily WHERE branch_id = ? AND sale_date BETWEEN ? AND ?`).get(branchId, from, to) as { grossLessDiscount: number; nett: number; nettLessVatSc: number; gross: number; days: number };
  return r;
}

export type BranchWeek = {
  branchId: number; name: string; label: string;
  weekSales: number; prevWeekSales: number;
  month: string; mtd: number; target: number | null; pctOfTarget: number | null;
  elapsedDays: number; dim: number; forecast: number | null; forecastPct: number | null; pacePct: number | null;
};
export type WeeklyDigest = { weekFrom: string; weekTo: string; month: string; branches: BranchWeek[]; total: { weekSales: number; prevWeekSales: number; mtd: number; target: number | null; forecast: number | null } };

/** The Monday–Sunday week that ended just before `today` (a Monday), and the month it ended in, to date. */
export function buildWeeklyDigest(today: string): WeeklyDigest {
  const weekTo = addDays(today, -1);                // the Sunday before
  const weekFrom = addDays(weekTo, -6);
  const month = weekTo.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const dim = daysInMonth(month);
  const elapsed = Number(weekTo.slice(8, 10));
  const branches: BranchWeek[] = goalBranches().map((b) => {
    const weekSales = goalSales(b.id, weekFrom, weekTo);
    const prevWeekSales = goalSales(b.id, addDays(weekFrom, -7), addDays(weekTo, -7));
    const mtd = goalSales(b.id, `${month}-01`, weekTo);
    const target = getMonthlyTargetFor(b.id, y, m);
    const forecast = elapsed > 0 ? Math.round((mtd / elapsed) * dim) : null;
    return {
      branchId: b.id, name: b.name, label: b.plan.label, weekSales, prevWeekSales, month, mtd, target,
      pctOfTarget: target ? Math.round((mtd / target) * 100) : null, elapsedDays: elapsed, dim, forecast,
      forecastPct: target && forecast != null ? Math.round((forecast / target) * 100) : null,
      pacePct: target ? Math.round((mtd / (target * (elapsed / dim))) * 100) : null
    };
  });
  const sum = (f: (b: BranchWeek) => number) => branches.reduce((s, b) => s + f(b), 0);
  const allTargets = branches.every((b) => b.target != null);
  return { weekFrom, weekTo, month, branches, total: {
    weekSales: sum((b) => b.weekSales), prevWeekSales: sum((b) => b.prevWeekSales), mtd: sum((b) => b.mtd),
    target: allTargets && branches.length ? sum((b) => b.target ?? 0) : null,
    forecast: branches.every((b) => b.forecast != null) && branches.length ? sum((b) => b.forecast ?? 0) : null
  } };
}

// ── LINE card ────────────────────────────────────────────────────────────

type Flex = { type: "flex"; altText: string; contents: unknown };
const baht = (n: number) => Math.round(n).toLocaleString("en-US");
const thDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd}/${m}/${y + 543}`; };
const pctColor = (p: number | null) => p == null ? "#64748b" : p >= 100 ? "#15803d" : p >= 90 ? "#b45309" : "#b91c1c";
const delta = (now: number, prev: number) => prev > 0 ? `${now >= prev ? "▲" : "▼"} ${Math.abs(Math.round(((now - prev) / prev) * 100))}% จากสัปดาห์ก่อน` : "";

export function digestFlex(d: WeeklyDigest): Flex {
  const rows = d.branches.flatMap((b) => [
    { type: "text", text: b.label, weight: "bold", size: "md", color: "#1a1a2e", margin: "lg" },
    { type: "text", text: `สัปดาห์นี้ ${baht(b.weekSales)} บาท ${delta(b.weekSales, b.prevWeekSales)}`.trim(), size: "sm", color: "#334155", wrap: true },
    { type: "text", text: `สะสมเดือนนี้ ${baht(b.mtd)}${b.target ? ` จากเป้า ${baht(b.target)} (${b.pctOfTarget}%)` : " (ยังไม่ได้ตั้งเป้า)"}`, size: "sm", color: "#334155", wrap: true },
    ...(b.target ? [{ type: "text", text: `คาดสิ้นเดือน ${b.forecast == null ? "-" : baht(b.forecast)} (${b.forecastPct ?? "-"}% ของเป้า) · เทียบจังหวะ ${b.pacePct}%`, size: "sm", weight: "bold", color: pctColor(b.forecastPct), wrap: true }] : [])
  ]);
  const t = d.total;
  return {
    type: "flex", altText: `สรุปยอดขายรายสัปดาห์ ${thDate(d.weekFrom)}–${thDate(d.weekTo)}`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#1F2547", paddingAll: "18px", contents: [
        { type: "text", text: "NOKHOOK OS · เป้าหมายองค์กร", color: "#33C6B5", size: "xxs", weight: "bold" },
        { type: "text", text: `สรุปยอดขายรายสัปดาห์`, color: "#ffffff", size: "lg", weight: "bold", margin: "md" },
        { type: "text", text: `${thDate(d.weekFrom)} – ${thDate(d.weekTo)}`, color: "#ffffffcc", size: "xs", margin: "sm" } ] },
      body: { type: "box", layout: "vertical", paddingAll: "18px", contents: [
        { type: "text", text: `รวมสัปดาห์นี้ ${baht(t.weekSales)} บาท ${delta(t.weekSales, t.prevWeekSales)}`.trim(), size: "md", weight: "bold", color: "#1a1a2e", wrap: true },
        ...(t.target ? [{ type: "text", text: `รวมสะสมเดือนนี้ ${baht(t.mtd)} จากเป้า ${baht(t.target)} บาท`, size: "sm", color: "#334155", wrap: true }] : []),
        ...rows,
        { type: "separator", margin: "lg" },
        { type: "text", text: "ยอดขายก่อน VAT และก่อน Service charge (Gross − ส่วนลด) ตามนิยามในเอกสารเป้าหมาย · คาดสิ้นเดือนคิดจากค่าเฉลี่ยต่อวัน", size: "xxs", color: "#94a3b8", wrap: true, margin: "md" } ] }
    }
  };
}

// ── sending ──────────────────────────────────────────────────────────────

export const getState = (key: string): string | null => (getDb().prepare("SELECT value FROM corporate_goal_state WHERE key = ?").get(key) as { value: string | null } | undefined)?.value ?? null;
export function setState(key: string, value: string | null): void {
  getDb().prepare("INSERT INTO corporate_goal_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(key, value);
}
export const execGroups = (): string[] => (getDb().prepare("SELECT group_id FROM owl_secretary_groups").all() as Array<{ group_id: string }>).map((r) => r.group_id);

export type PushFn = (groupId: string, flex: Flex) => Promise<boolean>;
const defaultPush: PushFn = async (groupId, flex) => {
  const token = getPlatformChannel()?.channel_token?.trim();
  if (!token) return false;
  return (await sendLinePush(token, { to: groupId, messages: [flex] })).ok;
};

/** Sends the digest for the week before `today` to every enabled executive group. */
export async function sendWeeklyDigest(today: string, push: PushFn = defaultPush): Promise<{ groups: number; sent: number; noTargets: boolean }> {
  const d = buildWeeklyDigest(today);
  const groups = execGroups();
  let sent = 0;
  for (const g of groups) { try { if (await push(g, digestFlex(d))) sent++; } catch (e) { console.warn("[goal] push failed", e); } }
  return { groups: groups.length, sent, noTargets: d.branches.length === 0 || d.branches.every((b) => b.target == null) };
}

/** Cron entry: Mondays from 08:00 Bangkok, once per week, only when the owner switched the weekly digest on. */
export async function runGoalDigestWeekly(a: { today: string; hhmm: string; push?: PushFn }): Promise<{ sent: number } | null> {
  if (getState("weekly_enabled") !== "1") return null;
  if (new Date(`${a.today}T00:00:00Z`).getUTCDay() !== 1 || a.hhmm < "08:00") return null;
  const key = `sent:weekly:${a.today}`;
  if (getState(key)) return null;
  const r = await sendWeeklyDigest(a.today, a.push);
  if (r.groups === 0 || r.sent > 0) setState(key, new Date().toISOString());   // retry later only when a group should have got it and none did
  return { sent: r.sent };
}
