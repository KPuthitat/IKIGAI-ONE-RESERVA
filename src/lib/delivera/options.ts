import { getDb } from "@/lib/db";

// DELIVERA menu option groups (owner 2026-10-30): size / sweetness / ice / toppings … each choice may add to the price.
// The customer's picks arrive as a list of choice ids; the server validates them against the item's groups and
// recomputes the unit price — the client's numbers are never trusted. The order line stores a readable snapshot so
// later menu edits never rewrite history.

export type OptionChoice = { id: number; name: string; priceDelta: number; available: boolean };
export type OptionGroup = { id: number; name: string; minPick: number; maxPick: number; choices: OptionChoice[] };
export type OptionGroupInput = { name: string; minPick: number; maxPick: number; choices: Array<{ name: string; priceDelta: number; available?: boolean }> };

export class OptionError extends Error {
  constructor(public code: "option_invalid" | "option_required" | "option_too_many" | "option_unavailable" | "option_bad_input", public detail?: string) { super(code); }
}
export const OPTION_ERROR_TH: Record<OptionError["code"], string> = {
  option_invalid: "ตัวเลือกที่เลือกไม่ถูกต้อง",
  option_required: "กรุณาเลือกตัวเลือกที่จำเป็นให้ครบ",
  option_too_many: "เลือกตัวเลือกเกินจำนวนที่กำหนด",
  option_unavailable: "ตัวเลือกบางอย่างหมดชั่วคราว",
  option_bad_input: "ข้อมูลตัวเลือกไม่ถูกต้อง"
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Option groups of one item (or several), with their choices. */
export function listOptionGroups(menuItemIds: number[]): Map<number, OptionGroup[]> {
  const out = new Map<number, OptionGroup[]>();
  if (menuItemIds.length === 0) return out;
  const db = getDb();
  const q = menuItemIds.map(() => "?").join(",");
  const groups = db.prepare(`SELECT id, menu_item_id, name, min_pick, max_pick FROM delivera_option_groups WHERE menu_item_id IN (${q}) ORDER BY sort_order, id`).all(...menuItemIds) as
    Array<{ id: number; menu_item_id: number; name: string; min_pick: number; max_pick: number }>;
  const byGroup = new Map<number, OptionChoice[]>();
  if (groups.length > 0) {
    const gq = groups.map(() => "?").join(",");
    for (const c of db.prepare(`SELECT id, group_id, name, price_delta, is_available FROM delivera_option_choices WHERE group_id IN (${gq}) ORDER BY sort_order, id`).all(...groups.map((g) => g.id)) as
      Array<{ id: number; group_id: number; name: string; price_delta: number; is_available: number }>) {
      const arr = byGroup.get(c.group_id) ?? []; arr.push({ id: c.id, name: c.name, priceDelta: c.price_delta, available: c.is_available === 1 }); byGroup.set(c.group_id, arr);
    }
  }
  for (const g of groups) {
    const arr = out.get(g.menu_item_id) ?? [];
    arr.push({ id: g.id, name: g.name, minPick: g.min_pick, maxPick: g.max_pick, choices: byGroup.get(g.id) ?? [] });
    out.set(g.menu_item_id, arr);
  }
  return out;
}

/** Replace the whole option set of a menu item (all or nothing). An empty list removes every option. */
export function saveItemOptions(branchId: number, menuItemId: number, groups: OptionGroupInput[]): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM delivera_menu_items WHERE id = ? AND branch_id = ?").get(menuItemId, branchId)) return false;
  if (groups.length > 12) throw new OptionError("option_bad_input");
  for (const g of groups) {
    const name = (g.name ?? "").trim();
    if (!name || name.length > 60 || g.choices.length === 0 || g.choices.length > 40) throw new OptionError("option_bad_input", name);
    if (!Number.isInteger(g.minPick) || !Number.isInteger(g.maxPick) || g.minPick < 0 || g.maxPick < 1 || g.minPick > g.maxPick || g.maxPick > g.choices.length) throw new OptionError("option_bad_input", name);
    for (const c of g.choices) if (!(c.name ?? "").trim() || c.name.length > 60 || !Number.isFinite(c.priceDelta) || c.priceDelta < -100000 || c.priceDelta > 100000) throw new OptionError("option_bad_input", name);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM delivera_option_groups WHERE menu_item_id = ?").run(menuItemId);   // choices go with them (cascade)
    const insG = db.prepare("INSERT INTO delivera_option_groups (branch_id, menu_item_id, name, min_pick, max_pick, sort_order) VALUES (?,?,?,?,?,?)");
    const insC = db.prepare("INSERT INTO delivera_option_choices (group_id, name, price_delta, is_available, sort_order) VALUES (?,?,?,?,?)");
    groups.forEach((g, gi) => {
      const gid = Number(insG.run(branchId, menuItemId, g.name.trim(), g.minPick, g.maxPick, gi).lastInsertRowid);
      g.choices.forEach((c, ci) => insC.run(gid, c.name.trim(), round2(c.priceDelta), c.available === false ? 0 : 1, ci));
    });
  })();
  return true;
}

export type PickedChoice = { id: number; group: string; name: string; delta: number };

/** Validate a customer's picks for one menu item and price them. Throws OptionError when a rule is broken. */
export function priceChoices(menuItemId: number, choiceIds: number[]): { delta: number; picked: PickedChoice[] } {
  const groups = listOptionGroups([menuItemId]).get(menuItemId) ?? [];
  const ids = [...new Set(choiceIds ?? [])];
  const picked: PickedChoice[] = [];
  const byChoice = new Map<number, { group: OptionGroup; choice: OptionChoice }>();
  for (const g of groups) for (const c of g.choices) byChoice.set(c.id, { group: g, choice: c });
  const perGroup = new Map<number, number>();
  for (const id of ids) {
    const hit = byChoice.get(id);
    if (!hit) throw new OptionError("option_invalid");
    if (!hit.choice.available) throw new OptionError("option_unavailable", hit.choice.name);
    perGroup.set(hit.group.id, (perGroup.get(hit.group.id) ?? 0) + 1);
    picked.push({ id, group: hit.group.name, name: hit.choice.name, delta: hit.choice.priceDelta });
  }
  for (const g of groups) {
    const n = perGroup.get(g.id) ?? 0;
    if (n < g.minPick) throw new OptionError("option_required", g.name);
    if (n > g.maxPick) throw new OptionError("option_too_many", g.name);
  }
  picked.sort((a, b) => groups.findIndex((g) => g.name === a.group) - groups.findIndex((g) => g.name === b.group));
  return { delta: round2(picked.reduce((s, p) => s + p.delta, 0)), picked };
}

export { describeOptions } from "./options-text";
