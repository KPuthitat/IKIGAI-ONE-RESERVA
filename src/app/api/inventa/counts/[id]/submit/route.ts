import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { notifyToStaffGroup } from "@/lib/line";

// POST /api/inventa/counts/[id]/submit — close the weekly count.
// Items already had current_qty updated as each line was saved, so
// submit just locks the session for history + fires a low-stock
// notification to the branch staff group so supervisors can open a
// PO without having to spot the gap manually.

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

type LowStockRow = {
  item_id: number;
  item_name: string;
  unit: string | null;
  current_qty: number;
  safety_stock: number;
  supplier_id: number | null;
  supplier_name: string | null;
};

/** Group by supplier_id, "(ไม่ระบุผู้จำหน่าย)" bucket for items
 *  without one set. Returns groups sorted by supplier_name asc. */
function groupBySupplier(rows: LowStockRow[]): Array<{
  supplier_id: number | null;
  supplier_name: string;
  items: LowStockRow[];
}> {
  const map = new Map<string, { supplier_id: number | null; supplier_name: string; items: LowStockRow[] }>();
  for (const r of rows) {
    const key = r.supplier_id != null ? String(r.supplier_id) : "_none_";
    const supplier_name = r.supplier_name ?? "(ไม่ระบุผู้จำหน่าย)";
    const g = map.get(key) ?? { supplier_id: r.supplier_id, supplier_name, items: [] };
    g.items.push(r);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, "th"));
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const r = db.prepare(`
    UPDATE inventa_counts
    SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(id);
  if (r.changes === 0) {
    return NextResponse.json({ error: "not_open" }, { status: 409 });
  }

  // ── Low-stock notification ────────────────────────────────────
  // Find items at-or-below safety_stock in the same branch as the
  // count and group them by supplier so the PO can be split per
  // vendor. Fire-and-forget — the LINE push must never block the
  // submit response.
  try {
    const countRow = db.prepare(
      "SELECT branch_id FROM inventa_counts WHERE id = ?"
    ).get(id) as { branch_id: number | null } | undefined;
    const branchId = countRow?.branch_id ?? null;

    const lowStock = db.prepare(`
      SELECT i.id          AS item_id,
             i.name        AS item_name,
             i.unit        AS unit,
             i.current_qty AS current_qty,
             i.safety_stock AS safety_stock,
             i.supplier_id AS supplier_id,
             s.name        AS supplier_name
      FROM inventa_items i
      LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
      WHERE i.active = 1
        AND (? IS NULL OR i.branch_id = ? OR i.branch_id IS NULL)
        AND i.safety_stock IS NOT NULL
        AND i.current_qty <= i.safety_stock
      ORDER BY (i.current_qty - i.safety_stock) ASC, i.name ASC
    `).all(branchId, branchId) as LowStockRow[];

    if (lowStock.length > 0 && branchId != null) {
      const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined;
      if (branch) {
        const groups = groupBySupplier(lowStock);
        // Cap items per supplier in the Flex card to keep it
        // scrollable in LINE (1000 chars per text node, ~14 row
        // bubbles before truncation). Supervisor sees the rest in
        // the orders page (link below).
        const MAX_ITEMS_PER_SUPPLIER = 6;

        const supplierSections = groups.flatMap((g) => {
          const visible = g.items.slice(0, MAX_ITEMS_PER_SUPPLIER);
          const overflow = g.items.length - visible.length;
          const sectionContents: Array<Record<string, unknown>> = [
            {
              type: "box", layout: "baseline", margin: "md",
              contents: [
                { type: "text", text: g.supplier_name, weight: "bold", size: "sm", color: "#1a1a2e", flex: 0 },
                { type: "text", text: `${g.items.length} รายการ`, size: "xs", color: "#888888", align: "end", flex: 1 }
              ]
            },
            ...visible.map((it) => ({
              type: "box", layout: "baseline",
              contents: [
                { type: "text", text: it.item_name, size: "xs", color: "#333333", flex: 5, wrap: true },
                { type: "text",
                  text: `${it.current_qty} / ${it.safety_stock}${it.unit ? " " + it.unit : ""}`,
                  size: "xs", color: "#e94560", weight: "bold", align: "end", flex: 3 }
              ]
            }))
          ];
          if (overflow > 0) {
            sectionContents.push({
              type: "text",
              text: `+ อีก ${overflow} รายการ`,
              size: "xxs", color: "#888888", margin: "xs"
            });
          }
          sectionContents.push({ type: "separator", margin: "md", color: "#dddddd" });
          return sectionContents;
        });

        const flex = {
          type: "flex" as const,
          altText: `📦 ของต่ำกว่าคงคลังขั้นต่ำ ${lowStock.length} รายการ · ${branch.name}`,
          contents: {
            type: "bubble" as const, size: "kilo",
            header: {
              type: "box", layout: "vertical", paddingAll: "16px",
              backgroundColor: "#1a1a2e",
              contents: [
                { type: "text", text: "INVENTA · นับสต๊อกเสร็จ", size: "xxs", color: "#fda4af", weight: "bold" },
                { type: "text", text: `📦 ของต่ำกว่าคลังขั้นต่ำ ${lowStock.length} รายการ`, size: "md", color: "#ffffff", weight: "bold", margin: "xs", wrap: true }
              ]
            },
            body: {
              type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
              contents: [
                { type: "text", text: branch.name, weight: "bold", size: "sm", color: "#1a1a2e" },
                { type: "text", text: `ผู้ส่ง: ${user.display_name} · กรุณาทำใบสั่งซื้อแยกตามผู้จำหน่าย`,
                  size: "xs", color: "#888888", wrap: true, margin: "xs" },
                { type: "separator", margin: "md", color: "#dddddd" },
                ...supplierSections
              ]
            },
            footer: {
              type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
              contents: [
                {
                  type: "button", style: "primary", color: "#e94560",
                  action: {
                    type: "uri",
                    label: "📋 ทำใบสั่งซื้อ",
                    uri: `${PUBLIC_BASE}/staff/inventa/orders`
                  }
                }
              ]
            }
          }
        };

        void notifyToStaffGroup(branch, flex, "branch").catch((e) =>
          console.warn("[inventa-count-submit] notify failed", e)
        );
      }
    }
  } catch (e) {
    console.warn("[inventa-count-submit] low-stock notify failed", e);
  }

  return NextResponse.json({ ok: true });
}
