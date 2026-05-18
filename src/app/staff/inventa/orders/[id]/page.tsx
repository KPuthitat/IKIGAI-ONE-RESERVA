import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import PrintActions from "./PrintActions";

export const dynamic = "force-dynamic";

type OrderHead = {
  id: number;
  branch_id: number | null;
  status: "draft" | "sent" | "approved" | "received" | "cancelled";
  note: string | null;
  created_at: string;
  sent_at: string | null;
  approved_at: string | null;
  created_by: number | null;
  created_by_name: string | null;
  approved_by_name: string | null;
};
type Line = {
  id: number;
  item_id: number;
  supplier_id: number | null;
  qty_on_hand: number | null;
  suggested_qty: number | null;
  order_qty: number;
  unit_cost_at_order: number;
  item_name: string;
  item_code: string | null;
  unit: string | null;
  supplier_name: string | null;
};

const STATUS_LABEL: Record<OrderHead["status"], string> = {
  draft: "ร่าง", sent: "รออนุมัติ", approved: "อนุมัติแล้ว",
  received: "รับของแล้ว", cancelled: "ยกเลิก"
};

export default function InventaOrderDetailPage({
  params
}: { params: { id: string } }) {
  const user = requireUser();
  const db = getDb();
  const id = Number(params.id);

  const order = Number.isInteger(id)
    ? (db.prepare(`
        SELECT o.*, cu.display_name AS created_by_name,
               au.display_name AS approved_by_name
        FROM inventa_orders o
        LEFT JOIN users cu ON cu.id = o.created_by
        LEFT JOIN users au ON au.id = o.approved_by
        WHERE o.id = ?
      `).get(id) as OrderHead | undefined)
    : undefined;

  if (!order) {
    return (
      <div className="card text-sm text-slate-600">
        ไม่พบใบสั่งซื้อ — <Link href="/staff/inventa/orders" className="text-brand underline">กลับ</Link>
      </div>
    );
  }

  const isSuper = user.role === "super_admin";
  const isAdmin = user.role === "admin" || isSuper;
  if (!isSuper && order.branch_id !== (user.activeBranchId ?? null)) {
    return (
      <div className="card text-sm text-rose-600">
        ใบสั่งซื้อนี้ไม่ได้อยู่ในสาขาที่คุณเปิดอยู่ —{" "}
        <Link href="/staff/inventa/orders" className="text-brand underline">กลับ</Link>
      </div>
    );
  }

  const lines = db.prepare(`
    SELECT l.*, i.name AS item_name, i.item_code, i.unit,
           s.name AS supplier_name
    FROM inventa_order_lines l
    JOIN inventa_items i ON i.id = l.item_id
    LEFT JOIN inventa_suppliers s ON s.id = l.supplier_id
    WHERE l.order_id = ?
    ORDER BY (s.name IS NULL), s.name COLLATE NOCASE, i.name COLLATE NOCASE
  `).all(id) as Line[];

  const branch = order.branch_id
    ? (db.prepare("SELECT name, reg_address, tax_branch_code, company_id, contact_phone FROM branches WHERE id = ?")
        .get(order.branch_id) as {
          name: string; reg_address: string | null;
          tax_branch_code: string | null; company_id: number | null;
          contact_phone: string | null;
        } | undefined)
    : undefined;
  const company = branch?.company_id
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(branch.company_id) as {
          name_th: string; tax_id: string | null;
          address: string | null; phone: string | null;
        } | undefined)
    : undefined;

  // Group lines by supplier — each supplier prints as its own PO sheet.
  const bySupplier = new Map<string, Line[]>();
  for (const l of lines) {
    const k = l.supplier_name ?? "— ไม่ระบุผู้จำหน่าย —";
    const arr = bySupplier.get(k) ?? [];
    arr.push(l);
    bySupplier.set(k, arr);
  }
  const supplierGroups = [...bySupplier.entries()];
  const grandTotal = lines.reduce((s, l) => s + l.order_qty * l.unit_cost_at_order, 0);
  const buyerName = company?.name_th ?? branch?.name ?? "—";
  const buyerAddr = branch?.reg_address || company?.address || "";

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link href="/staff/inventa/orders" className="text-sm text-brand hover:underline">
          ← กลับรายการ
        </Link>
        <span className="text-sm text-slate-400">·</span>
        <span className="font-bold text-slate-800">ใบสั่งซื้อ #{order.id}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
          {STATUS_LABEL[order.status]}
        </span>
        <span className="flex-1" />
        <PrintActions
          orderId={order.id}
          status={order.status}
          canApprove={isAdmin}
          canManage={isAdmin || order.created_by === user.id}
        />
      </div>

      {/* Printable PO — one sheet per supplier */}
      <div className="printable space-y-8">
        {supplierGroups.map(([supplier, rows], gi) => {
          const subtotal = rows.reduce((s, l) => s + l.order_qty * l.unit_cost_at_order, 0);
          return (
            <div key={supplier}
              style={{ pageBreakBefore: gi > 0 ? "always" : "auto" }}
              className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <div className="flex justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-lg font-bold text-slate-800">ใบสั่งซื้อสินค้า</div>
                  <div className="text-xs text-slate-500">Purchase Order #{order.id}
                    {supplierGroups.length > 1 ? `-${gi + 1}` : ""}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    วันที่ {order.created_at.slice(0, 10)} · สถานะ {STATUS_LABEL[order.status]}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-600">
                  <div className="font-bold text-slate-800">{buyerName}</div>
                  {buyerAddr && <div className="max-w-[260px]">{buyerAddr}</div>}
                  {company?.tax_id && <div>เลขผู้เสียภาษี {company.tax_id}
                    {branch?.tax_branch_code ? ` (สาขา ${branch.tax_branch_code})` : ""}</div>}
                  {(branch?.contact_phone || company?.phone) &&
                    <div>โทร {branch?.contact_phone || company?.phone}</div>}
                </div>
              </div>

              <div className="text-sm">
                <span className="text-slate-500">ผู้จำหน่าย: </span>
                <span className="font-bold text-slate-800">{supplier}</span>
              </div>

              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-y border-slate-300 text-left text-xs text-slate-600">
                    <th className="py-2 pr-2 w-8">#</th>
                    <th className="py-2 pr-2">รายการ</th>
                    <th className="py-2 pr-2">รหัส</th>
                    <th className="py-2 pr-2 text-right">คงเหลือ</th>
                    <th className="py-2 pr-2 text-right">สั่ง</th>
                    <th className="py-2 pr-2">หน่วย</th>
                    <th className="py-2 pr-2 text-right">ทุน/หน่วย</th>
                    <th className="py-2 pl-2 text-right">รวม</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l, i) => (
                    <tr key={l.id} className="border-b border-slate-100 align-top">
                      <td className="py-1.5 pr-2 text-slate-400">{i + 1}</td>
                      <td className="py-1.5 pr-2 font-medium text-slate-800">{l.item_name}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{l.item_code ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right text-slate-500">{l.qty_on_hand ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-bold">{l.order_qty}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{l.unit ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right text-slate-500">
                        ฿{l.unit_cost_at_order.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-1.5 pl-2 text-right">
                        ฿{(l.order_qty * l.unit_cost_at_order).toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-300 font-bold">
                    <td colSpan={7} className="py-2 text-right">รวมผู้จำหน่ายนี้</td>
                    <td className="py-2 pl-2 text-right">
                      ฿{subtotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {order.note && (
                <div className="text-xs text-slate-600">
                  <span className="text-slate-400">หมายเหตุ: </span>{order.note}
                </div>
              )}

              <div className="grid grid-cols-2 gap-8 pt-8 text-xs text-slate-600">
                <div className="text-center">
                  <div className="border-t border-slate-400 pt-1 mt-10">
                    ผู้ขอซื้อ — {order.created_by_name ?? "—"}
                  </div>
                </div>
                <div className="text-center">
                  <div className="border-t border-slate-400 pt-1 mt-10">
                    ผู้อนุมัติ {order.approved_by_name ? `— ${order.approved_by_name}` : ""}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {supplierGroups.length > 1 && (
          <div className="text-right text-sm font-bold text-slate-800 no-print">
            มูลค่ารวมทั้งใบ: ฿{grandTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
          </div>
        )}
      </div>
    </div>
  );
}
