import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

const Body = z.object({
  pin: z.string().regex(/^\d{4}$/),
  // ถ้ามี entry ของ action เดียวกันที่ < 5 นาที server จะถามก่อน
  // ค่า: undefined = ครั้งแรก (server ตอบ needsReplace),
  //      true = แทนที่ด้วยเวลาปัจจุบัน,
  //      false = ใช้เวลาเดิม (no-op)
  replaceTs: z.boolean().optional()
});

const FIVE_MIN_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

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

  // คำนวณช่วงวันนี้ (Bangkok local)
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  const todays = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(user.id, startIso, endIso) as Array<{ id: number; type: "in" | "out"; ts: string }>;

  const firstIn = todays.find((e) => e.type === "in") ?? null;
  const firstOut = todays.find((e) => e.type === "out") ?? null;

  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const inAge = firstIn ? nowMs - new Date(firstIn.ts).getTime() : Infinity;
  const outAge = firstOut ? nowMs - new Date(firstOut.ts).getTime() : Infinity;

  // ตัดสินใจ action + ตรวจ correction window
  let action: "in" | "out";
  let existing: { id: number; ts: string } | null = null;

  if (!firstIn) {
    action = "in";
  } else if (!firstOut) {
    if (inAge < FIVE_MIN_MS) {
      // ยังอยู่ใน 5 นาทีของ "in" → ถามว่าจะแก้ไหม
      action = "in";
      existing = { id: firstIn.id, ts: firstIn.ts };
    } else {
      action = "out";
    }
  } else {
    if (outAge < FIVE_MIN_MS) {
      action = "out";
      existing = { id: firstOut.id, ts: firstOut.ts };
    } else {
      // นอกหน้าต่าง 5 นาทีของ "out" → ครบแล้ว ติดต่อหัวหน้างาน
      return NextResponse.json({ error: "already_done_today" }, { status: 409 });
    }
  }

  // กัน race: ถ้า client ส่ง replaceTs มา แต่ server ตอนนี้ไม่เห็น existing
  // (อาจเพราะหน้าต่าง 5 นาทีหมดอายุระหว่างที่ user เลือก) → reject ไม่ INSERT มั่ว
  if (parsed.data.replaceTs !== undefined && !existing) {
    return NextResponse.json(
      { error: "correction_window_expired" },
      { status: 409 }
    );
  }

  if (existing) {
    // ครั้งแรก: ยังไม่ส่ง replaceTs → ถาม client
    if (parsed.data.replaceTs === undefined) {
      return NextResponse.json({
        needsReplace: true,
        action,
        existingTs: existing.ts,
        proposedTs: nowIso
      });
    }

    // เลือก "เปลี่ยนเป็นเวลาปัจจุบัน"
    if (parsed.data.replaceTs === true) {
      const tx = db.transaction(() => {
        // audit: บันทึก self-correction
        db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
          VALUES (?, ?, ?, ?, 'edit', ?, ?, ?)
        `).run(existing!.id, user.id, action, existing!.ts, user.id, "self-correction (5min window)", nowIso);
        db.prepare("UPDATE time_entries SET ts = ? WHERE id = ?").run(nowIso, existing!.id);
      });
      tx();
      return NextResponse.json({ ok: true, action, replaced: true });
    }

    // เลือก "ใช้เวลาเดิม" → ไม่ทำอะไร
    return NextResponse.json({ ok: true, action, replaced: false });
  }

  // ไม่มี existing → INSERT ใหม่ตามปกติ
  db.prepare("INSERT INTO time_entries (user_id, type, ts) VALUES (?, ?, ?)")
    .run(user.id, action, nowIso);

  return NextResponse.json({ ok: true, action });
}
