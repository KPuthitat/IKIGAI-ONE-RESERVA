// INVENTA waste log — client-safe types + reason metadata (owner 2026-09-22).
// No DB access here, so this module is safe to import from client components.
// The DB reads/writes live in inventa-waste-server.ts.

export type WasteReason =
  | "expired" | "damaged" | "spoiled" | "spill"
  | "prep_loss" | "contaminated" | "recall" | "lost" | "other";

// Ordered for the picker. th/en labels live with the enum so the whole set
// changes in one place (not spread across i18n).
export const WASTE_REASONS: Array<{ code: WasteReason; th: string; en: string }> = [
  { code: "expired",      th: "หมดอายุ",              en: "Expired" },
  { code: "spoiled",      th: "เสีย/บูด",              en: "Spoiled" },
  { code: "damaged",      th: "ชำรุด/แตกหัก",          en: "Damaged / broken" },
  { code: "spill",        th: "หก/ทำหล่น",            en: "Spill / dropped" },
  { code: "prep_loss",    th: "เตรียมเกิน/เสียตอนเตรียม", en: "Over-prep / prep loss" },
  { code: "contaminated", th: "ปนเปื้อน",             en: "Contaminated" },
  { code: "recall",       th: "เรียกคืน (recall)",     en: "Recall" },
  { code: "lost",         th: "สูญหาย/นับขาด",         en: "Lost / shrinkage" },
  { code: "other",        th: "อื่นๆ",                 en: "Other" }
];

const REASON_BY_CODE = new Map(WASTE_REASONS.map((r) => [r.code, r]));

export function wasteReasonLabel(code: string, lang: "th" | "en"): string {
  const r = REASON_BY_CODE.get(code as WasteReason);
  if (!r) return code;
  return lang === "en" ? r.en : r.th;
}

export type WasteRow = {
  id: number;
  item_id: number | null;
  item_name: string;
  unit: string | null;
  unit_cost: number;
  qty: number;
  value: number;        // qty × unit_cost (snapshot), computed on read
  reason: WasteReason;
  note: string | null;
  wasted_on: string;    // YYYY-MM-DD
  logged_by_name: string | null;
  created_at: string;
};

export type WasteReasonTotal = { reason: WasteReason; qtyEvents: number; value: number };
export type WasteItemTotal = { item_name: string; qtyEvents: number; totalQty: number; value: number };
export type WasteSummary = {
  month: string;
  totalValue: number;
  totalEvents: number;
  byReason: WasteReasonTotal[];
  topItems: WasteItemTotal[];
};
