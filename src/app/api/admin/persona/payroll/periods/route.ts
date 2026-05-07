import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computePayrollPeriod } from "@/lib/payroll-compute";

// POST /api/admin/persona/payroll/periods — create a new period (and compute immediately)
const Body = z.object({
  cycle: z.enum(["weekly", "monthly"]),
  target: z.enum(["pt", "ft", "all"]).default("all"),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.period_end < d.period_start) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  // Default pay_date = next Monday after period_end (weekly) or last day (monthly)
  const payDate = d.pay_date ?? defaultPayDate(d.period_end, d.cycle);

  const db = getDb();
  // Check for duplicate (cycle + target + dates uniquely identifies a period)
  const dup = db.prepare(`
    SELECT id FROM payroll_periods
    WHERE cycle = ? AND target = ? AND period_start = ? AND period_end = ?
  `).get(d.cycle, d.target, d.period_start, d.period_end);
  if (dup) {
    return NextResponse.json({ error: "duplicate_period" }, { status: 409 });
  }

  const result = db.prepare(`
    INSERT INTO payroll_periods
      (cycle, target, period_start, period_end, pay_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(d.cycle, d.target, d.period_start, d.period_end, payDate, d.notes ?? null, user.id);
  const periodId = result.lastInsertRowid as number;

  // Compute immediately
  try {
    const r = computePayrollPeriod(db, periodId);
    db.prepare(`
      UPDATE payroll_periods SET computed_by = ? WHERE id = ?
    `).run(user.id, periodId);
    return NextResponse.json({ ok: true, period_id: periodId, computed: r.computed });
  } catch (e) {
    return NextResponse.json({
      ok: true, period_id: periodId, warning: "compute_failed",
      detail: (e as Error).message
    });
  }
}

function defaultPayDate(periodEnd: string, cycle: "weekly" | "monthly"): string {
  if (cycle === "weekly") {
    // Next Monday after period_end
    const d = new Date(`${periodEnd}T00:00:00Z`);
    do {
      d.setUTCDate(d.getUTCDate() + 1);
    } while (d.getUTCDay() !== 1);
    return d.toISOString().slice(0, 10);
  }
  // monthly: pay on last day of month (= period_end if it's the last day)
  return periodEnd;
}
