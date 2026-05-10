import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";

// /api/admin/persona/checklist
//
// Admin CRUD for the shift handover checklist items shown on
// /staff/persona/shift/open (and the future close form). Items are
// global (not per-branch) — admin manages one list.

const CreateBody = z.object({
  type: z.enum(["shift_open", "shift_close"]),
  label: z.string().trim().min(1).max(200)
});

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "shift_open";
  if (type !== "shift_open" && type !== "shift_close") {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  const items = getDb().prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = ?
    ORDER BY display_order ASC, id ASC
  `).all(type) as ShiftChecklistItem[];
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { type, label } = parsed.data;
  const db = getDb();
  // Append at the end — find max display_order in this type, +10.
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(display_order), 0) AS max FROM shift_checklist_items WHERE type = ?"
  ).get(type) as { max: number };
  const result = db.prepare(`
    INSERT INTO shift_checklist_items (type, label, display_order)
    VALUES (?, ?, ?)
  `).run(type, label, maxRow.max + 10);
  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
