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
  // Create the period for EVERY branch in the admin's company at once
  // (owner 2026-07-27: สร้างรอบทุกสาขาทีเดียว), not just the active branch.
  all_branches: z.boolean().default(false),
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
  // Per-branch payroll (owner 2026-06-10): a period belongs to the
  // admin's active branch, so generation only pulls that branch's staff.
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.period_end < d.period_start) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  // FT weekly payroll is cancelled (owner 2026-06-09) — full-time staff are
  // paid monthly only. Weekly periods are PT-only.
  if (d.cycle === "weekly" && d.target === "ft") {
    return NextResponse.json({ error: "ft_weekly_disabled" }, { status: 400 });
  }

  // Default pay_date = next Monday after period_end (weekly) or last day (monthly)
  const payDate = d.pay_date ?? defaultPayDate(d.period_end, d.cycle);

  const db = getDb();

  // Future-period gate: block opening a period that isn't COMPLETE yet — keyed on
  // period_end, not pay_date (owner 2026-08-03: a finished month can be processed
  // immediately, no need to wait for the 5th). A period whose last day is still
  // today or later isn't done → requires the user's own PIN + a reason. A month
  // that has already ended opens freely even though its pay_date (the 5th) is ahead.
  const isFuture = d.period_end >= todayBkk();
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

  // ── สร้างทุกสาขา ── loop the company's branches, creating + computing a
  // period for each (owner 2026-07-27). Idempotent: a branch that already has
  // the period is skipped, not duplicated, so this doubles as a "fill the
  // branches I haven't generated yet" button. Each branch's compute scopes to
  // its own staff (period.branch_id), so pay lands per branch as always.
  if (d.all_branches) {
    const activeCompany = db.prepare(`SELECT company_id FROM branches WHERE id = ?`)
      .get(user.activeBranchId) as { company_id: number | null } | undefined;
    const branchRows = activeCompany?.company_id != null
      ? db.prepare(`SELECT id, name FROM branches WHERE company_id = ? ORDER BY id`).all(activeCompany.company_id) as Array<{ id: number; name: string }>
      : [{ id: user.activeBranchId, name: "" }];

    const insertStmt = db.prepare(`
      INSERT INTO payroll_periods
        (cycle, target, data_source, period_start, period_end, pay_date, notes, created_by, branch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const results: Array<{ branch_id: number; branch: string; ok: boolean; period_id?: number; skipped?: string; warning?: string; error?: string }> = [];
    let repId: number | null = null;

    for (const b of branchRows) {
      const existing = db.prepare(`
        SELECT id FROM payroll_periods
        WHERE cycle = ? AND period_start = ? AND period_end = ? AND branch_id IS ?
      `).get(d.cycle, d.period_start, d.period_end, b.id) as { id: number } | undefined;
      if (existing) {
        results.push({ branch_id: b.id, branch: b.name, ok: false, skipped: "duplicate", period_id: existing.id });
        repId ??= existing.id;
        continue;
      }
      try {
        const res = insertStmt.run(d.cycle, d.target, d.data_source, d.period_start, d.period_end, payDate, d.notes ?? null, user.id, b.id);
        const pid = res.lastInsertRowid as number;
        if (isFuture) {
          db.prepare(`INSERT INTO payroll_period_unlocks (period_id, unlocked_by, reason, action) VALUES (?, ?, ?, 'force_open')`)
            .run(pid, user.id, (d.force_open_reason ?? "").trim());
        }
        try {
          computePayrollPeriod(db, pid);
          db.prepare(`UPDATE payroll_periods SET computed_by = ? WHERE id = ?`).run(user.id, pid);
          results.push({ branch_id: b.id, branch: b.name, ok: true, period_id: pid });
        } catch (e) {
          results.push({ branch_id: b.id, branch: b.name, ok: true, period_id: pid, warning: (e as Error).message });
        }
        repId ??= pid;
      } catch (e) {
        results.push({ branch_id: b.id, branch: b.name, ok: false, error: (e as Error).message });
      }
    }
    return NextResponse.json({ ok: true, all_branches: true, results, cycle_rep_id: repId });
  }

  // Duplicate = same cycle + dates for THIS branch (matches the table's
  // UNIQUE(cycle,start,end,branch_id)). Other branches can still hold
  // their own period for the same dates.
  const branchId = user.activeBranchId;
  const dup = db.prepare(`
    SELECT id FROM payroll_periods
    WHERE cycle = ? AND period_start = ? AND period_end = ? AND branch_id IS ?
  `).get(d.cycle, d.period_start, d.period_end, branchId);
  if (dup) {
    return NextResponse.json({ error: "duplicate_period" }, { status: 409 });
  }

  const result = db.prepare(`
    INSERT INTO payroll_periods
      (cycle, target, data_source, period_start, period_end, pay_date, notes, created_by, branch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.cycle, d.target, d.data_source,
    d.period_start, d.period_end, payDate, d.notes ?? null, user.id, branchId
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
