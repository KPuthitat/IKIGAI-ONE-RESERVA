// INVENTA — generic stock-count module shared constants/types/helpers.
// Business-neutral: works for any goods (not drug-specific).

export type PickFreq = "R" | "Y" | "G";
export type ItemType = "drug" | "equipment";

// Colour band — a free-form red / yellow / green tag each business
// can use however it likes (priority, condition, zone, fast/slow
// moving …). Stored values stay R/Y/G for backward compatibility;
// only the presentation is a neutral colour label now.
export const PICK_FREQ_META: Record<PickFreq, {
  label: string;       // Thai label (used in aria-label / tooltip only)
  short: string;
  desc: string;
  chip: string;        // light chip bg (legacy)
  dot: string;         // solid swatch colour — the only thing shown in UI
}> = {
  R: {
    label: "แดง",
    short: "แดง",
    desc: "แถบสีแดง",
    chip: "bg-rose-100 text-rose-700 border border-rose-300",
    dot: "bg-rose-500"
  },
  Y: {
    label: "เหลือง",
    short: "เหลือง",
    desc: "แถบสีเหลือง",
    chip: "bg-amber-100 text-amber-700 border border-amber-300",
    dot: "bg-amber-400"
  },
  G: {
    label: "เขียว",
    short: "เขียว",
    desc: "แถบสีเขียว",
    chip: "bg-emerald-100 text-emerald-700 border border-emerald-300",
    dot: "bg-emerald-500"
  }
};

export type LookupKind = "row" | "storage" | "unit" | "category";

export const LOOKUP_KIND_META: Record<LookupKind, string> = {
  row: "แถว (รหัสขึ้นต้น)",
  storage: "ตำแหน่งจัดเก็บ",
  unit: "หน่วยเล็กสุด (หน่วยขาย)",
  category: "หมวดหมู่"
};

export type InventaLookup = {
  id: number;
  branch_id: number | null;
  kind: LookupKind;
  value: string;
  /** Short abbreviation used as a prefix in item codes / labels (e.g.
   *  category "ยาแก้ปวด" → code "PAIN"). Optional — older rows have
   *  null, and the UI falls back to displaying `value` only. */
  code: string | null;
  sort_order: number;
  active: number;
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
  /** Short abbreviation (e.g. "ZUE" for Zuellig Pharma). Optional;
   *  used as a code prefix on auto-generated item_codes + on the
   *  supplier picker chip so staff can recognise vendors quickly. */
  code: string | null;
  /** Manual sort order — lower = higher in the list. Used by the
   *  ▲▼ buttons on the suppliers tab so the most-used vendor can
   *  be pinned to the top regardless of created_at. Default 100. */
  display_order: number;
  order_cycle: string | null;
  lead_time: string | null;
  contact: string | null;
  note: string | null;
  active: number;
  created_at: string;
};

/** A single received-on-date lot inside one inventa_item. Multiple
 *  lots per item let us track expiry per batch — when stock is
 *  consumed we deduct from the oldest lot first (FEFO). */
export type InventaItemLot = {
  id: number;
  item_id: number;
  lot_number: string | null;
  /** ISO date string (YYYY-MM-DD), or null if the item has no expiry
   *  (durable equipment etc.). */
  expiry_date: string | null;
  qty: number;
  received_at: string;
  note: string | null;
  created_by: number | null;
  created_at: string;
};

/** Days-until-expiry buckets used by the cron alert + the catalogue
 *  styling. Each lot lands in exactly one bucket based on the diff
 *  between today and expiry_date. */
export type ExpiryBucket = "expired" | "critical" | "warn" | "ok" | "no_expiry";

/** Returns the expiry bucket for one lot. `today` defaults to the
 *  current ISO date so tests can pin a deterministic clock. */
export function expiryBucket(
  expiry_date: string | null | undefined,
  today: string = new Date().toISOString().slice(0, 10)
): ExpiryBucket {
  if (!expiry_date) return "no_expiry";
  const t = new Date(today + "T00:00:00Z").getTime();
  const e = new Date(expiry_date + "T00:00:00Z").getTime();
  if (!isFinite(t) || !isFinite(e)) return "no_expiry";
  const days = Math.floor((e - t) / 86_400_000);
  if (days < 0) return "expired";
  if (days <= 30) return "critical";
  if (days <= 90) return "warn";
  return "ok";
}

export type InventaItem = {
  id: number;
  branch_id: number | null;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  cgd_code: string | null;
  category: string | null;
  storage_location: string | null;
  item_type: ItemType;
  unit: string | null;
  unit_cost: number;
  /** Per-smallest-unit *cost* used as the baseline for PO totals and
   *  margin calculations. Separate from `unit_cost` (legacy avg)
   *  because the owner wanted ราคาทุน entered manually + clearly
   *  distinct from any selling-price column. Null = not entered yet,
   *  callers should fall back to `unit_cost` for estimation. */
  cost_price: number | null;
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
