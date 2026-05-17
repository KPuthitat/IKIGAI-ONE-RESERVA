// INVENTA — clinic stock-count module shared constants/types/helpers.

export type PickFreq = "R" | "Y" | "G";
export type ItemType = "drug" | "equipment";

// Pick-frequency colour. The bin code (e.g. "D4R") = grid_row +
// grid_col + pick_freq. Within one physical grid cell several items
// live together; the colour tells staff how often each is used so a
// new hire can locate it fast. R = นานๆ หยิบที, G = หยิบบ่อย.
export const PICK_FREQ_META: Record<PickFreq, {
  label: string;       // Thai label
  short: string;       // chip text
  desc: string;
  // Tailwind classes for the colour chip
  chip: string;
}> = {
  R: {
    label: "นานๆ หยิบที",
    short: "R",
    desc: "ใช้น้อย — หยิบนานๆ ครั้ง",
    chip: "bg-rose-100 text-rose-700 border border-rose-300"
  },
  Y: {
    label: "ปานกลาง",
    short: "Y",
    desc: "ใช้ปานกลาง",
    chip: "bg-amber-100 text-amber-700 border border-amber-300"
  },
  G: {
    label: "หยิบบ่อย",
    short: "G",
    desc: "ใช้บ่อย — หยิบเป็นประจำ",
    chip: "bg-emerald-100 text-emerald-700 border border-emerald-300"
  }
};

export const GRID_ROWS = ["A", "B", "C", "D", "E"] as const;
export const GRID_COLS = [1, 2, 3, 4, 5, 6] as const;

/** Human bin code shown on labels + lists, e.g. ("D",4,"R") → "D4R".
 *  Any missing part is omitted so a half-filled location still reads
 *  sensibly ("D4", "D", ""). */
export function binCode(
  row: string | null | undefined,
  col: number | null | undefined,
  freq: PickFreq | null | undefined
): string {
  return [row ?? "", col ?? "", freq ?? ""].join("").trim();
}

/** Default reorder threshold. Per-item `safety_stock` overrides this;
 *  the business rule for v1 is "below 50 smallest-units → reorder". */
export const DEFAULT_SAFETY_STOCK = 50;

/** Per-smallest-unit cost from a purchase line. Bills may quote packs
 *  or strips; we always store cost per smallest unit (e.g. per tablet).
 *  500 THB for 500 tablets → 1.00. Guards divide-by-zero. */
export function unitCostFrom(
  purchasePrice: number | null | undefined,
  totalUnits: number | null | undefined
): number {
  const p = Number(purchasePrice);
  const u = Number(totalUnits);
  if (!isFinite(p) || !isFinite(u) || u <= 0) return 0;
  return Math.round((p / u) * 10000) / 10000;
}

/** Is this item at/below its reorder point? */
export function isLowStock(qty: number, safety: number): boolean {
  return qty <= (safety ?? DEFAULT_SAFETY_STOCK);
}

export type InventaSupplier = {
  id: number;
  branch_id: number | null;
  name: string;
  order_cycle: string | null;
  lead_time: string | null;
  contact: string | null;
  note: string | null;
  active: number;
  created_at: string;
};

export type InventaItem = {
  id: number;
  branch_id: number | null;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  cgd_code: string | null;
  category: string | null;
  item_type: ItemType;
  unit: string | null;
  unit_cost: number;
  last_purchase_price: number | null;
  last_purchase_units: number | null;
  price_opd: number | null;
  price_ipd: number | null;
  price_uc: number | null;
  supplier_id: number | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  safety_stock: number;
  current_qty: number;
  active: number;
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
};
