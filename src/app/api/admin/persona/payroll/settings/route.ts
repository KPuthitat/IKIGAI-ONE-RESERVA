import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/persona/payroll/settings — admin update payroll settings (singleton row)
const Body = z.object({
  ot_mode: z.enum(["flat", "legal"]),
  ot_flat_per_15min: z.number().min(0).max(10000),
  break_threshold_minutes: z.number().int().min(0).max(1440),
  break_deduction_minutes: z.number().int().min(0).max(1440),
  long_shift_threshold_minutes: z.number().int().min(0).max(1440),
  long_shift_break_minutes: z.number().int().min(0).max(1440),
  sso_rate: z.number().min(0).max(1),         // 0.05 = 5%
  sso_cap: z.number().min(0).max(100000),
  pt_default_hourly_rate: z.number().min(0).max(10000),
  wht_rate: z.number().min(0).max(1)          // 0.03 = 3%
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  db.prepare(`
    UPDATE payroll_settings
    SET ot_mode = ?,
        ot_flat_per_15min = ?,
        break_threshold_minutes = ?,
        break_deduction_minutes = ?,
        long_shift_threshold_minutes = ?,
        long_shift_break_minutes = ?,
        sso_rate = ?,
        sso_cap = ?,
        pt_default_hourly_rate = ?,
        wht_rate = ?,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
    WHERE id = 1
  `).run(
    d.ot_mode, d.ot_flat_per_15min,
    d.break_threshold_minutes, d.break_deduction_minutes,
    d.long_shift_threshold_minutes, d.long_shift_break_minutes,
    d.sso_rate, d.sso_cap,
    d.pt_default_hourly_rate,
    d.wht_rate,
    user.id
  );

  return NextResponse.json({ ok: true });
}
