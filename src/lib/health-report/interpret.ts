// Interpretation rules of the health report (owner 2026-11-25): which reference applies to a person, high / low / normal,
// critical values, implausible entries, BMI, and the hearing and lung-function wording. Pure functions — no database — so
// the entry screen, the import preview, the web report and the PDF all read a result the same way.

import type { Item, Ref, Sex } from "./catalog";

export type Flag = "normal" | "low" | "high" | "abnormal" | "info";
export const FLAG_TH: Record<Flag, string> = { normal: "ปกติ", low: "ต่ำ", high: "สูง", abnormal: "ผิดปกติ", info: "" };
/** High / low are shown as a triangle AND the word (▲ สูง, ▼ ต่ำ): quicker to scan than words alone, and still readable without colour. */
export const FLAG_ARROW: Record<string, string> = { "สูง": "▲", "ต่ำ": "▼", "ลดลง": "▼" };
export const withArrow = (word: string): string => (FLAG_ARROW[word] ? `${FLAG_ARROW[word]} ${word}` : word);

/** Whole years between a birth date and the examination date (both yyyy-mm-dd). */
export function ageOn(dob: string | null | undefined, on: string): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [by, bm, bd] = dob.split("-").map(Number), [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The reference row for this person: a row for their sex beats an "all" row; a row whose age band fits beats one without a band. */
export function pickRef(refs: Ref[] | undefined, sex: "M" | "F" | null, age: number | null): Ref | null {
  const fits = (x: Ref) => (x.sex === "A" || x.sex === sex) && (x.ageMin == null || (age != null && age >= x.ageMin)) && (x.ageMax == null || (age != null && age <= x.ageMax));
  const cand = (refs ?? []).filter(fits);
  if (!cand.length) return null;
  const score = (x: Ref) => (x.sex !== "A" ? 2 : 0) + (x.ageMin != null || x.ageMax != null ? 1 : 0);
  return cand.sort((a, b) => score(b) - score(a))[0];
}

const lowOk = (v: number, x: Ref) => x.low == null || (x.lowIncl === false ? v > x.low : v >= x.low);
const highOk = (v: number, x: Ref) => x.high == null || (x.highIncl === false ? v < x.high : v <= x.high);

/** Normal / low / high for one result. A pick-list result is "abnormal" when it is not one of the item's normal choices. */
export function flagResult(item: Pick<Item, "kind" | "refs" | "normal">, value: number | string | null | undefined, sex: "M" | "F" | null, age: number | null): Flag | null {
  if (value == null || value === "") return null;
  if (item.kind === "choice") {
    if (item.normal === "any" || !item.normal) return "info";
    return item.normal.includes(String(value)) ? "normal" : "abnormal";
  }
  if (item.kind !== "number") return null;
  const v = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(v)) return null;
  const ref = pickRef(item.refs, sex, age);
  if (!ref) return "info";
  if (!lowOk(v, ref)) return "low";
  if (!highOk(v, ref)) return "high";
  return "normal";
}

/** Settings read from annual_checkup_config; the defaults below are used when a key is absent. */
export type Thresholds = { enzymeMultiple: number; enzymeItems: string[]; critical: Record<string, { low?: number; high?: number }> };
export const DEFAULT_THRESHOLDS: Thresholds = {
  enzymeMultiple: 5, enzymeItems: ["AST", "ALT"],       // "liver enzymes beyond 5 times the upper limit → tell the doctor now"
  critical: { FBS: { low: 50, high: 400 }, HB: { low: 7 }, PLT: { low: 20, high: 1000 }, WBC: { low: 2, high: 30 } }   // starting values; editable by the owner
};

/** True when a value is so far out that the doctor must be told straight away. */
export function isCritical(item: Pick<Item, "code" | "refs">, value: number, sex: "M" | "F" | null, age: number | null, th: Thresholds = DEFAULT_THRESHOLDS): boolean {
  if (th.enzymeItems.includes(item.code)) {
    const ref = pickRef(item.refs, sex, age);
    if (ref?.high != null && value > ref.high * th.enzymeMultiple) return true;
  }
  const c = th.critical[item.code];
  return !!c && ((c.low != null && value < c.low) || (c.high != null && value > c.high));
}

/** "Are you sure?" check on entry: outside what a living person can show (glucose 1590) → ask before saving. */
export function implausible(item: Pick<Item, "plausible">, value: number): boolean {
  return !!item.plausible && (value < item.plausible[0] || value > item.plausible[1]);
}

/** Reference text for a table cell: the template's printed text, else built from the ranges ("Male : 13.5 – 17.5 / Female : …"). */
export function refLabel(item: Pick<Item, "refs" | "refText">): string {
  if (item.refText) return item.refText;
  const one = (x: Ref) => {
    const band = x.ageMin != null || x.ageMax != null ? `Age ${x.ageMin != null && x.ageMax != null ? `${x.ageMin}–${x.ageMax}` : x.ageMin != null ? `≥ ${x.ageMin}` : `< ${(x.ageMax ?? 0) + 1}`} · ` : "";
    const who = x.sex === "M" ? "Male : " : x.sex === "F" ? "Female : " : "";
    let body: string;
    if (x.low != null && x.high != null) body = `${x.low} – ${x.high}`;
    else if (x.high != null) body = `${x.highIncl === false ? "<" : "≤"} ${x.high}`;
    else body = `${x.lowIncl === false ? ">" : "≥"} ${x.low}`;
    return band + who + body;
  };
  return (item.refs ?? []).map(one).join("\n");
}

// ── BMI ──
export function bmi(weightKg: number | null | undefined, heightCm: number | null | undefined): number | null {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}
/** Asia-Pacific cut-offs (to be confirmed by the doctor). */
export function bmiCategory(v: number): string {
  return v < 18.5 ? "น้ำหนักต่ำกว่าเกณฑ์" : v < 23 ? "น้ำหนักปกติ" : v < 25 ? "น้ำหนักเกิน" : v < 30 ? "อ้วนระดับ 1" : "อ้วนระดับ 2";
}
/** Friedewald: LDL = total cholesterol − HDL − triglyceride / 5 (mg/dL). Not valid with triglyceride ≥ 400 or a non-positive result → null (measure it directly). */
export const LDL_AUTO_NOTE = "คำนวณอัตโนมัติ (TC − HDL − TG/5)";
export function friedewaldLdl(tc: number | null | undefined, hdl: number | null | undefined, tg: number | null | undefined): number | null {
  if (tc == null || hdl == null || tg == null || ![tc, hdl, tg].every(Number.isFinite) || tg >= 400 || tg < 0) return null;
  const v = Math.round(tc - hdl - tg / 5);
  return v > 0 ? v : null;
}
export const globulin = (totalProtein: number, albumin: number) => Math.round((totalProtein - albumin) * 10) / 10;
export const indirectBilirubin = (total: number, direct: number) => Math.round((total - direct) * 10) / 10;

// ── hearing ──
export const HEARING_FREQS = [500, 1000, 2000, 3000, 4000, 6000, 8000] as const;
export const HEARING_LIMIT_DB = 25;
type Ear = Partial<Record<number, number | null>>;

function earLine(name: "ขวา" | "ซ้าย", ear: Ear): string | null {
  const read = HEARING_FREQS.filter((f) => ear[f] != null);
  if (read.length === 0) return null;
  const low = read.filter((f) => (ear[f] as number) > HEARING_LIMIT_DB);
  if (low.length === 0) return `การได้ยินของหู${name}ปกติ`;
  if (low.length === HEARING_FREQS.length) return `การได้ยินของหู${name}ลดลงทุกความถี่`;
  return `การได้ยินของหู${name}ลดลงที่ความถี่ ${low.join(", ")} เฮิรตซ์`;
}
/** One line for both ears, joined by " / ". Over 25 dB = reduced at that frequency; all seven reduced = "ทุกความถี่". */
export function interpretHearing(right: Ear, left: Ear): string | null {
  const parts = [earLine("ขวา", right), earLine("ซ้าย", left)].filter((x): x is string => !!x);
  return parts.length ? parts.join(" / ") : null;
}

// ── lung function ──
export type Spiro = { fvcPct?: number | null; fev1Pct?: number | null; ratio?: number | null; age: number | null };
export type SpiroResult = { kind: "normal" | "borderline" | "obstructive" | "restrictive" | "mixed" | "incomplete"; th: string; ratioLow: boolean | null; fvcLow: boolean | null; fev1Low: boolean | null };
/** FEV1/FVC abnormal at ≤ 75 (under 50 y) or ≤ 70 (50 y and over); FVC and FEV1 abnormal at ≤ 80 % predicted. FEF 25-75 is not used. */
export function interpretSpirometry(s: Spiro): SpiroResult {
  const ratioLimit = s.age != null && s.age >= 50 ? 70 : 75;
  const ratioLow = s.ratio == null ? null : s.ratio <= ratioLimit;
  const fvcLow = s.fvcPct == null ? null : s.fvcPct <= 80;
  const fev1Low = s.fev1Pct == null ? null : s.fev1Pct <= 80;
  const out = (kind: SpiroResult["kind"], th: string): SpiroResult => ({ kind, th, ratioLow, fvcLow, fev1Low });
  if (ratioLow == null || fvcLow == null || fev1Low == null) return out("incomplete", "ข้อมูลยังไม่ครบสำหรับแปลผล");
  if (!ratioLow && !fvcLow && !fev1Low) return out("normal", "สมรรถภาพปอดปกติ");
  if (ratioLow && !fvcLow && !fev1Low) return out("borderline", "สมรรถภาพปอดอยู่ในกลุ่มก้ำกึ่ง (อัตราส่วน FEV1/FVC ต่ำเพียงอย่างเดียว)");
  if (ratioLow && fvcLow) return out("mixed", "สมรรถภาพปอดผิดปกติแบบผสม (ทั้งอุดกั้นและจำกัดการขยายตัว)");
  if (ratioLow) return out("obstructive", "สมรรถภาพปอดผิดปกติแบบอุดกั้น");
  return out("restrictive", "สมรรถภาพปอดผิดปกติแบบจำกัดการขยายตัว");
}
