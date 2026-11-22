import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { addDays, BASELINE_2026, buildWeeklyDigest, execGroups, getState, GOAL_PLAN, GOAL_YEAR, goalBranches, monthlySplit, salesMeasures } from "@/lib/corporate-goal";
import Client from "./Client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เป้าหมายองค์กร 2027 · NOKHOOK OS" };

export default function GoalPage() {
  requireSuperAdmin();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));   // this week's Monday → digest covers last week
  const db = getDb();
  const branches = goalBranches();
  const targets = branches.map((b) => ({
    name: b.name, label: b.plan.label, annual: b.plan.annual,
    provisional: monthlySplit(b.plan.annual, GOAL_YEAR, b.plan.closed),
    current: Array.from({ length: 12 }, (_, i) => {
      const r = db.prepare("SELECT target FROM salesa_monthly_targets WHERE branch_id = ? AND ym = ?").get(b.id, `${GOAL_YEAR}-${String(i + 1).padStart(2, "0")}`) as { target: number } | undefined;
      return r?.target ?? null;
    })
  }));
  const backtest = branches.map((b) => {
    const base = b.plan.key === "nama" ? BASELINE_2026.nama : BASELINE_2026.hypo;
    return { label: base.label, doc: base.doc, ...salesMeasures(b.id, base.from, base.to) };
  });
  return <Client
    unmatched={GOAL_PLAN.filter((p) => !branches.some((b) => b.plan.key === p.key)).map((p) => p.label)}
    targets={targets} backtest={backtest} digest={buildWeeklyDigest(monday)} monday={monday}
    groups={execGroups().length} weeklyEnabled={getState("weekly_enabled") === "1"} year={GOAL_YEAR} />;
}
