import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { notifyInventaGroup } from "@/lib/line";

// POST /api/inventa/expiry-report — staff flag an item's expiry/condition
// while counting (owner 2026-06-06). Sends a LINE alert to the branch's
// INVENTA group so the purchaser/manager can act (pull from shelf, order
// replacement, dispose). Manual per-item report — what the staff sees on
// the physical box wins over any lot records.

const STATUSES = {
  expiring_60: { label: "ใกล้หมดอายุ (ภายใน 60 วัน)", color: "#B45309", header: "#B45309" },
  expiring_30: { label: "ใกล้หมดอายุ (ภายใน 30 วัน)", color: "#C2410C", header: "#C2410C" },
  expired:     { label: "หมดอายุแล้ว", color: "#B91C1C", header: "#7a1f1f" },
  deteriorated:{ label: "ยาเสื่อมสภาพ", color: "#7C3AED", header: "#5B21B6" }
} as const;

const Body = z.object({
  item_id: z.number().int().positive(),
  status: z.enum(["expiring_60", "expiring_30", "expired", "deteriorated"]),
  note: z.string().max(300).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const branchId = user.activeBranchId ?? null;
  const item = db.prepare(`
    SELECT i.id, i.name, i.item_code, i.unit, i.current_qty,
           i.storage_location, s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.id = ? AND i.active = 1 AND (i.branch_id IS ? OR i.branch_id = ?)
  `).get(parsed.data.item_id, branchId, branchId) as {
    id: number; name: string; item_code: string | null; unit: string | null;
    current_qty: number; storage_location: string | null; supplier_name: string | null;
  } | undefined;
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const meta = STATUSES[parsed.data.status];
  const branch = branchId != null
    ? (db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined)
    : undefined;

  if (branch) {
    const bodyRows: Array<Record<string, unknown>> = [
      { type: "text", text: item.name, weight: "bold", size: "md", color: "#1a1a2e", wrap: true },
      { type: "text",
        text: `${item.item_code ? `[${item.item_code}] ` : ""}คงเหลือ ${item.current_qty}${item.unit ? " " + item.unit : ""}`,
        size: "xs", color: "#888888", margin: "xs", wrap: true }
    ];
    if (item.storage_location) {
      bodyRows.push({ type: "text", text: `ตำแหน่ง: ${item.storage_location}`, size: "xs", color: "#888888", wrap: true });
    }
    if (item.supplier_name) {
      bodyRows.push({ type: "text", text: `ผู้จำหน่าย: ${item.supplier_name}`, size: "xs", color: "#888888", wrap: true });
    }
    if (parsed.data.note) {
      bodyRows.push({ type: "text", text: `หมายเหตุ: ${parsed.data.note}`, size: "sm", color: "#333333", margin: "md", wrap: true });
    }
    bodyRows.push({ type: "text", text: `แจ้งโดย: ${user.display_name}`, size: "xxs", color: "#aaaaaa", margin: "md" });

    const flex = {
      type: "flex" as const,
      altText: `INVENTA · ${meta.label} · ${item.name}`,
      contents: {
        type: "bubble" as const, size: "kilo",
        header: {
          type: "box", layout: "vertical", paddingAll: "14px", backgroundColor: meta.header,
          contents: [
            { type: "text", text: "INVENTA · แจ้งสถานะสินค้า", size: "xxs", color: "#ffffff", weight: "bold" },
            { type: "text", text: meta.label, size: "md", color: "#ffffff", weight: "bold", margin: "xs", wrap: true },
            { type: "text", text: branch.name, size: "xxs", color: "#ffffff", margin: "xs" }
          ]
        },
        body: { type: "box", layout: "vertical", spacing: "none", paddingAll: "16px", contents: bodyRows }
      }
    };
    void notifyInventaGroup(branch, flex).catch((e) =>
      console.warn("[inventa-expiry-report] notify failed", e)
    );
  }

  return NextResponse.json({ ok: true });
}
