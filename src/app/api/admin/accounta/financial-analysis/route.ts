import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { rateLimit } from "@/lib/rate-limit";
import {
  ledgerDashboard, monthlyTrend, accountaPayables, cashAccountsTotal,
  materialPurchaseQuota
} from "@/lib/accounta-db";
import { salesTargetProgress } from "@/lib/sales-target";
import {
  streamFinancialAnalysis, financialAnalysisEnabled, FinAnalysisError,
  type FinancialSnapshot
} from "@/lib/financial-analysis";

// POST /api/admin/accounta/financial-analysis — assemble the branch's financial
// snapshot from the ledger (same numbers the daybook page shows) and ask Claude
// to write a CFO-style Thai analysis. On-demand button under the โควตาสั่งซื้อ card.
//
// Branch = the session's active branch (same gate as the daybook page); the
// client only chooses which period/anchor is on screen.

const Body = z.object({
  period: z.enum(["week", "month", "year"]),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId;
  if (branchId == null) {
    return NextResponse.json({ error: "no_branch", message: "กรุณาเลือกสาขาก่อน" }, { status: 400 });
  }

  if (!financialAnalysisEnabled()) {
    return NextResponse.json({ error: "disabled", message: "ฟีเจอร์ผู้ช่วย AI ปิดอยู่" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { period, anchor } = parsed.data;

  // Cost-bearing LLM call — cap per user (5/min).
  const rl = rateLimit(`fin-analysis:${user.id}`, 5, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limit", message: "เรียกใช้ถี่เกินไป รอสักครู่แล้วลองใหม่" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  try {
    // Assemble the same figures the daybook page renders, server-side.
    const dash = ledgerDashboard(branchId, period, anchor);
    const quotaToday = todayBkk();
    const monthDash = (period === "month" && anchor.slice(0, 7) === quotaToday.slice(0, 7))
      ? dash
      : ledgerDashboard(branchId, "month", quotaToday);
    const materialQuota = materialPurchaseQuota(branchId, quotaToday, monthDash.forecast, monthDash.salesRevenue);
    const salesTarget = salesTargetProgress(branchId, quotaToday, monthDash.salesRevenue);
    const payables = accountaPayables(branchId);
    const cashTotal = cashAccountsTotal(branchId);
    const trend = monthlyTrend(branchId, Number(anchor.slice(0, 4)));
    const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;

    const cogNowPct = materialQuota && materialQuota.salesToDate > 0
      ? (materialQuota.spentThisMonth / materialQuota.salesToDate) * 100
      : null;

    const snapshot: FinancialSnapshot = {
      branchName: branch?.name ?? `#${branchId}`,
      periodLabel: dash.label,
      periodKind: period,
      salesRevenue: dash.salesRevenue,
      financing: dash.financing,
      expense: dash.expense,
      net: dash.net,
      netMarginPct: dash.salesRevenue > 0 ? (dash.net / dash.salesRevenue) * 100 : null,
      inputVat: dash.inputVat,
      outputVat: dash.outputVat,
      vatPayable: dash.vatPayable,
      vatRegistered: dash.vatRegistered,
      forecast: dash.forecast,
      avgPerDay: dash.avgPerDay,
      daysWithRevenue: dash.daysWithRevenue,
      categories: dash.categories.map((c) => ({
        name: c.name, spent: c.spent, pct: c.pct,
        targetMin: c.targetMin, targetMax: c.targetMax, status: c.status
      })),
      uncategorized: dash.uncategorized,
      outstandingTotal: dash.outstandingTotal,
      topVendors: dash.byVendor.slice(0, 8).map((v) => ({ vendor: v.vendor, amount: v.amount })),
      salesTarget: {
        hasTarget: salesTarget.hasTarget,
        monthlyTarget: salesTarget.monthlyTarget,
        monthToDateSales: salesTarget.monthToDateSales,
        monthPct: salesTarget.monthPct
      },
      materialQuota: materialQuota ? {
        budgetPct: materialQuota.budgetPct,
        goalPct: materialQuota.goalPct,
        spentThisMonth: materialQuota.spentThisMonth,
        monthBudget: materialQuota.monthBudget,
        remainingBudget: materialQuota.remainingBudget,
        salesToDate: materialQuota.salesToDate,
        projectedMaterial: materialQuota.projectedMaterial,
        cogNowPct,
        reqSalesCeil: materialQuota.reqSalesCeil,
        reqSalesGoal: materialQuota.reqSalesGoal
      } : null,
      payables: {
        whtUnpaid: payables.whtUnpaid,
        ssoUnpaid: payables.ssoUnpaid,
        branchUnpaidTotal: payables.branchUnpaidTotal,
        branchUnpaidCount: payables.branchUnpaidCount
      },
      cashTotal,
      monthlyTrend: trend.map((m) => ({ month: m.month, revenue: m.revenue, expense: m.expense, profit: m.profit }))
    };

    // Stream the answer so it starts flowing well before Nginx's 60s
    // proxy_read_timeout — a non-streaming Opus call would time out (504 →
    // maintenance HTML → client can't parse it). FinAnalysisError is thrown
    // BEFORE the stream starts, so config/API errors still return clean JSON.
    const stream = await streamFinancialAnalysis(snapshot);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (e) {
    if (e instanceof FinAnalysisError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: "failed", message: "วิเคราะห์ไม่สำเร็จ" }, { status: 500 });
  }
}
