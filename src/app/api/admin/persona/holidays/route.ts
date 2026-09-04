import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/admin/persona/holidays — upsert holiday
const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name_th: z.string().min(1).max(200),
  name_en: z.string().min(1).max(200),
  is_workday: z.boolean().optional(),
  // วันพิเศษ PT (จ่าย 1.5×) — แยกจากวันหยุดราชการ
  pt_special: z.boolean().optional(),
  // วันจ่ายสองเท่า (2× ฐาน+OT ทุกคน) — owner 2026-07-21
  double_pay: z.boolean().optional(),
  // Per-branch scope for the premium flags (owner 2026-09-05). Omit = leave the
  // scope untouched; [] = all branches; [ids] = only those branches.
  branch_ids: z.array(z.number().int().positive()).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const { date, name_th, name_en, is_workday, pt_special, double_pay, branch_ids } = parsed.data;
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO public_holidays (date, name_th, name_en, is_workday, pt_special, double_pay)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        name_th = excluded.name_th,
        name_en = excluded.name_en,
        is_workday = excluded.is_workday,
        pt_special = excluded.pt_special,
        double_pay = excluded.double_pay
    `).run(date, name_th, name_en, is_workday ? 1 : 0, pt_special ? 1 : 0, double_pay ? 1 : 0);
    // Replace the per-branch scope only when the caller sent branch_ids. Empty
    // array clears the scope (→ all branches); a non-empty list restricts to it.
    if (branch_ids !== undefined) {
      db.prepare("DELETE FROM holiday_branch_scope WHERE date = ?").run(date);
      const ins = db.prepare("INSERT OR IGNORE INTO holiday_branch_scope (date, branch_id) VALUES (?, ?)");
      for (const bid of branch_ids) ins.run(date, bid);
    }
  })();

  return NextResponse.json({ ok: true });
}
