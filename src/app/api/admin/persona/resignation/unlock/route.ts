import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({
  user_id: z.number().int().positive(),
  action: z.enum(["unlock", "lock"])
});

// POST /api/admin/persona/resignation/unlock
// admin เปิด/ปิดสิทธิ์การยื่นลาออกให้พนักงาน
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(parsed.data.user_id);
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  if (parsed.data.action === "unlock") {
    const nowIso = new Date().toISOString();
    db.prepare(
      "UPDATE users SET resignation_unlocked_at = ?, resignation_unlocked_by = ? WHERE id = ?"
    ).run(nowIso, user.id, parsed.data.user_id);
  } else {
    db.prepare(
      "UPDATE users SET resignation_unlocked_at = NULL, resignation_unlocked_by = NULL WHERE id = ?"
    ).run(parsed.data.user_id);
  }

  return NextResponse.json({ ok: true });
}
