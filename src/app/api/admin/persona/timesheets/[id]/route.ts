import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({ reason: z.string().max(200).optional() });

type Entry = { id: number; user_id: number; type: "in" | "out"; ts: string; branch_id: number | null };

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const entry = db.prepare(
    "SELECT id, user_id, type, ts, branch_id FROM time_entries WHERE id = ?"
  ).get(id) as Entry | undefined;

  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Branch guard (Phase 2): admin can only delete entries from
  // branches they're assigned to. Legacy rows with NULL branch_id
  // (pre-migration backfill couldn't determine branch) are still
  // reachable so admin can clean them up. New entries always have
  // branch_id, so this won't be a long-term loophole.
  if (entry.branch_id != null && !userHasBranch(user, entry.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  // snapshot → audit ก่อนลบ (idempotent transaction)
  // ใช้ ISO format สำหรับ created_at เช่นกัน (consistent กับ time_entries.ts)
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO time_entries_audit
        (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'delete', ?, ?, ?)
    `).run(entry.id, entry.user_id, entry.type, entry.ts, user.id, parsed.data.reason ?? null, nowIso);
    db.prepare("DELETE FROM time_entries WHERE id = ?").run(id);
  });
  tx();

  return NextResponse.json({ ok: true });
}
