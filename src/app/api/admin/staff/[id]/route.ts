import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, hashPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Patch = z.object({
  password: z.string().min(6).optional(),
  display_name: z.string().min(1).optional(),
  role: z.enum(["admin", "staff"]).optional(),
  branch_ids: z.array(z.number().int()).optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const me = getSessionUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const id = Number(params.id);
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const db = getDb();
  const txn = db.transaction(() => {
    const updates: Record<string, string> = {};
    if (parsed.data.password) updates.password_hash = hashPassword(parsed.data.password);
    if (parsed.data.display_name) updates.display_name = parsed.data.display_name;
    if (parsed.data.role) updates.role = parsed.data.role;
    if (Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
    }
    if (parsed.data.branch_ids) {
      db.prepare("DELETE FROM user_branches WHERE user_id = ?").run(id);
      const ins = db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)");
      for (const bid of parsed.data.branch_ids) ins.run(id, bid);
    }
  });
  txn();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const me = getSessionUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const id = Number(params.id);
  if (id === me.id) return NextResponse.json({ error: "ลบบัญชีตัวเองไม่ได้" }, { status: 400 });
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
