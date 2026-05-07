import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
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
  wht_rate: z.number().min(0).max(1),         // 0.03 = 3%
  // Optional: set/clear the superadmin PIN used to unlock paid periods.
  // Send a 4-12 digit string to set, empty string to clear, omit to keep.
  superadmin_pin: z.string().regex(/^\d{4,12}$/).or(z.literal("")).optional()
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

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

  // Update superadmin PIN if provided (separate update so we can hash it)
  if (d.superadmin_pin !== undefined) {
    if (d.superadmin_pin === "") {
      db.prepare(`UPDATE payroll_settings SET superadmin_pin_hash = NULL WHERE id = 1`).run();
    } else {
      const hash = bcrypt.hashSync(d.superadmin_pin, 10);
      db.prepare(`UPDATE payroll_settings SET superadmin_pin_hash = ? WHERE id = 1`).run(hash);
    }
  }

  return NextResponse.json({ ok: true });
}
