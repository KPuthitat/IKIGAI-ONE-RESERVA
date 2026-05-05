import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, hashPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(6),
  display_name: z.string().min(1),
  role: z.enum(["admin", "staff"]),
  branch_ids: z.array(z.number().int())
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const data = parsed.data;
  const db = getDb();
  const dup = db.prepare("SELECT id FROM users WHERE username = ?").get(data.username);
  if (dup) return NextResponse.json({ error: "ชื่อผู้ใช้นี้มีอยู่แล้ว" }, { status: 409 });
  try {
    const txn = db.transaction(() => {
      const r = db.prepare(
        "INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)"
      ).run(data.username, hashPassword(data.password), data.display_name, data.role);
      const uid = r.lastInsertRowid as number;
      const ins = db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)");
      for (const bid of data.branch_ids) ins.run(uid, bid);
    });
    txn();
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ผิดพลาด" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
