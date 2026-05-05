import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({ type: z.enum(["in", "out"]), note: z.string().max(200).optional() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "ยังไม่ได้เข้าระบบ" }, { status: 401 });
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });

  getDb()
    .prepare("INSERT INTO time_entries (user_id, type, note) VALUES (?, ?, ?)")
    .run(user.id, parsed.data.type, parsed.data.note ?? null);

  return NextResponse.json({ ok: true });
}
