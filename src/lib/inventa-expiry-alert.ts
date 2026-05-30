// Daily INVENTA expiry alert. Cron tick scans inventa_item_lots
// for any lot whose expiry_date is already in the past OR within
// the next 30 days, groups by item, and pushes a Flex card to the
// branch's staff group. Idempotent per (branch, date) — the
// branches.inventa_expiry_alert_last_sent_date column gates it so
// the same day's cron ticks short-circuit after the first send.
//
// Why 30 days? Matches the "critical" bucket from expiryBucket()
// helper — gives staff a month to either use up the lot or rotate
// stock. The "warn" bucket (≤90d) is surfaced visually in the
// catalogue UI (#93) but doesn't trigger the LINE alert so we
// don't desensitise the channel with a too-frequent ping.

import { getDb, type Branch } from "./db";
import { expiryBucket, type ExpiryBucket } from "./inventa";

/** One row representing a lot that hit the expired/critical bucket
 *  for today's alert. Shape is what the Flex builder consumes. */
export type ExpiringLot = {
  lot_id: number;
  item_id: number;
  item_name: string;
  item_code: string | null;
  unit: string | null;
  lot_number: string | null;
  expiry_date: string;
  qty: number;
  bucket: ExpiryBucket;
  days_left: number;
};

/** Build the alert list for one branch. Bucket order: expired
 *  first, then critical (≤30d) ascending by date. We intentionally
 *  exclude qty=0 lots (already used up) — the staff don't need to
 *  see an empty batch unless they explicitly opened the item. */
export function buildExpiringLotsForBranch(
  branchId: number,
  today: string = new Date().toISOString().slice(0, 10)
): ExpiringLot[] {
  const rows = getDb().prepare(`
    SELECT l.id          AS lot_id,
           l.item_id     AS item_id,
           i.name        AS item_name,
           i.item_code   AS item_code,
           i.unit        AS unit,
           l.lot_number  AS lot_number,
           l.expiry_date AS expiry_date,
           l.qty         AS qty
    FROM inventa_item_lots l
    JOIN inventa_items i ON i.id = l.item_id
    WHERE i.active = 1
      AND (i.branch_id IS NULL OR i.branch_id = ?)
      AND l.expiry_date IS NOT NULL
      AND l.qty > 0
      AND date(l.expiry_date) <= date(?, '+30 days')
    ORDER BY date(l.expiry_date) ASC, i.name ASC
  `).all(branchId, today) as Array<{
    lot_id: number; item_id: number;
    item_name: string; item_code: string | null; unit: string | null;
    lot_number: string | null; expiry_date: string; qty: number;
  }>;
  return rows.map((r) => {
    const t = new Date(today + "T00:00:00Z").getTime();
    const e = new Date(r.expiry_date + "T00:00:00Z").getTime();
    const days_left = Math.floor((e - t) / 86_400_000);
    return {
      ...r,
      bucket: expiryBucket(r.expiry_date, today),
      days_left
    };
  });
}

/** Idempotency gate. The branch carries the last-sent date — if
 *  it equals today, the cron skips. Mirrors the attendance summary
 *  pattern so a single helper does both the lookup and the stamp. */
export function isExpiryAlertDue(
  branch: Branch & { inventa_expiry_alert_last_sent_date?: string | null },
  todayBkk: string
): boolean {
  const last = branch.inventa_expiry_alert_last_sent_date ?? null;
  return last !== todayBkk;
}

export function markExpiryAlertSent(
  branchId: number,
  todayBkk: string
): void {
  getDb().prepare(
    "UPDATE branches SET inventa_expiry_alert_last_sent_date = ? WHERE id = ?"
  ).run(todayBkk, branchId);
}

/** Build the LINE Flex card describing the expiring lots for one
 *  branch. Two-section card: a red "expired" header with overdue
 *  lots, then an amber "critical" body with the ≤30-day list. Caps
 *  at MAX_LOTS_PER_SECTION rows per bucket so the bubble fits inside
 *  LINE's height constraint; overflow lands in a "+ N more" note. */
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const MAX_LOTS_PER_SECTION = 8;

export function expiryAlertFlex(
  branch: Branch, lots: ExpiringLot[]
): { type: "flex"; altText: string; contents: Record<string, unknown> } {
  const expired = lots.filter((l) => l.bucket === "expired");
  const critical = lots.filter((l) => l.bucket === "critical");
  const altText =
    `⚠️ INVENTA · ของหมดอายุ ${expired.length} · ใกล้หมดอายุ ${critical.length} · ${branch.name}`;

  const section = (
    label: string, color: string, items: ExpiringLot[]
  ): Array<Record<string, unknown>> => {
    if (items.length === 0) return [];
    const visible = items.slice(0, MAX_LOTS_PER_SECTION);
    const overflow = items.length - visible.length;
    const blocks: Array<Record<string, unknown>> = [
      {
        type: "box", layout: "baseline", margin: "md",
        contents: [
          { type: "text", text: label, weight: "bold", size: "sm", color, flex: 0 },
          { type: "text", text: `${items.length} ล็อต`, size: "xs", color: "#888888", align: "end", flex: 1 }
        ]
      },
      ...visible.map((l) => {
        const code = l.item_code ? `[${l.item_code}] ` : "";
        const lot = l.lot_number ? ` · ${l.lot_number}` : "";
        const ageLabel = l.days_left < 0
          ? `${Math.abs(l.days_left)} วันที่แล้ว`
          : `อีก ${l.days_left} วัน`;
        return {
          type: "box", layout: "vertical", margin: "sm",
          contents: [
            {
              type: "text",
              text: `${code}${l.item_name}${lot}`,
              size: "xs", color: "#1a1a2e", wrap: true
            },
            {
              type: "box", layout: "baseline", spacing: "sm",
              contents: [
                {
                  type: "text",
                  text: `${l.qty}${l.unit ? " " + l.unit : ""}`,
                  size: "xxs", color: "#555555", flex: 1
                },
                {
                  type: "text",
                  text: `${l.expiry_date} · ${ageLabel}`,
                  size: "xxs", color, weight: "bold", align: "end", flex: 2
                }
              ]
            }
          ]
        };
      })
    ];
    if (overflow > 0) {
      blocks.push({
        type: "text",
        text: `+ อีก ${overflow} ล็อต`,
        size: "xxs", color: "#888888", margin: "sm"
      });
    }
    blocks.push({ type: "separator", margin: "md", color: "#dddddd" });
    return blocks;
  };

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble", size: "kilo",
      header: {
        type: "box", layout: "vertical", paddingAll: "16px",
        backgroundColor: "#7a1f1f",
        contents: [
          { type: "text", text: "INVENTA · แจ้งเตือนวันหมดอายุ", size: "xxs", color: "#fda4af", weight: "bold" },
          {
            type: "text",
            text: expired.length > 0
              ? `🚨 ของหมดอายุแล้ว ${expired.length} ล็อต`
              : `⚠️ ของใกล้หมดอายุ ${critical.length} ล็อต`,
            size: "md", color: "#ffffff", weight: "bold", margin: "xs", wrap: true
          },
          { type: "text", text: branch.name, size: "xs", color: "#fda4af", margin: "xs" }
        ]
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
        contents: [
          ...section("🚨 หมดอายุแล้ว", "#dc2626", expired),
          ...section("⚠️ ภายใน 30 วัน", "#d97706", critical),
          { type: "text", text: "กรุณาตรวจสอบและจำหน่ายตามขั้นตอน", size: "xxs", color: "#888888", margin: "md", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          {
            type: "button", style: "primary", color: "#dc2626",
            action: {
              type: "uri",
              label: "📋 เปิดรายการ INVENTA",
              uri: `${PUBLIC_BASE}/staff/inventa`
            }
          }
        ]
      }
    }
  };
}
