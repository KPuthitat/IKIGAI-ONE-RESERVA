import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/inventa/suppliers — list active suppliers (branch)
// POST /api/inventa/suppliers — create. Suppliers carry the order /
//   delivery cadence note since each company orders/ships differently.

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  order_cycle: z.string().max(200).nullable().optional(),
  lead_time: z.string().max(200).nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional()
});

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const rows = getDb().prepare(`
    SELECT * FROM inventa_suppliers
    WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
    ORDER BY name
  `).all(branchId, branchId);
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
  const info = getDb().prepare(`
    INSERT INTO inventa_suppliers
      (branch_id, name, order_cycle, lead_time, contact, note)
    VALUES (?,?,?,?,?,?)
  `).run(
    user.activeBranchId ?? null, d.name.trim(),
    d.order_cycle ?? null, d.lead_time ?? null,
    d.contact ?? null, d.note ?? null
  );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
