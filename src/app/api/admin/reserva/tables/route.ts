import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayBkk } from "@/lib/time";

// Per-table management used by the timetable's "จัดการโต๊ะ" panel.
// Deliberately small + safe — replaces editing tables on the (now
// hidden) spatial floor-plan page.
//
//   POST   create a table         { branch_id, label, capacity, zone_id? }
//   PATCH  rename / re-capacity /  { id, label?, capacity?, zone_id? }
//          move zone
//   DELETE ?id=123  → soft-delete (active = 0). NEVER hard-deletes: a
//          DELETE row would trip the bookings.table_id ON DELETE SET
//          NULL cascade and silently strip the table off existing
//          bookings. Deactivating keeps history intact and is fully
//          reversible. Blocked entirely if the table still has a live
//          (today-or-future, not-cancelled) booking.

function authBranch(branchId: number) {
  const user = getSessionUser();
  if (!user) return { error: "unauthenticated" as const, status: 401 };
  if (user.role !== "admin" && user.role !== "super_admin") {
    return { error: "forbidden" as const, status: 403 };
  }
  if (!userHasBranch(user, branchId)) {
    return { error: "branch_forbidden" as const, status: 403 };
  }
  return { ok: true as const };
}

const CreateBody = z.object({
  branch_id: z.number().int().positive(),
  label: z.string().trim().min(1).max(20),
  capacity: z.number().int().min(1).max(50),
  zone_id: z.number().int().positive().nullable().optional()
});

export async function POST(req: Request) {
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const d = parsed.data;
  const gate = authBranch(d.branch_id);
  if (!("ok" in gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const db = getDb();
  try {
    // Append the new table at the end of its zone's order so ↑/↓ ordering
    // stays meaningful (column default is 0, which would collide otherwise).
    const nextOrder = (db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM tables
        WHERE branch_id = ? AND active = 1 AND zone_id IS ?`
    ).get(d.branch_id, d.zone_id ?? null) as { n: number }).n;
    const info = db.prepare(`
      INSERT INTO tables (branch_id, zone_id, label, capacity, active, sort_order)
      VALUES (?,?,?,?,1,?)
    `).run(d.branch_id, d.zone_id ?? null, d.label, d.capacity, nextOrder);
    return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (e: unknown) {
    // UNIQUE(branch_id,label) collision is the only expected failure.
    const msg = e instanceof Error && /UNIQUE/.test(e.message)
      ? "label_taken" : "create_failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

const PatchBody = z.object({
  id: z.number().int().positive(),
  label: z.string().trim().min(1).max(20).optional(),
  capacity: z.number().int().min(1).max(50).optional(),
  zone_id: z.number().int().positive().nullable().optional(),
  // Whether the table may be pushed together with adjacent same-zone tables.
  mergeable: z.union([z.literal(0), z.literal(1)]).optional(),
  // Swap sort_order with the previous/next active table in the SAME zone —
  // this is how the owner sets which tables are physically adjacent (and thus
  // combinable). Atomic; ignores the other fields when present.
  move: z.enum(["up", "down"]).optional()
});

export async function PATCH(req: Request) {
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const tbl = db.prepare("SELECT id, branch_id, zone_id, sort_order FROM tables WHERE id = ?")
    .get(d.id) as { id: number; branch_id: number; zone_id: number | null; sort_order: number } | undefined;
  if (!tbl) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = authBranch(tbl.branch_id);
  if (!("ok" in gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // Reorder within the zone: find the immediate neighbour (prev for "up",
  // next for "down") and swap sort_order values in one transaction.
  if (d.move) {
    const neighbour = db.prepare(
      d.move === "up"
        ? `SELECT id, sort_order FROM tables
             WHERE branch_id = ? AND active = 1 AND zone_id IS ? AND sort_order < ?
             ORDER BY sort_order DESC LIMIT 1`
        : `SELECT id, sort_order FROM tables
             WHERE branch_id = ? AND active = 1 AND zone_id IS ? AND sort_order > ?
             ORDER BY sort_order ASC LIMIT 1`
    ).get(tbl.branch_id, tbl.zone_id, tbl.sort_order) as { id: number; sort_order: number } | undefined;
    // Already at the edge — nothing to do, treat as a no-op success.
    if (!neighbour) return NextResponse.json({ ok: true });
    const swap = db.transaction(() => {
      db.prepare("UPDATE tables SET sort_order = ? WHERE id = ?").run(neighbour.sort_order, tbl.id);
      db.prepare("UPDATE tables SET sort_order = ? WHERE id = ?").run(tbl.sort_order, neighbour.id);
    });
    swap();
    return NextResponse.json({ ok: true });
  }

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (d.label !== undefined) { sets.push("label = ?"); vals.push(d.label); }
  if (d.capacity !== undefined) { sets.push("capacity = ?"); vals.push(d.capacity); }
  if ("zone_id" in d) {
    const newZone = d.zone_id ?? null;
    sets.push("zone_id = ?"); vals.push(newZone);
    // Moving to a different zone: drop the table at the end of the target
    // zone's order so its sort_order stays unique and ↑/↓ keeps working.
    if (newZone !== (tbl.zone_id ?? null)) {
      const nextOrder = (db.prepare(
        `SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM tables
          WHERE branch_id = ? AND active = 1 AND zone_id IS ? AND id != ?`
      ).get(tbl.branch_id, newZone, tbl.id) as { n: number }).n;
      sets.push("sort_order = ?"); vals.push(nextOrder);
    }
  }
  if (d.mergeable !== undefined) { sets.push("mergeable = ?"); vals.push(d.mergeable); }
  if (sets.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  vals.push(d.id);
  try {
    db.prepare(`UPDATE tables SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error && /UNIQUE/.test(e.message)
      ? "label_taken" : "update_failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const tbl = db.prepare("SELECT id, branch_id FROM tables WHERE id = ?")
    .get(id) as { id: number; branch_id: number } | undefined;
  if (!tbl) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = authBranch(tbl.branch_id);
  if (!("ok" in gate)) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // Guard: refuse while a live (today-or-future, not cancelled/completed)
  // booking still sits on this table — prevents a customer's table
  // vanishing mid-service.
  const live = db.prepare(`
    SELECT COUNT(*) AS n FROM bookings
    WHERE table_id = ?
      AND status IN ('pending_review','confirmed','seated')
      AND booking_date >= ?
  `).get(id, todayBkk()) as { n: number };
  if (live.n > 0) {
    return NextResponse.json(
      { error: "has_live_bookings", count: live.n },
      { status: 409 }
    );
  }

  // Soft-delete: drop it off the timetable without touching any
  // historical booking's table_id.
  db.prepare("UPDATE tables SET active = 0 WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
