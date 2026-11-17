// LINE card for the HOD group: only the suppliers bought from MORE relative to sales (owner 2026-11-17). Built from the same
// vendorShifts the ANALYTICA page shows, so the card never disagrees with the screen.
import type { Bucket, VendorShift } from "./purchase-trend";

type FlexMsg = { type: "flex"; altText: string; contents: unknown };
export type PurchaseCardMeta = { branchName: string; bucket: Bucket; windowSize: number; operator: string; color: string; link: string };

const UNIT: Record<Bucket, string> = { day: "วัน", week: "สัปดาห์", month: "เดือน" };
const MAX_ROWS = 10;
const baht = (n: number) => `${Math.round(n).toLocaleString("th-TH")} บาท`;
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
/** "เพิ่มขึ้น 64.4%" / "ลดลง 38.8%" in words (a card read in a chat should not rely on a + or - sign). */
const moved = (v: number | null): string => (v == null ? "—" : v > 0 ? `เพิ่มขึ้น ${v.toFixed(1)}%` : v < 0 ? `ลดลง ${Math.abs(v).toFixed(1)}%` : "เท่าเดิม");

function row(s: VendorShift): unknown {
  const worst = s.flag === "up_while_sales_down";
  const newlyBought = s.previous.purchase === 0 && s.recent.purchase > 0;
  return {
    type: "box", layout: "vertical", spacing: "xs", margin: "md",
    contents: [
      { type: "text", text: s.name, size: "sm", weight: "bold", color: "#1a1a2e", wrap: true },
      { type: "text", text: worst ? "ซื้อมากขึ้น ขณะยอดขายลด" : newlyBought ? "เริ่มซื้อ (ช่วงก่อนหน้าไม่มียอดซื้อ)" : "สัดส่วนซื้อสูงขึ้น", size: "xxs", weight: "bold", color: worst ? "#c0392b" : "#b8860b" },
      { type: "text", size: "xs", wrap: true, color: "#333333", text: `สัดส่วนซื้อ ÷ ขาย  ${pct(s.previous.ratio)} → ${pct(s.recent.ratio)}${s.ratioDeltaPct != null && s.ratioDeltaPct > 0 ? `  (เพิ่มขึ้น ${s.ratioDeltaPct.toFixed(1)} จุด)` : ""}` },
      { type: "text", size: "xxs", wrap: true, color: "#666666", text: `ซื้อ ${baht(s.previous.purchase)} → ${baht(s.recent.purchase)} (${newlyBought ? "ซื้อใหม่" : moved(s.purchaseChangePct)})` },
      { type: "text", size: "xxs", wrap: true, color: "#666666", text: `ขาย ${baht(s.previous.sales)} → ${baht(s.recent.sales)} (${moved(s.salesChangePct)})` },
      { type: "separator", margin: "md", color: "#eeeeee" }
    ]
  };
}

/** `items` = buyingMoreShifts(...) (already filtered and ordered). */
export function purchaseBuyingMoreFlex(items: VendorShift[], meta: PurchaseCardMeta): FlexMsg {
  const shown = items.slice(0, MAX_ROWS);
  const rest = items.length - shown.length;
  const unit = UNIT[meta.bucket];
  const body: unknown[] = [
    { type: "text", text: `พบ ${items.length} ผู้ขายที่ซื้อมากขึ้นเมื่อเทียบกับยอดขาย · สรุปโดย: ${meta.operator}`, size: "xxs", color: "#999999", wrap: true },
    { type: "text", text: "สัดส่วน = ยอดซื้อ ÷ ยอดขายในช่วงเดียวกัน", size: "xxs", color: "#999999", wrap: true },
    { type: "separator", margin: "sm", color: "#eeeeee" },
    ...shown.map(row),
    ...(rest > 0 ? [{ type: "text", text: `และอีก ${rest} ผู้ขาย (ดูทั้งหมดในระบบ)`, size: "xs", color: "#666666", margin: "md", wrap: true }] : [])
  ];
  return {
    type: "flex",
    altText: `ซื้อเทียบยอดขาย ${meta.branchName}: ${items.length} ผู้ขายที่ซื้อมากขึ้น`,
    contents: {
      type: "bubble", size: "giga",
      header: {
        type: "box", layout: "vertical", backgroundColor: meta.color, paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "text", text: "NOKHOOK OS · ซื้อเทียบยอดขาย", size: "xxs", color: "#ffffff99" },
          { type: "text", text: "ผู้ขายที่ซื้อมากขึ้น", size: "lg", weight: "bold", color: "#ffffff" },
          { type: "text", text: `${meta.branchName} · ${meta.windowSize} ${unit}ล่าสุด เทียบ ${meta.windowSize} ${unit}ก่อนหน้า`, size: "xs", color: "#ffffffcc", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: { type: "box", layout: "vertical", paddingAll: "10px", contents: [{ type: "button", style: "link", height: "sm", action: { type: "uri", label: "เปิดดูรายละเอียดในระบบ", uri: meta.link } }] }
    }
  };
}
