import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/inventa/suppliers — list active suppliers (branch)
// POST /api/inventa/suppliers — create. Suppliers carry the order /
//   delivery cadence note since each company orders/ships differently.

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  /** Short uppercase abbreviation, e.g. "ZUE". Max 12 to fit on the
   *  two-line catalogue cell + LINE Flex header. Stored as-is (no
   *  forced uppercase) so the admin can use mixed-case if they want. */
  code: z.string().trim().max(12).nullable().optional(),
  order_cycle: z.string().max(200).nullable().optional(),
  lead_time: z.string().max(200).nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  // Shared with ACCOUNTA (owner 2026-06-25): เลขผู้เสียภาษี + หมวดเริ่มต้น.
  tax_id: z.string().trim().max(30).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional()
});

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const rows = getDb().prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND branch_id = ?
    ORDER BY display_order ASC, name ASC
  `).all(branchId);
  return NextResponse.json({ ok: true, suppliers: rows });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  // New rows go to the bottom by default — current max(display_order)
  // + 10 leaves room for manual reorder steps later without recompact.
  const db = getDb();
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(display_order), 0) AS m FROM inventa_suppliers WHERE branch_id = ?"
  ).get(branchId) as { m: number };
  const nextOrder = (maxRow.m ?? 0) + 10;
  const info = db.prepare(`
    INSERT INTO inventa_suppliers
      (branch_id, name, code, display_order, order_cycle, lead_time, contact, note,
       tax_id, category, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    branchId, d.name.trim(),
    d.code?.trim() || null,
    nextOrder,
    d.order_cycle ?? null, d.lead_time ?? null,
    d.contact ?? null, d.note ?? null,
    d.tax_id?.trim() || null, d.category?.trim() || null, user.id
  );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
