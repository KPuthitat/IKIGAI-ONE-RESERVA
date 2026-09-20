import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch, listMonth, getLineGroupId, weeklySentAt, getMonthlyTarget, monthlySentAt, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { dailyAnalytics, weeklyAnalytics, monthlyAnalytics, monthComparison, weekdayStats, targetProgress, insightRangeFor, insightBundle, annualProjection, festivalAnalysis } from "@/lib/salesa-analytics";
import { salesPushPlan } from "@/lib/salesa-push";

// REPORTA read view. Default: a month's daily rows (list). ?date=YYYY-MM-DD: one
// day's full analytics + menu ranking. ?week=YYYY-MM-DD (a Monday): the weekly
// rollup. ?monthly=YYYY-MM: the whole-month rollup (card preview). Owner 2026-09.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;

function branchName(branchId: number): string {
  const r = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  return r?.name ?? `สาขา #${branchId}`;
}
function bkkNow(): { year: number; month: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function todayBkkIso(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function GET(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const name = branchName(branchId);
  const hasLineGroup = !!getLineGroupId(branchId);
  const cardColor = getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR;

  // Festival / important-day analysis (owner 2026-09-20) — cross-branch for
  // super_admin, active branch only otherwise. Read-only; scoped by role.
  if (sp.get("festivals") != null) {
    const todayIsoF = todayBkkIso();
    const fy = Number(sp.get("year")) || bkkNow().year;
    const allowed = user.role === "super_admin" ? null : [branchId];
    return NextResponse.json({ ok: true, festivals: festivalAnalysis(fy, todayIsoF, allowed) });
  }

  const date = sp.get("date") ?? "";
  if (ISO.test(date)) {
    const daily = dailyAnalytics(branchId, date);
    if (!daily) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, daily });
  }

  const week = sp.get("week") ?? "";
  if (ISO.test(week)) {
    const weekly = weeklyAnalytics(branchId, week);
    return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, weekly, weeklySentAt: weeklySentAt(branchId, weekly.weekStart) });
  }

  const monthly = sp.get("monthly") ?? "";
  if (YM.test(monthly)) {
    const [my, mm] = monthly.split("-").map(Number);
    return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, monthly: monthlyAnalytics(branchId, my, mm) });
  }

  // แผนดันยอด (owner 2026-09-18): น้องฮูก plans a short-horizon target.
  if (sp.get("push") != null) {
    const todayIsoP = todayBkkIso();
    const days = Math.min(31, Math.max(1, Math.floor(Number(sp.get("days")) || 0)));
    const target = Math.max(0, Math.floor(Number(sp.get("target")) || 0));
    if (!days || !target) return NextResponse.json({ error: "bad_input", message: "ระบุจำนวนวันและยอดเป้าหมาย" }, { status: 400 });
    return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, plan: salesPushPlan(branchId, target, days, todayIsoP) });
  }

  const now = bkkNow();
  const year = Number(sp.get("year")) || now.year;
  const month = Number(sp.get("month")) || now.month;
  const todayIso = todayBkkIso();
  const monthCompare = monthComparison(branchId, year, month, todayIso);
  // Weekday pattern reflects data up to the viewed month (today for the current
  // month, else that month's end).
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  const refIso = todayIso < monthEnd ? todayIso : monthEnd;
  const weekdays = weekdayStats(branchId, refIso);
  const target = getMonthlyTarget(branchId);
  const monthTarget = target != null ? targetProgress(target, monthCompare.mtdNett, monthCompare.throughDay, year, month) : null;
  const monthSentAt = monthlySentAt(branchId, `${year}-${String(month).padStart(2, "0")}`);
  const annual = annualProjection(branchId, todayIso);  // full-year (monthly×12) projection
  // Insight panels (channels / discount / marketing / receipt) can be viewed for
  // this month or the current ISO week (owner 2026-09-18). The top MTD/target/
  // weekday cards stay month-level.
  const period = sp.get("period") === "week" ? "week" : "month";
  const range = insightRangeFor(period, year, month, todayIso);
  const bundle = insightBundle(branchId, range);
  const { range: _range, channels, discount, ...insights } = bundle;
  void _range;
  const days = listMonth(branchId, year, month).map((d) => ({
    date: d.sale_date,
    nett: d.nett,
    billCount: d.bill_count,
    pax: d.pax,
    hasSales: d.has_sales === 1,
    hasMenu: d.has_menu === 1,
    hasReceipt: d.has_receipt === 1,
    dailySentAt: d.daily_sent_at
  }));
  return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, view: { year, month, days }, monthCompare, weekdays, discount, channels, monthTarget, monthSentAt, annual, insights, insightRange: range });
}
