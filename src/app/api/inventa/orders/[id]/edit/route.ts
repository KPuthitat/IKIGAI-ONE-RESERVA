import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/inventa/orders/:id/edit — edit the LINES of a purchase order
// that is still 'sent' (รออนุมัติ). Lets the approver/creator fix the
// order when, e.g., a supplier is out of stock: change quantities, add
// items, or remove lines (owner 2026-06-07).
//
//   - Only a 'sent' order is editable. An 'approved' order must first be
//     sent back ( /status action=send_back ) which flips it to 'sent'.
//   - PIN-gated (the user's 4-digit PIN) + audited (inventa_order_audit
//     keeps a before/after snapshot — same trust level as the payroll
//     line edit / count reopen).
//   - canManage = admin / super_admin OR the order's creator.
//   - Refuses to leave the order with zero lines (use cancel instead).
//
// Body:
//   { pin, updates:[{id,order_qty}], deletes:[id], adds:[{item_id,order_qty}], note? }

const Body = z.object({
  pin: z.string(),
  updates: z.array(z.object({
    id: z.number().int().positive(),
    order_qty: z.number().int().min(1)
  })).default([]),
  deletes: z.array(z.number().int().positive()).default([]),
  adds: z.array(z.object({
    item_id: z.number().int().positive(),
    order_qty: z.number().int().min(1)
  })).default([]),
  note: z.string().max(500).nullable().optional()
});

type LineSnap = {
  id: number; item_id: number; supplier_id: number | null;
  order_qty: number; unit_cost_at_order: number;
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { pin, updates, deletes, adds, note } = parsed.data;

  const pinStatus = verifyAdminPin(user.id, pin);
  if (!pinStatus.ok) {
    const code = pinStatus.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: pinStatus.reason }, { status: code });
  }

  const db = getDb();
  const order = db.prepare(
    "SELECT id, branch_id, status, created_by FROM inventa_orders WHERE id = ?"
  ).get(id) as
    | { id: number; branch_id: number | null; status: string; created_by: number | null }
    | undefined;
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const isSuper = user.role === "super_admin";
  const isAdmin = user.role === "admin" || isSuper;
  const isCreator = order.created_by === user.id;
  if (!isAdmin && !isCreator) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isSuper && order.branch_id !== (user.activeBranchId ?? null)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  if (order.status !== "sent") {
    // approved/received/cancelled — must send back first.
    return NextResponse.json({ error: "not_editable", status: order.status }, { status: 409 });
  }

  if (!updates.length && !deletes.length && !adds.length && note === undefined) {
    return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
  }

  // Before snapshot (for the audit trail).
  const before = db.prepare(
    "SELECT id, item_id, supplier_id, order_qty, unit_cost_at_order FROM inventa_order_lines WHERE order_id = ? ORDER BY id"
  ).all(id) as LineSnap[];
  const existingIds = new Set(before.map((l) => l.id));

  // Validate the line ids referenced by updates/deletes actually belong
  // to this order so a malformed client can't touch another PO's lines.
  for (const u of updates) {
    if (!existingIds.has(u.id)) {
      return NextResponse.json({ error: "bad_line", id: u.id }, { status: 400 });
    }
  }
  for (const d of deletes) {
    if (!existingIds.has(d)) {
      return NextResponse.json({ error: "bad_line", id: d }, { status: 400 });
    }
  }

  // Resolve the items to add — branch-scoped + active. Snapshot cost +
  // on-hand at edit time, same shape as the create flow.
  type ItemRow = {
    id: number; branch_id: number | null; supplier_id: number | null;
    current_qty: number; safety_stock: number;
    cost_price: number | null; unit_cost: number | null;
  };
  const addRows: Array<{ item_id: number; order_qty: number; row: ItemRow }> = [];
  for (const a of adds) {
    const it = db.prepare(
      "SELECT id, branch_id, supplier_id, current_qty, safety_stock, cost_price, unit_cost FROM inventa_items WHERE id = ? AND active = 1"
    ).get(a.item_id) as ItemRow | undefined;
    if (!it) return NextResponse.json({ error: "item_not_found", id: a.item_id }, { status: 400 });
    if (!isSuper && it.branch_id !== (user.activeBranchId ?? null)) {
      return NextResponse.json({ error: "item_branch_forbidden", id: a.item_id }, { status: 403 });
    }
    addRows.push({ item_id: a.item_id, order_qty: a.order_qty, row: it });
  }

  // Net line count after the edit must stay >= 1.
  const finalCount = before.length - deletes.length + addRows.length;
  if (finalCount < 1) {
    return NextResponse.json({ error: "would_be_empty" }, { status: 409 });
  }

  const txn = db.transaction(() => {
    const upd = db.prepare("UPDATE inventa_order_lines SET order_qty = ? WHERE id = ? AND order_id = ?");
    for (const u of updates) upd.run(u.order_qty, u.id, id);

    const del = db.prepare("DELETE FROM inventa_order_lines WHERE id = ? AND order_id = ?");
    for (const d of deletes) del.run(d, id);

    const ins = db.prepare(`
      INSERT INTO inventa_order_lines
        (order_id, item_id, supplier_id, qty_on_hand, suggested_qty,
         order_qty, unit_cost_at_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of addRows) {
      const cost = a.row.cost_price != null ? a.row.cost_price : (a.row.unit_cost ?? 0);
      const suggested = Math.max(0, a.row.safety_stock - a.row.current_qty);
      ins.run(id, a.item_id, a.row.supplier_id, a.row.current_qty, suggested, a.order_qty, cost);
    }

    if (note !== undefined) {
      db.prepare("UPDATE inventa_orders SET note = ? WHERE id = ?").run(note ?? null, id);
    }
  });
  txn();

  // After snapshot + audit row.
  const after = db.prepare(
    "SELECT id, item_id, supplier_id, order_qty, unit_cost_at_order FROM inventa_order_lines WHERE order_id = ? ORDER BY id"
  ).all(id) as LineSnap[];
  try {
    db.prepare(`
      INSERT INTO inventa_order_audit (order_id, admin_id, action, before_json, after_json, note, created_at)
      VALUES (?, ?, 'edit', ?, ?, ?, ?)
    `).run(id, user.id, JSON.stringify(before), JSON.stringify(after), note ?? null, new Date().toISOString());
  } catch { /* audit must never block the edit */ }
  logPersonaAction(user.id, "inventa.order.edit", id);

  return NextResponse.json({ ok: true });
}
