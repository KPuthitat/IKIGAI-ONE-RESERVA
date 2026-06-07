import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { generatePoPdf, type PoPdfLine } from "@/lib/inventa-po-pdf";
import { orderTokenValid } from "@/lib/inventa-po-token";
import { nameWithPrefix } from "@/lib/name";

// GET /api/inventa/orders/[id]/pdf — stream a real A4 PDF of the purchase
// order (owner 2026-06-06, replaces the broken browser-print preview).
// Auth + branch scope mirror the order-detail page: super_admin sees any
// branch; everyone else only their own active branch.
//
// Public supplier copy (owner 2026-06-08): ?token=<share token> opens the
// PDF with NO login and WITH cost prices hidden, for forwarding to the
// vendor. Any other access still requires a session + branch match.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_TH: Record<string, string> = {
  draft: "ฉบับร่าง", sent: "รออนุมัติ", approved: "อนุมัติแล้ว",
  paid: "ชำระเงินแล้ว", shipping: "อยู่ระหว่างจัดส่ง",
  received: "รับเข้าคลังแล้ว", returned: "ส่งคืนผู้จำหน่าย", cancelled: "ยกเลิก"
};

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  // Public supplier link (?token=…) bypasses auth + hides cost. Otherwise
  // require a staff session.
  const token = new URL(req.url).searchParams.get("token");
  const isPublic = orderTokenValid(id, token);
  const user = isPublic ? null : getSessionUser();
  if (!isPublic && !user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const db = getDb();
  const order = db.prepare(`
    SELECT o.*, cu.display_name AS created_by_name, cu.title_prefix AS created_by_prefix,
           au.display_name AS approved_by_name, au.title_prefix AS approved_by_prefix
    FROM inventa_orders o
    LEFT JOIN users cu ON cu.id = o.created_by
    LEFT JOIN users au ON au.id = o.approved_by
    WHERE o.id = ?
  `).get(id) as {
    id: number; branch_id: number | null; status: string; note: string | null;
    created_at: string; created_by_name: string | null; created_by_prefix: string | null;
    approved_by_name: string | null; approved_by_prefix: string | null;
  } | undefined;
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!isPublic) {
    const isSuper = user!.role === "super_admin";
    if (!isSuper && order.branch_id !== (user!.activeBranchId ?? null)) {
      return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
    }
  }

  const lines = db.prepare(`
    SELECT l.*, i.name AS item_name, i.item_code, i.unit, s.name AS supplier_name
    FROM inventa_order_lines l
    JOIN inventa_items i ON i.id = l.item_id
    LEFT JOIN inventa_suppliers s ON s.id = l.supplier_id
    WHERE l.order_id = ?
    ORDER BY i.name COLLATE NOCASE ASC
  `).all(id) as Array<PoPdfLine & { supplier_name: string | null }>;

  const branch = order.branch_id
    ? (db.prepare("SELECT name, reg_address, tax_branch_code, company_id, contact_phone FROM branches WHERE id = ?")
        .get(order.branch_id) as {
          name: string; reg_address: string | null; tax_branch_code: string | null;
          company_id: number | null; contact_phone: string | null;
        } | undefined)
    : undefined;
  const company = branch?.company_id
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(branch.company_id) as {
          name_th: string; tax_id: string | null; address: string | null; phone: string | null;
        } | undefined)
    : undefined;

  const supplierName = lines.find((l) => l.supplier_name)?.supplier_name ?? "(ไม่ระบุผู้จำหน่าย)";

  try {
    const pdf = await generatePoPdf({
      orderId: order.id,
      status: STATUS_TH[order.status] ?? order.status,
      createdAtIso: order.created_at,
      note: order.note,
      requesterName: order.created_by_name ? nameWithPrefix(order.created_by_prefix, order.created_by_name) : null,
      approverName: order.approved_by_name ? nameWithPrefix(order.approved_by_prefix, order.approved_by_name) : null,
      supplierName,
      buyerName: company?.name_th ?? branch?.name ?? "บริษัท",
      buyerAddress: branch?.reg_address || company?.address || "",
      buyerTaxId: company?.tax_id ?? null,
      buyerBranchCode: branch?.tax_branch_code ?? null,
      buyerPhone: branch?.contact_phone || company?.phone || null,
      hideCost: isPublic,
      lines: lines.map((l) => ({
        item_name: l.item_name,
        item_code: l.item_code,
        unit: l.unit,
        qty_on_hand: l.qty_on_hand,
        order_qty: l.order_qty,
        unit_cost_at_order: l.unit_cost_at_order
      }))
    });
    // Copy into a plain ArrayBuffer-backed Uint8Array so the type
    // satisfies BodyInit (Buffer.buffer is ArrayBufferLike, which TS
    // won't accept directly). PDFs are small — the copy is negligible.
    const arr = new Uint8Array(pdf);
    return new Response(arr, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="PO-${order.id}.pdf"`,
        "Cache-Control": "private, no-store"
      }
    });
  } catch (e) {
    console.error("[inventa] PO PDF generation failed", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
