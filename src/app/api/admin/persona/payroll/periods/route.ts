import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computePayrollPeriod } from "@/lib/payroll-compute";

// POST /api/admin/persona/payroll/periods — create a new period (and compute immediately)
const Body = z.object({
  cycle: z.enum(["weekly", "monthly"]),
  target: z.enum(["pt", "ft", "all"]).default("all"),
  data_source: z.enum(["auto", "manual"]).default("auto"),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(500).optional(),
  // For periods whose pay_date is still in the future, the admin must
  // supply their own 4-digit PIN (verified against users.pin_hash) plus
  // a reason. Both are saved to payroll_period_unlocks for audit.
  force_open_pin: z.string().regex(/^\d{4,12}$/).optional(),
  force_open_reason: z.string().max(500).optional()
});

function todayBkk(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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

  // Future-period gate: if pay_date is in the future, require the user's
  // own PIN + a reason. Verify against users.pin_hash and log to audit.
  const isFuture = payDate > todayBkk();
  if (isFuture) {
    if (!d.force_open_pin) {
      return NextResponse.json({ error: "future_pin_required" }, { status: 400 });
    }
    if (!d.force_open_reason || !d.force_open_reason.trim()) {
      return NextResponse.json({ error: "future_reason_required" }, { status: 400 });
    }
    const me = db.prepare(`SELECT pin_hash FROM users WHERE id = ?`).get(user.id) as
      { pin_hash: string | null } | undefined;
    if (!me?.pin_hash) {
      return NextResponse.json({ error: "user_pin_not_set" }, { status: 400 });
    }
    if (!bcrypt.compareSync(d.force_open_pin, me.pin_hash)) {
      return NextResponse.json({ error: "pin_invalid" }, { status: 401 });
    }
  }

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
      (cycle, target, data_source, period_start, period_end, pay_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.cycle, d.target, d.data_source,
    d.period_start, d.period_end, payDate, d.notes ?? null, user.id
  );
  const periodId = result.lastInsertRowid as number;

  // Log the force-open event so admins can audit who opened the period early
  if (isFuture) {
    db.prepare(`
      INSERT INTO payroll_period_unlocks (period_id, unlocked_by, reason, action)
      VALUES (?, ?, ?, 'force_open')
    `).run(periodId, user.id, (d.force_open_reason ?? "").trim());
  }

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
  // Monthly: pay on the 5th of the following month (per company policy)
  const [y, m] = periodEnd.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-05`;
}
