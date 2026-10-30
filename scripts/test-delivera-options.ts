// DELIVERA menu option groups: validation, server-side pricing and the order-line snapshot (owner 2026-10-30).
// Run via: npm run test:delivera
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-delivera-options.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); process.env.DATABASE_PATH = TMP;
process.env.INSIGNA_SALT = process.env.INSIGNA_SALT || "test-salt-".repeat(8);   // order creation hashes the LINE id
process.env.SECRET_VAULT_KEY = process.env.SECRET_VAULT_KEY || "test-vault-key-".repeat(6);
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`✓ ${n}`); else { console.error(`✗ ${n}`); failed++; } };
(async () => {
  const { getDb } = await import("../src/lib/db");
  const O = await import("../src/lib/delivera/options");
  const { createMenuItem, createOrder, getOrderItems, OrderError } = await import("../src/lib/delivera/orders");
  const db = getDb();
  const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof O.OptionError || e instanceof OrderError ? e.code : `other:${(e as Error).message}`; } };

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const tea = createMenuItem(branch, { name_th: "ชานม", price: 40 });
  const plain = createMenuItem(branch, { name_th: "น้ำเปล่า", price: 10 });
  const foreign = createMenuItem(other, { name_th: "ชาอื่น", price: 40 });

  ok("saving options for another branch's item is refused", O.saveItemOptions(other, tea, []) === false);
  ok("bad groups are refused (no choices, min>max, blank names)", code(() => O.saveItemOptions(branch, tea, [{ name: "ขนาด", minPick: 1, maxPick: 1, choices: [] }])) === "option_bad_input"
    && code(() => O.saveItemOptions(branch, tea, [{ name: "ขนาด", minPick: 2, maxPick: 1, choices: [{ name: "a", priceDelta: 0 }] }])) === "option_bad_input"
    && code(() => O.saveItemOptions(branch, tea, [{ name: " ", minPick: 0, maxPick: 1, choices: [{ name: "a", priceDelta: 0 }] }])) === "option_bad_input");
  O.saveItemOptions(branch, tea, [
    { name: "ขนาด", minPick: 1, maxPick: 1, choices: [{ name: "ธรรมดา", priceDelta: 0 }, { name: "ใหญ่", priceDelta: 10 }] },
    { name: "ความหวาน", minPick: 1, maxPick: 1, choices: [{ name: "50%", priceDelta: 0 }, { name: "25%", priceDelta: 0 }] },
    { name: "ท็อปปิ้ง", minPick: 0, maxPick: 2, choices: [{ name: "ไข่มุก", priceDelta: 10 }, { name: "ครีมชีส", priceDelta: 15 }, { name: "หมด", priceDelta: 5, available: false }] }
  ]);
  const g = O.listOptionGroups([tea, plain]);
  ok("groups come back in order with their choices; an item without options has none", g.get(tea)!.map((x) => x.name).join() === "ขนาด,ความหวาน,ท็อปปิ้ง" && g.get(tea)![2].choices.length === 3 && !g.has(plain));
  const ids = (name: string) => g.get(tea)!.flatMap((x) => x.choices).find((c) => c.name === name)!.id;

  const p = O.priceChoices(tea, [ids("ใหญ่"), ids("25%"), ids("ไข่มุก"), ids("ครีมชีส")]);
  ok("picks are priced: ใหญ่ +10, ไข่มุก +10, ครีมชีส +15 = +35, listed in group order", p.delta === 35 && p.picked.map((x) => x.group).join() === "ขนาด,ความหวาน,ท็อปปิ้ง,ท็อปปิ้ง");
  ok("a required group left out is refused", code(() => O.priceChoices(tea, [ids("ใหญ่")])) === "option_required");
  ok("too many picks in a group is refused", code(() => O.priceChoices(tea, [ids("ใหญ่"), ids("50%"), ids("ไข่มุก"), ids("ครีมชีส"), ids("หมด")])) !== null);
  ok("two choices of a single-pick group is refused", code(() => O.priceChoices(tea, [ids("ใหญ่"), ids("ธรรมดา"), ids("50%")])) === "option_too_many");
  ok("a sold-out choice is refused", code(() => O.priceChoices(tea, [ids("ใหญ่"), ids("50%"), ids("หมด")])) === "option_unavailable");
  const f = createMenuItem(other, { name_th: "x", price: 1 });
  O.saveItemOptions(other, f, [{ name: "ขนาด", minPick: 0, maxPick: 1, choices: [{ name: "ใหญ่", priceDelta: 99 }] }]);
  const fid = O.listOptionGroups([f]).get(f)![0].choices[0].id;
  ok("a choice that belongs to another item is refused", code(() => O.priceChoices(tea, [ids("ใหญ่"), ids("50%"), fid])) === "option_invalid");
  ok("an item with no options needs and accepts none", O.priceChoices(plain, []).delta === 0 && code(() => O.priceChoices(plain, [ids("ใหญ่")])) === "option_invalid");

  const base = { branchId: branch, lineUserId: "Utest", fulfillment: "pickup" as const };
  const r = createOrder({ ...base, items: [{ menu_item_id: tea, qty: 2, choice_ids: [ids("ใหญ่"), ids("25%"), ids("ไข่มุก")] }, { menu_item_id: plain, qty: 1 }] });
  ok("the server prices the order: (40+10+10)×2 + 10 = 130", r.subtotal === 130 && r.total === 130);
  const lines = getOrderItems(r.id);
  ok("the line keeps a readable snapshot and the unit price with add-ons", lines[0].unit_price === 60 && lines[0].line_total === 120 && O.describeOptions(lines[0].options_json) === "ขนาด: ใหญ่ · ความหวาน: 25% · ท็อปปิ้ง: ไข่มุก");
  ok("a plain item keeps the legacy empty options value", lines[1].options_json === "{}" && O.describeOptions(lines[1].options_json) === "");
  ok("an order missing a required option is refused with the option code", code(() => createOrder({ ...base, items: [{ menu_item_id: tea, qty: 1 }] })) === "option_required");
  ok("a client cannot underprice by sending a price-less foreign choice", code(() => createOrder({ ...base, items: [{ menu_item_id: tea, qty: 1, choice_ids: [ids("ใหญ่"), ids("50%"), fid] }] })) === "option_invalid");
  ok("replacing options removes the old groups and choices", (() => { O.saveItemOptions(branch, tea, []); return !O.listOptionGroups([tea]).has(tea) && (db.prepare("SELECT COUNT(*) n FROM delivera_option_choices WHERE group_id IN (SELECT id FROM delivera_option_groups WHERE menu_item_id = ?)").get(tea) as { n: number }).n === 0; })());
  void foreign;
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
