import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { notifyInventaGroup } from "@/lib/line";

// POST /api/inventa/counts/[id]/submit — close the stock-count round.
// Items already had current_qty updated as each line was saved, so
// submit just locks the round for history + pings the staff LINE group
// that the count is done (no item list — just "go check / make a PO").
// Routes to the shared "กลุ่มรวมพนักงาน" (global), same channel the rest
// of the system uses (owner 2026-06-03: per-branch group wasn't set, so
// nothing arrived).

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  // Silent save (owner 2026-06-06): close the round WITHOUT pinging the
  // LINE group — for minor edits where a fresh announcement would be
  // noise. Item quantities are already saved live regardless.
  const silent = new URL(_req.url).searchParams.get("silent") === "1";
  const db = getDb();
  const r = db.prepare(`
    UPDATE inventa_counts
    SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(id);
  if (r.changes === 0) {
    return NextResponse.json({ error: "not_open" }, { status: 409 });
  }

  if (silent) {
    return NextResponse.json({ ok: true, silent: true });
  }

  // ── Notify the staff group (fire-and-forget) ──────────────────
  // Just announce the round is done + how many items reached the
  // reorder point — no item list. The purchaser opens the orders page
  // to do the actual PO. Never blocks the submit response.
  try {
    const countRow = db.prepare(
      "SELECT branch_id FROM inventa_counts WHERE id = ?"
    ).get(id) as { branch_id: number | null } | undefined;
    const branchId = countRow?.branch_id ?? null;

    const low = db.prepare(`
      SELECT COUNT(*) AS n FROM inventa_items i
      WHERE i.active = 1
        AND (? IS NULL OR i.branch_id = ? OR i.branch_id IS NULL)
        AND i.safety_stock IS NOT NULL
        AND i.current_qty <= i.safety_stock
    `).get(branchId, branchId) as { n: number };
    const lowCount = low?.n ?? 0;

    const branch = branchId != null
      ? (db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as Branch | undefined)
      : undefined;

    if (branch) {
      const summaryLine = lowCount > 0
        ? `มีรายการที่ถึงจุดสั่งซื้อ ${lowCount} รายการ — กรุณาเข้าไปตรวจสอบและทำใบสั่งซื้อ`
        : "ไม่มีรายการที่ต่ำกว่าจุดสั่งซื้อในรอบนี้";
      const flex = {
        type: "flex" as const,
        altText: `INVENTA · นับสต๊อกเสร็จแล้ว · ${branch.name}`,
        contents: {
          type: "bubble" as const, size: "kilo",
          header: {
            type: "box", layout: "vertical", paddingAll: "16px",
            backgroundColor: "#1a1a2e",
            contents: [
              { type: "text", text: "INVENTA", size: "xxs", color: "#fda4af", weight: "bold" },
              { type: "text", text: "นับสต๊อกเสร็จแล้ว", size: "md", color: "#ffffff", weight: "bold", margin: "xs" }
            ]
          },
          body: {
            type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
            contents: [
              { type: "text", text: branch.name, weight: "bold", size: "sm", color: "#1a1a2e" },
              { type: "text", text: `ผู้นับ: ${user.display_name}`, size: "xs", color: "#888888", margin: "xs" },
              { type: "text", text: summaryLine, size: "sm", color: "#333333", wrap: true, margin: "md" }
            ]
          },
          footer: {
            type: "box", layout: "vertical", paddingAll: "16px",
            contents: [
              {
                type: "button", style: "primary", color: "#a06820",
                action: {
                  type: "uri",
                  label: "เข้าไปตรวจสอบ",
                  uri: `${PUBLIC_BASE}/staff/inventa/orders`
                }
              }
            ]
          }
        }
      };
      // Route to the branch's INVENTA group (owner 2026-06-06); falls
      // back to the shared global group when not configured.
      void notifyInventaGroup(branch, flex).catch((e) =>
        console.warn("[inventa-count-submit] notify failed", e)
      );
    }
  } catch (e) {
    console.warn("[inventa-count-submit] notify failed", e);
  }

  return NextResponse.json({ ok: true });
}
