import { NextResponse } from "next/server";
import { requirePermission, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branchTodayCol } from "@/lib/daily-col";
import { isClinicaBranch } from "@/lib/clinica-db";
import { clinicaMonth } from "@/lib/clinica-analytics";
import { isSalesaBranch, listMonth, getLineGroupId, weeklySentAt, getMonthlyTarget, monthlySentAt, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { dailyAnalytics, weeklyAnalytics, monthlyAnalytics, monthComparison, weekdayStats, targetProgress, insightRangeFor, insightBundle, annualProjection, festivalAnalysis, annualBranchBars, annualBranchDailyBars, revshareIncomeForBranch, applyRevshareToTarget, remainingMonthOutlook, composeExpenseAnalysis } from "@/lib/salesa-analytics";
import { expenseCategoryTotals, expenseAccrualTotal } from "@/lib/accounta-db";
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

  // Full-year per-branch growth bars (owner 2026-09-21) — same role scoping.
  if (sp.get("yearbars") != null) {
    const todayIsoY = todayBkkIso();
    const yy = Number(sp.get("year")) || bkkNow().year;
    const allowed = user.role === "super_admin" ? null : [branchId];
    return NextResponse.json({ ok: true, yearbars: annualBranchBars(yy, todayIsoY, allowed) });
  }

  // Full-year per-branch DAILY bars (owner 2026-09-21) — ~365 bars, same scoping.
  if (sp.get("dailybars") != null) {
    const todayIsoD = todayBkkIso();
    const dy = Number(sp.get("year")) || bkkNow().year;
    const allowed = user.role === "super_admin" ? null : [branchId];
    return NextResponse.json({ ok: true, dailybars: annualBranchDailyBars(dy, todayIsoD, allowed) });
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
  // ส่วนแบ่งยอดขาย (RevShare) settled this month — folded into the target like the
  // monthly total (owner 2026-09-23), added flat so it isn't run-rate-annualized.
  const revshareIncome = revshareIncomeForBranch(branchId, year, month);
  const target = getMonthlyTarget(branchId);
  const tp = target != null ? targetProgress(target, monthCompare.mtdNett, monthCompare.throughDay, year, month) : null;
  const monthTarget = tp ? applyRevshareToTarget(tp, revshareIncome) : null;
  const ymKey = `${year}-${String(month).padStart(2, "0")}`;
  const monthSentAt = monthlySentAt(branchId, ymKey);
  // Clinic monthly report has its own sent-marker (prefixed key), independent of
  // the restaurant monthly card (owner 2026-09-26).
  const clinicaSentAt = monthlySentAt(branchId, `clinica:${ymKey}`);
  const annual = annualProjection(branchId, todayIso);  // full-year (monthly×12) projection
  // Insight panels (channels / discount / marketing / receipt) can be viewed for
  // this month or the current ISO week (owner 2026-09-18). The top MTD/target/
  // weekday cards stay month-level.
  const period = sp.get("period") === "week" ? "week" : "month";
  const range = insightRangeFor(period, year, month, todayIso);
  const bundle = insightBundle(branchId, range);
  const { range: _range, channels, discount, ...insights } = bundle;
  void _range;
  // Remaining-days-of-month outlook (owner 2026-09-26) — only meaningful for the
  // current month (it projects the days still to come vs prior periods).
  const remainingOutlook = (year === now.year && month === now.month)
    ? remainingMonthOutlook(branchId, todayIso)
    : null;
  // Today's COL snapshot (owner 2026-09-26) — payroll-derived, so only for
  // payroll-view accounts; shown on the current-month view only (it's "today").
  const todayCol = (year === now.year && month === now.month && userCanViewPayroll(user))
    ? branchTodayCol(branchId, todayIso)
    : null;
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

  // Expense analysis from ACCOUNTA (owner 2026-09-26) — the viewed month's
  // confirmed spend beside POS sales: MoM change, cost/sales ratio, and the
  // biggest categories. Uses SALESA nett (this module's own sales figure) as
  // the denominator, not ACCOUNTA's income side.
  const mm = String(month).padStart(2, "0");
  const monthStr = `${year}-${mm}`;
  const pmY = month === 1 ? year - 1 : year;
  const pmM = month === 1 ? 12 : month - 1;
  const prevMonthStr = `${pmY}-${String(pmM).padStart(2, "0")}`;
  const salesNettMonth = days.filter((d) => d.hasSales).reduce((s, d) => s + d.nett, 0);
  const et = expenseCategoryTotals(monthStr, branchId);   // one grouped query: total + by-category
  const expenseAnalysis = composeExpenseAnalysis({
    month: monthStr,
    salesNett: salesNettMonth,
    expenseTotal: et.total,
    expensePrev: expenseAccrualTotal(prevMonthStr, branchId),
    categorySpends: et.byCategory
  });

  // Clinic (CLINICA) analytics for the viewed month — only for a branch that has
  // imported HIS data (owner 2026-09-26).
  const clinica = isClinicaBranch(branchId) ? clinicaMonth(branchId, year, month, todayIso, target) : null;

  return NextResponse.json({ ok: true, branchName: name, hasLineGroup, cardColor, view: { year, month, days }, monthCompare, weekdays, discount, channels, monthTarget, monthSentAt, clinicaSentAt, annual, revshareIncome, insights, insightRange: range, remainingOutlook, expenseAnalysis, todayCol, clinica });
}
