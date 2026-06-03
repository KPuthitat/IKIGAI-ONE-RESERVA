import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { notifyToStaffGroup } from "@/lib/line";

// GET  /api/inventa/orders        — recent purchase orders for the
//                                   caller's active branch.
// POST /api/inventa/orders        — create a purchase order from the
//                                   reorder list and notify the
//                                   branch LINE group for approval.
//
// Order lifecycle: sent → approved → received (or cancelled).
// We persist on submit (the staff builds the basket client-side),
// so a new order is created directly as status='sent' and the
// management group is pinged. unit_cost_at_order / qty_on_hand /
// suggested_qty are snapshotted for the audit trail + the supplier
// PDF, so later edits to the item master don't rewrite history.

const Body = z.object({
  note: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    item_id: z.number().int().positive(),
    order_qty: z.number().int().min(1).max(100000)
  })).min(1).max(500)
});

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const rows = getDb().prepare(`
    SELECT o.*,
           (SELECT COUNT(*) FROM inventa_order_lines l WHERE l.order_id = o.id) AS line_count,
           (SELECT COALESCE(SUM(l.order_qty * l.unit_cost_at_order), 0)
              FROM inventa_order_lines l WHERE l.order_id = o.id) AS total_cost,
           cu.display_name AS created_by_name,
           au.display_name AS approved_by_name
    FROM inventa_orders o
    LEFT JOIN users cu ON cu.id = o.created_by
    LEFT JOIN users au ON au.id = o.approved_by
    WHERE o.branch_id IS ? OR o.branch_id = ?
    ORDER BY o.created_at DESC
    LIMIT 50
  `).all(branchId, branchId);
  return NextResponse.json({ ok: true, orders: rows });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  // Pull the item snapshots in one query (branch-scoped for safety).
  // Includes cost_price so we can prefer the owner-pinned figure for
  // unit_cost_at_order — the per-line snapshot used by the supplier
  // PDF + the LINE approval card.
  const ids = parsed.data.lines.map((l) => l.item_id);
  const placeholders = ids.map(() => "?").join(",");
  const items = db.prepare(`
    SELECT id, supplier_id, current_qty, safety_stock,
           unit_cost, cost_price
    FROM inventa_items
    WHERE active = 1 AND id IN (${placeholders})
      AND (branch_id IS ? OR branch_id = ?)
  `).all(...ids, branchId, branchId) as Array<{
    id: number; supplier_id: number | null;
    current_qty: number; safety_stock: number;
    unit_cost: number; cost_price: number | null;
  }>;
  const effectiveCost = (it: typeof items[number]): number =>
    it.cost_price != null ? it.cost_price : (it.unit_cost ?? 0);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const validLines = parsed.data.lines.filter((l) => itemById.has(l.item_id));
  if (validLines.length === 0) {
    return NextResponse.json({ error: "no_valid_items" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  let orderId = 0;
  const txn = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO inventa_orders
        (branch_id, status, note, created_by, created_at, sent_at)
      VALUES (?, 'sent', ?, ?, ?, ?)
    `).run(branchId, parsed.data.note ?? null, user.id, nowIso, nowIso);
    orderId = Number(r.lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO inventa_order_lines
        (order_id, item_id, supplier_id, qty_on_hand, suggested_qty,
         order_qty, unit_cost_at_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of validLines) {
      const it = itemById.get(l.item_id)!;
      const suggested = Math.max(0, it.safety_stock - it.current_qty);
      ins.run(
        orderId, l.item_id, it.supplier_id,
        it.current_qty, suggested, l.order_qty, effectiveCost(it)
      );
    }
  });
  txn();

  // Fire-and-forget LINE notification to the branch group so
  // management sees the request and can approve it.
  try {
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
      .get(branchId) as Branch | undefined;
    if (branch) {
      const totalCost = validLines.reduce((s, l) => {
        const it = itemById.get(l.item_id)!;
        return s + l.order_qty * effectiveCost(it);
      }, 0);
      const flex = {
        type: "flex" as const,
        altText: `ใบสั่งซื้อใหม่ ${branch.name} · ${validLines.length} รายการ`,
        contents: {
          type: "bubble",
          body: {
            type: "box", layout: "vertical", spacing: "sm",
            contents: [
              { type: "text", text: "ขออนุมัติสั่งซื้อ (INVENTA)", weight: "bold", size: "lg" },
              { type: "text", text: branch.name, size: "sm", color: "#888888" },
              { type: "separator", margin: "md" },
              { type: "box", layout: "baseline", margin: "md", contents: [
                { type: "text", text: "จำนวนรายการ", size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: `${validLines.length}`, size: "sm", align: "end", flex: 2 }
              ]},
              { type: "box", layout: "baseline", contents: [
                { type: "text", text: "มูลค่ารวม (ทุน)", size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: `฿${totalCost.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`, size: "sm", align: "end", flex: 2 }
              ]},
              { type: "box", layout: "baseline", contents: [
                { type: "text", text: "ผู้ขอ", size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: user.display_name, size: "sm", align: "end", flex: 2 }
              ]},
              { type: "text", text: `เลขที่ใบสั่ง #${orderId} — เปิดในระบบเพื่ออนุมัติ`, size: "xs", color: "#888888", margin: "md", wrap: true }
            ]
          }
        }
      };
      void notifyToStaffGroup(branch, flex, "global").catch(() => {});
    }
  } catch {
    /* notification must never block order creation */
  }

  return NextResponse.json({ ok: true, id: orderId });
}
