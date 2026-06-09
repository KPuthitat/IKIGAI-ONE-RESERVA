// INVENTA label layout (owner 2026-06-09) — a per-branch, drag-designed
// arrangement of label elements. Stored as JSON in branches.inventa_label_layout.
// NULL/invalid → the printable label falls back to its built-in flex layout,
// so branches that never open the designer print exactly as before.
//
// Coordinates are PERCENT of the label box (x/y = top-left, w = width); font
// `size` is in millimetres so it prints at a real physical size. For qr +
// barcode, `size` is the element HEIGHT in mm (qr is square = its width %).

export type LabelElementKey =
  | "name" | "qr" | "code" | "cost" | "sale" | "bin" | "barcode";

export type LabelElement = {
  show: boolean;
  x: number;   // % from left (0–100)
  y: number;   // % from top (0–100)
  w: number;   // % width (1–100)
  size: number; // mm — font size (text) or height (qr/barcode)
  align?: "left" | "center" | "right";
};

export type LabelLayout = Record<LabelElementKey, LabelElement>;

export const LABEL_ELEMENT_KEYS: LabelElementKey[] =
  ["name", "qr", "code", "cost", "sale", "bin", "barcode"];

export const LABEL_ELEMENT_LABEL: Record<LabelElementKey, string> = {
  name: "ชื่อสินค้า",
  qr: "QR code",
  code: "รหัส",
  cost: "ราคาทุน",
  sale: "ราคาขาย",
  bin: "ตำแหน่งเก็บ",
  barcode: "บาร์โค้ด"
};

// Sensible starting layout (mirrors the classic flex look) for an 80×50mm
// sticker — the designer opens from this when a branch has none yet.
export const DEFAULT_LABEL_LAYOUT: LabelLayout = {
  name:    { show: true, x: 2,  y: 2,  w: 96, size: 3.0, align: "center" },
  qr:      { show: true, x: 3,  y: 26, w: 34, size: 17 },
  code:    { show: true, x: 40, y: 24, w: 58, size: 3.1, align: "left" },
  cost:    { show: true, x: 40, y: 38, w: 58, size: 2.8, align: "left" },
  sale:    { show: true, x: 40, y: 50, w: 58, size: 3.0, align: "left" },
  bin:     { show: true, x: 40, y: 62, w: 58, size: 2.3, align: "left" },
  barcode: { show: true, x: 2,  y: 80, w: 96, size: 10 }
};

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Parse + validate stored JSON. Returns null when absent/invalid so the
 *  caller can fall back to the built-in flex layout. Each element is merged
 *  over the default so a partial/old JSON still yields a complete layout. */
export function parseLabelLayout(json: string | null | undefined): LabelLayout | null {
  if (!json) return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, Partial<LabelElement>>;
  const out = {} as LabelLayout;
  for (const k of LABEL_ELEMENT_KEYS) {
    const d = DEFAULT_LABEL_LAYOUT[k];
    const e = src[k] ?? {};
    out[k] = {
      show: typeof e.show === "boolean" ? e.show : d.show,
      x: clampNum(e.x, 0, 100, d.x),
      y: clampNum(e.y, 0, 100, d.y),
      w: clampNum(e.w, 1, 100, d.w),
      size: clampNum(e.size, 0.5, 60, d.size),
      align: e.align === "left" || e.align === "center" || e.align === "right" ? e.align : d.align
    };
  }
  return out;
}

/** Serialize for storage (compact, validated). */
export function serializeLabelLayout(layout: LabelLayout): string {
  const clean = {} as LabelLayout;
  for (const k of LABEL_ELEMENT_KEYS) {
    const e = layout[k];
    clean[k] = {
      show: !!e.show,
      x: clampNum(e.x, 0, 100, DEFAULT_LABEL_LAYOUT[k].x),
      y: clampNum(e.y, 0, 100, DEFAULT_LABEL_LAYOUT[k].y),
      w: clampNum(e.w, 1, 100, DEFAULT_LABEL_LAYOUT[k].w),
      size: clampNum(e.size, 0.5, 60, DEFAULT_LABEL_LAYOUT[k].size),
      align: e.align ?? DEFAULT_LABEL_LAYOUT[k].align
    };
  }
  return JSON.stringify(clean);
}
