import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

const Body = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  // Rate limit per user (กัน spam PIN attempts)
  const rl = rateLimit(`clock:${user.id}`, 8, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) },
      { status: 429 }
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_pin_format" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(user.id) as
    | { pin_hash: string | null } | undefined;

  if (!row?.pin_hash) {
    return NextResponse.json({ error: "no_pin_set" }, { status: 400 });
  }
  if (!bcrypt.compareSync(parsed.data.pin, row.pin_hash)) {
    return NextResponse.json({ error: "wrong_pin" }, { status: 401 });
  }

  // นับ entries ของวันนี้ (Bangkok local) — ใช้ datetime('now','localtime') ไม่ค่อย portable
  // ใช้ JS คำนวณช่วงวันแทน
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  const todays = db.prepare(`
    SELECT type FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(user.id, startIso, endIso) as Array<{ type: "in" | "out" }>;

  // 2x daily limit: 0 → in, 1(in) → out, 2+ → done
  let nextAction: "in" | "out";
  if (todays.length === 0) nextAction = "in";
  else if (todays.length === 1 && todays[0].type === "in") nextAction = "out";
  else {
    return NextResponse.json({ error: "already_done_today" }, { status: 409 });
  }

  db.prepare("INSERT INTO time_entries (user_id, type) VALUES (?, ?)").run(user.id, nextAction);

  return NextResponse.json({ ok: true, action: nextAction });
}
