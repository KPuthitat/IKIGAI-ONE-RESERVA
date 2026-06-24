// Revenue-Share LINE notifications (owner 2026-06-23) — push a Flex card to the
// partner's LINE group (the IKIGAI OS platform OA must be a member). Two cards:
// weekly transfer summary + monthly GP settlement. Mirrors notifyToHrGroup.

import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";
import { vatInclusive } from "./revshare";

type FlexMsg = { type: "flex"; altText: string; contents: unknown };

// Owner 2026-06-23: show amounts as "12,345.00 บาท" (not the ฿ glyph).
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";

function kv(label: string, value: string, opts?: { color?: string; bold?: boolean; size?: string }): unknown {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: opts?.size ?? "sm", color: "#666666", flex: 5 },
      { type: "text", text: value, size: opts?.size ?? "sm", color: opts?.color ?? "#1a1a2e", weight: opts?.bold ? "bold" : "regular", align: "end", flex: 4 }
    ]
  };
}
const sep = { type: "separator", margin: "md", color: "#eeeeee" };

function header(title: string, subtitle: string): unknown {
  return {
    type: "box", layout: "vertical", backgroundColor: "#281a0e", paddingAll: "16px", spacing: "xs",
    contents: [
      { type: "text", text: "IKIGAI OS · ส่วนแบ่งยอดขาย", size: "xxs", color: "#d6a14d" },
      { type: "text", text: title, size: "lg", weight: "bold", color: "#ffffff" },
      { type: "text", text: subtitle, size: "xs", color: "#cbb89a" }
    ]
  };
}
function footer(note: string): unknown {
  return {
    type: "box", layout: "vertical", paddingAll: "10px",
    contents: [{ type: "text", text: note, size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }]
  };
}

export type SettlementCard = {
  shop: string; sellerName: string; sellerCompany?: string | null; partnerName: string; monthLabel: string;
  totalSales: number; tierGP: number; floorApplied: number; topup: number; billedGP: number; avgGpPct: number;
  vatEnabled: boolean; vatAmount: number; whtAmount: number; netAmount: number;
  invoiceNo: string | null;
};

export function revshareSettlementFlex(d: SettlementCard): FlexMsg {
  // Monthly GP summary, billed by the seller (HYPOPLARAEMIA · อิคิไก เวลล์เทรด)
  // to the shop. Shop name leads (from the POS category); legal entity below.
  // The weekly transfer is now its own card (revshareWeeklyFlex).
  const sellerIssuer = d.sellerCompany ? `${d.sellerName} · ${d.sellerCompany}` : d.sellerName;
  const body: unknown[] = [
    { type: "text", text: d.shop, weight: "bold", size: "lg", wrap: true },
    ...(d.partnerName && d.partnerName !== d.shop ? [{ type: "text", text: d.partnerName, size: "xxs", color: "#999999", wrap: true }] : []),
    { type: "text", text: `ผู้เรียกเก็บ: ${sellerIssuer}`, size: "xxs", color: "#999999", wrap: true }
  ];

  body.push(sep);
  body.push(kv("ยอดขายรวมทั้งเดือน", baht(d.totalSales)));
  if (d.topup > 0) {
    body.push(kv(`ส่วนแบ่งตามขั้นบันได (${(d.avgGpPct * 100).toFixed(2)}%)`, baht(d.tierGP)));
    body.push(kv("ขั้นต่ำที่ตกลงกัน", baht(d.floorApplied), { color: "#854f0b" }));
    body.push({ type: "text", text: "ยังไม่ถึงขั้นต่ำ — เรียกเก็บที่ยอดขั้นต่ำ", size: "xxs", color: "#854f0b", wrap: true });
  }
  body.push(kv("ส่วนแบ่งยอดขายทั้งหมด (ก่อนภาษี)", baht(d.billedGP), { bold: true }));
  body.push({ type: "text", text: `ส่วนแบ่งเฉลี่ย ${(d.avgGpPct * 100).toFixed(2)}% ของยอดขาย`, size: "xxs", color: "#999999", wrap: true });
  if (d.vatEnabled && d.vatAmount > 0) {
    body.push(kv("VAT 7%", baht(d.vatAmount)));
    body.push(kv("ส่วนแบ่งยอดขายและภาษีทั้งหมด", baht(d.billedGP + d.vatAmount), { bold: true }));
  }
  body.push(kv("หักภาษี ณ ที่จ่าย 3%", "−" + baht(d.whtAmount), { color: "#a32d2d" }));
  body.push(sep);
  body.push(kv("ยอดสุทธิ", baht(d.netAmount), { bold: true, color: "#0f6e56", size: "md" }));

  return {
    type: "flex",
    altText: `สรุปยอดขายประจำเดือน ${d.monthLabel} · ${d.shop} · ยอดสุทธิ ${baht(d.netAmount)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header(`สรุปยอดขายประจำเดือน · ${d.monthLabel}`, d.invoiceNo ? `ส่วนแบ่งยอดขาย · เลขที่ ${d.invoiceNo}` : "พร้อมส่วนแบ่งยอดขาย"),
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer: footer("เอกสารแจ้งเตือนภายใน ไม่ใช่เอกสารทางภาษี")
    }
  };
}

// ── Daily sales heads-up (owner 2026-06-23: ส่งทุกวันที่นำเข้ายอด) ──
export type DailyCard = { shop: string; sellerName: string; dateLabel: string; sales: number; vatRate: number };
export function revshareDailyFlex(d: DailyCard): FlexMsg {
  const v = vatInclusive(d.sales, d.vatRate);
  return {
    type: "flex",
    altText: `สรุปยอดขายประจำวัน ${d.dateLabel} · ${d.shop} · ${baht(d.sales)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำวัน", d.dateLabel),
      body: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
        contents: [
          { type: "text", text: d.shop, weight: "bold", size: "lg", wrap: true },
          { type: "text", text: `บันทึกโดย: ${d.sellerName}`, size: "xxs", color: "#999999" },
          sep,
          kv("ยอดขายวันนี้ (รวม VAT)", baht(v.total), { bold: true }),
          kv("ฐานก่อน VAT", baht(v.base), { size: "xs" }),
          kv("VAT 7%", baht(v.vat), { size: "xs" })
        ]
      },
      footer: footer("ยอดสะสมจะสรุปอีกครั้งในใบประจำสัปดาห์/เดือน")
    }
  };
}

// ── Weekly sales summary (the amount HYPOPLARAEMIA transfers back to the shop) ──
export type WeeklyCard = {
  shop: string; sellerName: string; weekLabel: string; transferAmount: number; dayCount: number; vatRate: number;
};
export function revshareWeeklyFlex(d: WeeklyCard): FlexMsg {
  const v = vatInclusive(d.transferAmount, d.vatRate);
  return {
    type: "flex",
    altText: `สรุปยอดขายประจำสัปดาห์ ${d.weekLabel} · ${d.shop} · ${baht(d.transferAmount)}`,
    contents: {
      type: "bubble", size: "giga",
      header: header("สรุปยอดขายประจำสัปดาห์", d.weekLabel),
      body: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
        contents: [
          { type: "text", text: d.shop, weight: "bold", size: "lg", wrap: true },
          { type: "text", text: `สรุปโดย: ${d.sellerName} · รวม ${d.dayCount} วัน`, size: "xxs", color: "#999999", wrap: true },
          sep,
          kv("ยอดขายรวมสัปดาห์ (รวม VAT)", baht(v.total), { bold: true }),
          kv("ฐานก่อน VAT", baht(v.base), { size: "xs" }),
          kv("VAT 7%", baht(v.vat), { size: "xs" }),
          { type: "box", layout: "vertical", margin: "md", contents: [
            { type: "text", text: "ยอดโอนคืนให้ร้าน (เต็มจำนวน)", size: "xs", color: "#888888" },
            { type: "text", text: baht(d.transferAmount), size: "xxl", weight: "bold", color: "#0f6e56" }
          ] }
        ]
      },
      footer: footer("ส่วนแบ่งยอดขายจะเรียกเก็บอีกครั้งตอนสรุปสิ้นเดือน")
    }
  };
}

/** Push a Flex card to the partner's LINE group via the platform OA. */
export async function notifyRevsharePartner(lineGroupId: string, flex: FlexMsg): Promise<{ ok: boolean; error?: string }> {
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, error: "platform_oa_not_configured" };
  const res = await sendLinePush(token, { to: lineGroupId, messages: [flex] });
  return { ok: res.ok, error: res.error };
}
