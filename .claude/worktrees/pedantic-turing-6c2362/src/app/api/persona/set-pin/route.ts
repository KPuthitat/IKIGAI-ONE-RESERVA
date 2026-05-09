import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({
  pin: z.string().regex(/^\d{4}$/),
  current_pin: z.string().regex(/^\d{4}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_pin_format" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(user.id) as
    | { pin_hash: string | null } | undefined;

  // ถ้ามี PIN เดิมแล้ว → ต้องส่ง current_pin มา verify
  if (row?.pin_hash) {
    if (!parsed.data.current_pin) {
      return NextResponse.json({ error: "current_pin_required" }, { status: 400 });
    }
    if (!bcrypt.compareSync(parsed.data.current_pin, row.pin_hash)) {
      return NextResponse.json({ error: "current_pin_wrong" }, { status: 401 });
    }
  }

  const newHash = bcrypt.hashSync(parsed.data.pin, 10);
  db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(newHash, user.id);
  return NextResponse.json({ ok: true });
}
