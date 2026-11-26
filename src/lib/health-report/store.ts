// Reading the report catalogue from the database (the editable copy) and turning item values into / out of the single
// result row the gateway stores per ordered test. Server only.
//   • a test with ONE item stores it the way the old screens do (value_num for a number, value_text otherwise);
//   • a test with several items (CBC, urine, physical exam …) stores {itemCode: value} in value_json;
//   • computed items (BMI, globulin, indirect bilirubin) are never stored — they are derived when shown.

import type Database from "better-sqlite3";
import type { Item, Ref } from "./catalog";
import { implausible } from "./interpret";

type ItemRow = {
  id: number; code: string; test_code: string; section: string; name_en: string; desc_th: string; unit: string | null; kind: Item["kind"];
  choices_json: string | null; normal_json: string | null; ref_text: string | null; plausible_min: number | null; plausible_max: number | null;
  decimals: number | null; computed: Item["computed"] | null; hidden: number; restricted: number; needs_check: number;
};
type RefRow = { item_id: number; sex: "M" | "F" | "A"; age_min: number | null; age_max: number | null; low: number | null; high: number | null; low_incl: number; high_incl: number };

export type DbItem = Item & { id: number };

export function loadItems(db: Database.Database): DbItem[] {
  const rows = db.prepare("SELECT * FROM annual_checkup_items WHERE active = 1 ORDER BY sort_no, id").all() as ItemRow[];
  const refs = db.prepare("SELECT item_id, sex, age_min, age_max, low, high, low_incl, high_incl FROM annual_checkup_item_refs").all() as RefRow[];
  const byItem = new Map<number, Ref[]>();
  for (const r of refs) {
    const list = byItem.get(r.item_id) ?? [];
    list.push({ sex: r.sex, ageMin: r.age_min ?? undefined, ageMax: r.age_max ?? undefined, low: r.low ?? undefined, high: r.high ?? undefined, lowIncl: r.low_incl === 1, highIncl: r.high_incl === 1 });
    byItem.set(r.item_id, list);
  }
  return rows.map((x) => ({
    id: x.id, code: x.code, test: x.test_code, section: x.section, en: x.name_en, th: x.desc_th, unit: x.unit ?? undefined, kind: x.kind,
    choices: x.choices_json ? JSON.parse(x.choices_json) : undefined, normal: x.normal_json ? JSON.parse(x.normal_json) : undefined, refText: x.ref_text ?? undefined,
    refs: byItem.get(x.id) ?? [], plausible: x.plausible_min != null && x.plausible_max != null ? [x.plausible_min, x.plausible_max] : undefined,
    decimals: x.decimals ?? undefined, computed: x.computed ?? undefined, hidden: x.hidden === 1, restricted: x.restricted === 1, check: x.needs_check === 1
  }));
}

export const itemsOfTest = (items: DbItem[], testCode: string) => items.filter((i) => i.test === testCode && i.kind !== "file");
/** The items a person can be asked to enter for a test (computed ones are shown, not typed). */
export const enterable = (items: DbItem[]) => items.filter((i) => !i.computed && i.kind !== "file");

export type Values = Record<string, number | string | null>;
export type StoredResult = { value_num: number | null; value_text: string | null; value_json: string | null };

/** Item values from a stored result row. */
export function valuesFromResult(testItems: DbItem[], r: StoredResult | null | undefined): Values {
  const out: Values = {};
  if (!r) return out;
  const real = enterable(testItems);
  if (real.length === 1) {
    const only = real[0];
    out[only.code] = only.kind === "number" ? r.value_num : r.value_text;
    return out;
  }
  if (r.value_json) { try { const j = JSON.parse(r.value_json) as Values; for (const it of real) if (j[it.code] != null) out[it.code] = j[it.code]; } catch { /* keep what we have */ } }
  return out;
}

export type ValidationIssue = { code: string; problem: "unknown_item" | "not_a_number" | "not_a_choice" | "too_long" | "implausible" };

/** Checks typed values against the catalogue. Implausible numbers are reported as issues so the caller can ask the person to confirm. */
export function validateValues(testItems: DbItem[], values: Values): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byCode = new Map(enterable(testItems).map((i) => [i.code, i]));
  for (const [code, v] of Object.entries(values)) {
    const it = byCode.get(code);
    if (!it) { issues.push({ code, problem: "unknown_item" }); continue; }
    if (v == null || v === "") continue;
    if (it.kind === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) issues.push({ code, problem: "not_a_number" });
      else if (implausible(it, v)) issues.push({ code, problem: "implausible" });
    } else if (it.kind === "choice") {
      if (String(v).length > 200) issues.push({ code, problem: "too_long" });   // any wording is allowed (e.g. "Weakly positive"); the list is a shortcut
    } else if (String(v).length > 1000) issues.push({ code, problem: "too_long" });
  }
  return issues;
}

/** The fields the gateway's recordResult takes. Empty values are dropped; a test with nothing left stores nothing. */
export function valuesToInput(testItems: DbItem[], values: Values): { valueNum: number | null; valueText: string | null; valueJson: string | null } {
  const real = enterable(testItems);
  const clean: Values = {};
  for (const it of real) { const v = values[it.code]; if (v != null && v !== "") clean[it.code] = it.kind === "number" ? Number(v) : String(v).trim(); }
  if (real.length === 1) {
    const it = real[0], v = clean[it.code];
    return { valueNum: it.kind === "number" && v != null ? (v as number) : null, valueText: it.kind !== "number" && v != null ? (v as string) : null, valueJson: null };
  }
  return { valueNum: null, valueText: null, valueJson: Object.keys(clean).length ? JSON.stringify(clean) : null };
}
