import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { notifyInventaGroup } from "@/lib/line";
import { nameWithPrefix } from "@/lib/name";
import { ensureOrderToken } from "@/lib/inventa-po-token";

// POST /api/inventa/orders/:id/status — move an order along its
// lifecycle.  sent → approved → received, or → cancelled, or send an
// approved order back to 'sent' for correction.
//
//   approve    : management only (admin / super_admin). sent → approved.
//                Notifies the branch LINE group that it's approved
//                (owner 2026-06-07: "แจ้ง LINE เมื่ออนุมัติ").
//   send_back  : management only. approved → sent. Clears the approval
//                so the lines can be edited again, then re-approved.
//                PIN-gated + audited (it undoes an approval).
//   receive    : admin / super_admin OR the creator. approved → received.
//   cancel     : creator OR admin / super_admin. sent|approved → cancelled
//
// Branch scope: the order must belong to the caller's active branch
// (super_admin may act on any branch).

const Body = z.object({
  action: z.enum([
    "approve", "cancel", "receive", "send_back",
    "pay", "credit", "ship", "return"
  ]),
  pin: z.string().optional(),
  // Optional per-item current-cost updates applied at PO receive (owner
  // 2026-06-09) — lets the receiver record a changed cost; logged + only
  // applied to items actually on this order.
  costs: z.array(z.object({
    item_id: z.number().int().positive(),
    unit_cost: z.number().min(0).max(10_000_000).nullable()
  })).optional()
});

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

  // Branch guard (super_admin is global).
  if (!isSuper && order.branch_id !== (user.activeBranchId ?? null)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const action = parsed.data.action;
  const nowIso = new Date().toISOString();

  if (action === "approve") {
    if (!isAdmin) {
      return NextResponse.json({ error: "approver_must_be_admin" }, { status: 403 });
    }
    if (order.status !== "sent") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare(
      "UPDATE inventa_orders SET status='approved', approved_by=?, approved_at=? WHERE id=?"
    ).run(user.id, nowIso, id);
    notifyApproved(db, order.branch_id, id, user.title_prefix, user.display_name);
    return NextResponse.json({ ok: true, status: "approved" });
  }

  if (action === "send_back") {
    if (!isAdmin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (order.status !== "approved") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    // PIN-gated: sending back undoes an approval, so prove presence.
    const pin = parsed.data.pin;
    if (!pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
    const pinStatus = verifyAdminPin(user.id, pin);
    if (!pinStatus.ok) {
      const code = pinStatus.reason === "no_pin" ? 400 : 403;
      return NextResponse.json({ error: pinStatus.reason }, { status: code });
    }
    db.prepare(
      "UPDATE inventa_orders SET status='sent', approved_by=NULL, approved_at=NULL, sent_at=? WHERE id=?"
    ).run(nowIso, id);
    try {
      db.prepare(`
        INSERT INTO inventa_order_audit (order_id, admin_id, action, before_json, after_json, note, created_at)
        VALUES (?, ?, 'send_back', ?, ?, NULL, ?)
      `).run(id, user.id, JSON.stringify({ status: "approved" }), JSON.stringify({ status: "sent" }), nowIso);
    } catch { /* audit must never block */ }
    logPersonaAction(user.id, "inventa.order.send_back", id);
    return NextResponse.json({ ok: true, status: "sent" });
  }

  // Procurement-tracking steps (owner 2026-06-08). All available to the
  // creator or an admin; no PIN, no per-step LINE push (kept quiet so the
  // group isn't spammed — only approval still notifies).
  const canManage = isAdmin || isCreator;

  if (action === "pay") {
    if (!canManage) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (order.status !== "approved") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare("UPDATE inventa_orders SET status='paid', payment_method='cash' WHERE id=?").run(id);
    return NextResponse.json({ ok: true, status: "paid" });
  }

  if (action === "credit") {
    // วางบิล/เครดิตเทอม — skip payment, go straight to shipping.
    if (!canManage) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (order.status !== "approved") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare("UPDATE inventa_orders SET status='shipping', payment_method='credit' WHERE id=?").run(id);
    return NextResponse.json({ ok: true, status: "shipping" });
  }

  if (action === "ship") {
    if (!canManage) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (order.status !== "paid") {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare("UPDATE inventa_orders SET status='shipping' WHERE id=?").run(id);
    return NextResponse.json({ ok: true, status: "shipping" });
  }

  if (action === "receive") {
    if (!canManage) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (!["approved", "paid", "shipping"].includes(order.status)) {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    const costs = parsed.data.costs ?? [];
    const orderItemIds = new Set(
      (db.prepare("SELECT DISTINCT item_id FROM inventa_order_lines WHERE order_id = ?")
        .all(id) as Array<{ item_id: number }>).map((r) => r.item_id)
    );
    db.transaction(() => {
      db.prepare("UPDATE inventa_orders SET status='received' WHERE id=?").run(id);
      // Apply current-cost updates for items on this order; log each change.
      for (const c of costs) {
        if (c.unit_cost == null || c.unit_cost <= 0) continue;
        if (!orderItemIds.has(c.item_id)) continue;
        const item = db.prepare("SELECT cost_price FROM inventa_items WHERE id = ?")
          .get(c.item_id) as { cost_price: number | null } | undefined;
        if (!item || item.cost_price === c.unit_cost) continue;
        db.prepare("UPDATE inventa_items SET cost_price = ? WHERE id = ?").run(c.unit_cost, c.item_id);
        db.prepare(`
          INSERT INTO inventa_cost_changes (item_id, old_cost, new_cost, source, lot_id, changed_by)
          VALUES (?, ?, ?, 'receive_po', NULL, ?)
        `).run(c.item_id, item.cost_price, c.unit_cost, user.id);
      }
    })();
    return NextResponse.json({ ok: true, status: "received" });
  }

  if (action === "return") {
    if (!canManage) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (!["approved", "paid", "shipping", "received"].includes(order.status)) {
      return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
    }
    db.prepare("UPDATE inventa_orders SET status='returned' WHERE id=?").run(id);
    return NextResponse.json({ ok: true, status: "returned" });
  }

  // cancel
  if (!canManage) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (order.status !== "sent" && order.status !== "approved") {
    return NextResponse.json({ error: "bad_state", status: order.status }, { status: 409 });
  }
  db.prepare("UPDATE inventa_orders SET status='cancelled' WHERE id=?").run(id);
  return NextResponse.json({ ok: true, status: "cancelled" });
}

/** Fire-and-forget LINE card telling the branch group a PO is approved
 *  (owner 2026-06-07). Mirrors the "ขออนุมัติ" card sent on creation so
 *  the group sees the full sent → approved trail. Never blocks/throws. */
function notifyApproved(
  db: ReturnType<typeof getDb>,
  branchId: number | null,
  orderId: number,
  prefix: string | null,
  approverName: string | null
): void {
  try {
    if (branchId == null) return;
    const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined;
    if (!branch) return;
    const head = db.prepare(`
      SELECT s.name AS supplier_name,
             (SELECT COALESCE(SUM(order_qty * unit_cost_at_order), 0)
                FROM inventa_order_lines WHERE order_id = ?) AS subtotal
      FROM inventa_order_lines l
      LEFT JOIN inventa_suppliers s ON s.id = l.supplier_id
      WHERE l.order_id = ? LIMIT 1
    `).get(orderId, orderId) as { supplier_name: string | null; subtotal: number } | undefined;
    const supName = head?.supplier_name ?? "(ไม่ระบุผู้จำหน่าย)";
    const subtotal = head?.subtotal ?? 0;
    const base = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
    // Public supplier PDF (cost hidden) — ready to forward to the vendor.
    const token = ensureOrderToken(orderId);
    const supplierPdfUri = token ? `${base}/api/inventa/orders/${orderId}/pdf?token=${token}` : null;
    const flex = {
      type: "flex" as const,
      altText: `อนุมัติสั่งซื้อแล้ว · ${supName} · ${branch.name}`,
      contents: {
        type: "bubble" as const,
        body: {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [
            { type: "text", text: "อนุมัติสั่งซื้อแล้ว (INVENTA)", weight: "bold", size: "lg", color: "#1a7f37" },
            { type: "text", text: `${branch.name} · PO-${orderId}`, size: "xs", color: "#888888" },
            { type: "separator", margin: "md" },
            { type: "box", layout: "baseline", margin: "sm", contents: [
              { type: "text", text: "ผู้จำหน่าย", size: "sm", color: "#555555", flex: 2 },
              { type: "text", text: supName, size: "sm", color: "#1a1a2e", weight: "bold", align: "end", flex: 4, wrap: true }
            ]},
            { type: "box", layout: "baseline", margin: "sm", contents: [
              { type: "text", text: "รวม (ทุน)", size: "sm", color: "#555555", flex: 3 },
              { type: "text", text: `฿${subtotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`, size: "sm", weight: "bold", align: "end", flex: 2 }
            ]},
            { type: "text", text: `ผู้อนุมัติ: ${nameWithPrefix(prefix, approverName ?? "")}`, size: "xs", color: "#888888", margin: "md", wrap: true }
          ]
        },
        footer: {
          type: "box", layout: "vertical", spacing: "sm", contents: [
            { type: "button", style: "primary", color: "#1a7f37", height: "sm",
              action: { type: "uri", label: "เปิดใบสั่งซื้อ", uri: `${base}/staff/inventa/orders/${orderId}` } },
            ...(supplierPdfUri ? [{
              type: "button" as const, style: "secondary" as const, height: "sm" as const,
              action: { type: "uri" as const, label: "PDF สำหรับผู้จำหน่าย", uri: supplierPdfUri }
            }] : [])
          ]
        }
      }
    };
    void notifyInventaGroup(branch, flex).catch(() => {});
  } catch {
    /* notification must never block the approval */
  }
}
