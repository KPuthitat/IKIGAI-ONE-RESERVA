// DELIVERA walk-in (table / counter QR) ordering: queue numbers, tracking token, payment paths, wait estimate (owner 2026-10-30).
// Run via: npm run test:delivera
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-delivera-guest.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); process.env.DATABASE_PATH = TMP;
process.env.INSIGNA_SALT = process.env.INSIGNA_SALT || "test-salt-".repeat(8);
process.env.SECRET_VAULT_KEY = process.env.SECRET_VAULT_KEY || "test-vault-key-".repeat(6);
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`✓ ${n}`); else { console.error(`✗ ${n}`); failed++; } };
(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/delivera/guest");
  const O = await import("../src/lib/delivera/options");
  const { createMenuItem, setOrderStatus, getOrder } = await import("../src/lib/delivera/orders");
  const { confirmSlipManually } = await import("../src/lib/delivera/payment");
  const { setBranchSettings } = await import("../src/lib/delivera/db");
  const { applyInsignaSignal } = await import("../src/lib/delivera/hooks");
  const db = getDb();
  const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof G.GuestError ? e.code : `other:${(e as Error).message}`; } };

  const nama = Number(db.prepare("INSERT INTO branches (slug,name,delivera_enabled) VALUES ('nama','NAMA',1)").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name,delivera_enabled) VALUES ('hypo','HYPO',1)").run().lastInsertRowid);
  setBranchSettings(nama, { promptpay_id: "0812345678", default_prep_minutes: 10 });
  const tea = createMenuItem(nama, { name_th: "ชานม", price: 40 });
  O.saveItemOptions(nama, tea, [{ name: "ขนาด", minPick: 1, maxPick: 1, choices: [{ name: "ธรรมดา", priceDelta: 0 }, { name: "ใหญ่", priceDelta: 10 }] }]);
  const big = O.listOptionGroups([tea]).get(tea)![0].choices[1].id;
  const item = (qty = 1) => ({ menu_item_id: tea, qty, choice_ids: [big] });

  const a = G.createGuestOrder({ branchId: nama, tableLabel: "5", name: "บี", items: [item(2)] });
  const b = G.createGuestOrder({ branchId: nama, items: [item()] });
  const other = G.createGuestOrder({ branchId: hypo, items: [{ menu_item_id: createMenuItem(hypo, { name_th: "x", price: 5 }), qty: 1 }] });
  ok("the first order of the day is queue 1, the next 2; another branch starts its own queue", a.queueNo === 1 && b.queueNo === 2 && other.queueNo === 1);
  ok("the token is 32 hex characters and unguessable per order", /^[0-9a-f]{32}$/.test(a.token) && a.token !== b.token);
  ok("the server prices the order with the option add-on: (40+10)×2 = 100", a.total === 100);
  const v = G.guestView(a.token)!;
  ok("the view shows queue, table, service mode, items with options, step 1 awaiting payment", v.queueNo === 1 && v.tableLabel === "5" && v.service === "dine_in" && v.items[0].options === "ขนาด: ใหญ่" && v.step === 1 && v.status === "pending_payment");
  ok("an order without a table is a pick-up", G.guestView(b.token)!.service === "pickup");
  ok("a wrong or malformed token shows nothing", G.guestView("x") === null && G.guestView("0".repeat(32)) === null);

  const pay = G.guestPayInfo(a.token)!;
  ok("PromptPay info is a QR payload for the exact total", pay.total === 100 && !!pay.qrPayload && pay.qrPayload.includes("5406100.00"));

  G.guestMarkPaid(a.token);
  ok("'I have paid' waits for the manager: pay status pending_verify, still awaiting payment", getOrder(1)!.pay_status === "pending_verify" && getOrder(1)!.status === "pending_payment");
  confirmSlipManually(1);
  ok("the manager's confirmation makes it paid (step 2)", getOrder(1)!.status === "paid" && G.guestView(a.token)!.step === 2);
  ok("a paid order cannot be paid again", code(() => G.guestMarkPaid(a.token)) === "not_payable" && code(() => G.guestPayAtCounter(a.token)) === "not_payable");

  G.guestPayAtCounter(b.token);
  ok("paying at the counter sends it straight to the kitchen (confirmed)", getOrder(2)!.status === "confirmed" && getOrder(2)!.pay_method === "cod");
  setBranchSettings(nama, { cod_enabled: false });
  const c = G.createGuestOrder({ branchId: nama, items: [item()] });
  ok("the counter option can be switched off per branch", code(() => G.guestPayAtCounter(c.token)) === "cod_disabled");
  setBranchSettings(nama, { cod_enabled: true });

  const s = G.queueStats(nama);
  ok("the board counts paid/accepted/cooking orders: 2 in progress → est = 10 + 2×2 = 14 min", s.inProgress === 2 && s.estMinutes === 14);
  setOrderStatus(1, "preparing");
  const vb = G.guestView(b.token)!;
  ok("an order's own wait counts only the orders ahead of it (order 1 is ahead of order 2)", vb.ahead === 1 && vb.estMinutes === 12 && G.guestView(a.token)!.ahead === 0 && G.guestView(a.token)!.step === 3);
  setOrderStatus(1, "ready");
  ok("ready is step 4 and no longer waits", G.guestView(a.token)!.step === 4 && G.guestView(a.token)!.estMinutes === 0);

  db.prepare("UPDATE delivery_orders SET created_at = datetime('now', '-2 days') WHERE branch_id = ?").run(nama);
  ok("the queue number starts again each day", G.createGuestOrder({ branchId: nama, items: [item()] }).queueNo === 1);

  setBranchSettings(nama, { hook_record_insigna: true });
  applyInsignaSignal(getOrder(1)!);
  ok("a walk-in is never recorded as an INSIGNA customer", getOrder(1)!.insigna_recorded === 0);

  const key = "ip-test";
  const results = Array.from({ length: 10 }, () => G.allowGuestOrder(key, 1_000_000));
  ok("at most 8 orders per hour per address, then it recovers", results.filter(Boolean).length === 8 && !G.allowGuestOrder(key, 1_000_000) && G.allowGuestOrder(key, 1_000_000 + 3_700_000));
  void other;
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
