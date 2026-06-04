import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH /api/admin/mounjaro/access — super_admin grants/revokes Mounjaro
// clinical access on a user: clinical_role (แพทย์/พยาบาล/none), license
// number (the doctor's unlock key), and HR aggregate-stats access.
// super_admin only — this controls who can reach sensitive clinical data.

const Body = z.object({
  user_id: z.number().int().positive(),
  clinical_role: z.enum(["doctor", "nurse"]).nullable(),
  license_no: z.string().max(60).nullable(),
  is_hr_analytics: z.union([z.literal(0), z.literal(1)])
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(d.user_id);
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // A doctor must have a license number (it's their unlock key).
  const license = (d.license_no ?? "").trim() || null;
  if (d.clinical_role === "doctor" && !license) {
    return NextResponse.json({ error: "license_required_for_doctor" }, { status: 400 });
  }

  db.prepare(`
    UPDATE users SET clinical_role = ?, license_no = ?, is_hr_analytics = ?
    WHERE id = ?
  `).run(d.clinical_role, d.clinical_role ? license : null, d.is_hr_analytics, d.user_id);

  logPersonaAction(user.id, "mounjaro.access_grant", d.user_id);
  return NextResponse.json({ ok: true });
}
