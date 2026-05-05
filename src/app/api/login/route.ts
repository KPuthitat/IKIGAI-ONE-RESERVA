import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type User } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";

const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  const { username, password } = parsed.data;
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
  }
  const firstBranch = db.prepare(
    "SELECT branch_id FROM user_branches WHERE user_id = ? LIMIT 1"
  ).get(user.id) as { branch_id: number } | undefined;
  createSession(user.id, firstBranch?.branch_id ?? null);
  return NextResponse.json({ ok: true });
}
