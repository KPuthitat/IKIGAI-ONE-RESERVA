import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";

const TableInput = z.object({
  id: z.number().int().nullable(),
  zone_id: z.number().int().nullable().optional(),
  label: z.string().min(1).max(20),
  capacity: z.number().int().min(1).max(50),
  shape: z.enum(["rect", "round"]),
  x: z.number(),
  y: z.number(),
  width: z.number().min(20),
  height: z.number().min(20),
  active: z.union([z.literal(0), z.literal(1)]),
  _deleted: z.boolean().optional()
});

const Body = z.object({
  branch_id: z.number().int(),
  tables: z.array(TableInput)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  if (!userHasBranch(user, parsed.data.branch_id)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าสาขานี้" }, { status: 403 });
  }

  const db = getDb();
  const branchId = parsed.data.branch_id;

  const txn = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO tables (branch_id, zone_id, label, capacity, shape, x, y, width, height, active)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const update = db.prepare(`
      UPDATE tables SET zone_id=?, label=?, capacity=?, shape=?, x=?, y=?, width=?, height=?, active=?
      WHERE id=? AND branch_id=?
    `);
    const del = db.prepare("DELETE FROM tables WHERE id=? AND branch_id=?");
    const unlinkBookings = db.prepare("UPDATE bookings SET table_id = NULL WHERE table_id = ?");

    for (const t of parsed.data.tables) {
      if (t._deleted && t.id) {
        unlinkBookings.run(t.id);
        del.run(t.id, branchId);
      } else if (t.id === null) {
        insert.run(branchId, t.zone_id ?? null, t.label, t.capacity, t.shape, t.x, t.y, t.width, t.height, t.active);
      } else {
        update.run(t.zone_id ?? null, t.label, t.capacity, t.shape, t.x, t.y, t.width, t.height, t.active, t.id, branchId);
      }
    }
  });
  try {
    txn();
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
