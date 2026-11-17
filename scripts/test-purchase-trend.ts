// Purchases per supplier vs sales. Run: node --import tsx scripts/test-purchase-trend.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-purchase-trend.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const T = await import("../src/lib/purchase-trend");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const b1 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','A')").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','B')").run().lastInsertRowid);
  const sale = (b: number, d: string, nett: number, has = 1) => db.prepare("INSERT INTO salesa_daily (branch_id, sale_date, nett, has_sales) VALUES (?,?,?,?)").run(b, d, nett, has);
  const vend = (n: string) => Number(db.prepare("INSERT INTO accounta_vendors (name) VALUES (?)").run(n).lastInsertRowid);
  const bill = (b: number, d: string, name: string | null, amt: number, status = "confirmed", vid: number | null = null) =>
    db.prepare("INSERT INTO accounta_expenses (branch_id, bill_date, vendor_id, vendor_name, amount_total, review_status) VALUES (?,?,?,?,?,?)").run(b, d, vid, name, amt, status);

  // 2026-11-02 is a Monday. Weeks: W1 = 02–08, W2 = 09–15 (previous window), W3 = 16–22, W4 = 23–29 (recent window).
  // Previous: sales 30,000/week, ice 2,000. Recent: sales 20,000/week, ice 4,000 — the owner's example.
  for (const [d, v] of [["2026-11-02", 15000], ["2026-11-05", 15000], ["2026-11-09", 15000], ["2026-11-12", 15000], ["2026-11-16", 10000], ["2026-11-19", 10000], ["2026-11-23", 10000], ["2026-11-26", 10000]] as const) sale(b1, d, v);
  sale(b1, "2026-11-03", 99999, 0);                  // not imported as sales: ignored
  sale(b2, "2026-11-02", 5000);                      // another branch: ignored
  const polar = vend("โพลาร์ แบร์ มิชชั่น");
  bill(b1, "2026-11-03", null, 1000, "confirmed", polar); bill(b1, "2026-11-10", "โพลาร์ แบร์ มิชชั่น", 1000);   // linked + typed name = one supplier
  bill(b1, "2026-11-17", "โพลาร์ แบร์ มิชชั่น", 2000); bill(b1, "2026-11-24", "โพลาร์ แบร์ มิชชั่น", 2000);
  bill(b1, "2026-11-10", "ผักสด", 500); bill(b1, "2026-11-24", "ผักสด", 500);
  bill(b1, "2026-11-05", "ร่าง", 9999, "draft");     // unconfirmed: ignored
  bill(b1, "2026-11-05", null, 777);                 // no supplier: ignored
  bill(b1, "2026-11-05", "   ", 888);                // blank supplier: ignored
  bill(b2, "2026-11-05", "โพลาร์ แบร์ มิชชั่น", 4444); // another branch: ignored

  ok("week starts on Monday", T.weekStart("2026-11-08") === "2026-11-02" && T.weekStart("2026-11-09") === "2026-11-09" && T.weekStart("2026-11-02") === "2026-11-02");
  const t = T.purchaseTrend(db, b1, "2026-11-02", "2026-11-29", "week");
  ok("four weekly buckets, Monday keys", t.keys.join(",") === "2026-11-02,2026-11-09,2026-11-16,2026-11-23");
  ok("sales per week count only imported days of this branch", t.sales.join(",") === "30000,30000,20000,20000" && t.salesDays.join(",") === "2,2,2,2");
  ok("suppliers merge linked and typed names, biggest first", t.vendors.map((v) => v.name).join("|") === "โพลาร์ แบร์ มิชชั่น|ผักสด" && t.vendors[0].amounts.join(",") === "1000,1000,2000,2000");
  ok("draft, blank and other-branch bills are left out", t.total.join(",") === "1000,1500,2000,2500");

  const sh = T.vendorShifts(t, 2);
  const ice = sh.find((s) => s.name.startsWith("โพลาร์"))!;
  ok("the first row is everything together", sh[0].name === "รวมทุกผู้ขาย");
  ok("ice: previous 60,000 sales / 2,000 bought = 3.33%", ice.previous.sales === 60000 && ice.previous.purchase === 2000 && ice.previous.ratio === 3.33);
  ok("ice: recent 40,000 sales / 4,000 bought = 10%", ice.recent.sales === 40000 && ice.recent.purchase === 4000 && ice.recent.ratio === 10);
  ok("ice: ratio up 6.67 points, purchases +100%, sales −33.33%", ice.ratioDeltaPct === 6.67 && ice.purchaseChangePct === 100 && ice.salesChangePct === -33.33);
  ok("buying more while selling less is flagged", ice.flag === "up_while_sales_down");
  const veg = sh.find((s) => s.name === "ผักสด")!;
  ok("vegetables: same buying with lower sales = ratio up 50% (judged relative to its own ratio)", veg.recent.purchase === veg.previous.purchase && veg.ratioChangePct === 50 && veg.flag === "ratio_up");
  ok("ice ratio change is +200% relative", ice.ratioChangePct === 200);

  const d = T.purchaseTrend(db, b1, "2026-11-02", "2026-11-04", "day");
  ok("daily view: a bucket per day, a day without sales shows 0 sales", d.keys.length === 3 && d.sales.join(",") === "15000,0,0" && d.vendors[0].amounts.join(",") === "0,1000,0");
  ok("a ratio needs sales", T.ratioPct(100, 0) === null && T.ratioPct(100, 1000) === 10);
  const m = T.purchaseTrend(db, b1, "2026-10-15", "2026-11-29", "month");
  ok("monthly view: Oct is empty, Nov holds everything", m.keys.join(",") === "2026-10,2026-11" && m.sales[0] === 0 && m.sales[1] === 100000);
  ok("a window longer than the data still compares what exists", (() => { const s = T.vendorShifts(m, 6); return s[0].recent.sales === 100000 && s[0].previous.sales === 0 && s[0].flag === "no_data"; })());
  const r = T.defaultRange("week", "2026-11-15");
  ok("default weekly range is 16 weeks ending today", r.to === "2026-11-15" && r.from === "2026-07-27");

  // ── LINE card: only the suppliers bought from more relative to sales ──
  const C = await import("../src/lib/purchase-trend-card");
  const mk = (name: string, flag: import("../src/lib/purchase-trend").VendorShift["flag"], pp: number, rp: number, ps: number, rs: number): import("../src/lib/purchase-trend").VendorShift => {
    const pr = ps > 0 ? Math.round((pp / ps) * 10000) / 100 : null, rr = rs > 0 ? Math.round((rp / rs) * 10000) / 100 : null;
    return { name, flag, previous: { sales: ps, purchase: pp, ratio: pr }, recent: { sales: rs, purchase: rp, ratio: rr }, ratioDeltaPct: pr != null && rr != null ? Math.round((rr - pr) * 100) / 100 : null, ratioChangePct: null,
      purchaseChangePct: pp > 0 ? Math.round(((rp - pp) / pp) * 10000) / 100 : null, salesChangePct: ps > 0 ? Math.round(((rs - ps) / ps) * 10000) / 100 : null };
  };
  const all = [mk("รวมทุกผู้ขาย", "up_while_sales_down", 5000, 9000, 60000, 40000), mk("ก. ซื้อมากขึ้นขายลด", "up_while_sales_down", 2000, 4000, 60000, 40000), mk("ข. สัดส่วนสูงขึ้น", "ratio_up", 500, 500, 60000, 40000),
    mk("ค. ลดลง", "ratio_down", 4000, 1000, 60000, 40000), mk("ง. ใกล้เคียง", "steady", 1000, 700, 60000, 40000), mk("จ. ไม่พอเทียบ", "no_data", 0, 0, 0, 0), mk("ฉ. เริ่มซื้อ", "ratio_up", 0, 800, 60000, 40000)];
  const picked = T.buyingMoreShifts(all);
  ok("the card list holds only suppliers bought from more: not the total row, not lower / steady / no-data", picked.map((x) => x.name).join("|") === "ก. ซื้อมากขึ้นขายลด|ฉ. เริ่มซื้อ|ข. สัดส่วนสูงขึ้น");
  ok("…worst first: buying more while sales fell, then the biggest rise in the ratio", picked[0].name === "ก. ซื้อมากขึ้นขายลด" && picked[0].flag === "up_while_sales_down");
  const meta = { branchName: "NAMA", bucket: "week" as const, windowSize: 4, operator: "ผู้ดูแล", color: "#0e2724", link: "https://example.test/admin/reporta/purchase?b=week" };
  const card = C.purchaseBuyingMoreFlex(picked, meta);
  const cj = JSON.stringify(card);
  ok("the card names the picked suppliers and none of the others", cj.includes("ก. ซื้อมากขึ้นขายลด") && cj.includes("ข. สัดส่วนสูงขึ้น") && !cj.includes("ค. ลดลง") && !cj.includes("ง. ใกล้เคียง") && !cj.includes("จ. ไม่พอเทียบ") && !cj.includes("รวมทุกผู้ขาย"));
  ok("the card shows the ratio before → after, in words not +/- signs, with the period and a link", cj.includes("→") && cj.includes("เพิ่มขึ้น") && cj.includes("ลดลง") && !/[+]\d/.test(cj) && cj.includes("4 สัปดาห์ล่าสุด เทียบ 4 สัปดาห์ก่อนหน้า") && cj.includes("https://example.test/admin/reporta/purchase?b=week"));
  ok("a supplier newly bought from is labelled as such", cj.includes("เริ่มซื้อ") && cj.includes("ซื้อใหม่"));
  ok("the alt text says how many", card.altText.includes("3 ผู้ขาย") && card.altText.includes("NAMA"));
  ok("more than 10 suppliers: the card shows 10 and says how many more", (() => {
    const many = Array.from({ length: 13 }, (_, i) => mk(`ผู้ขาย ${i + 1}`, "ratio_up", 100, 300, 60000, 40000));
    const j = JSON.stringify(C.purchaseBuyingMoreFlex(T.buyingMoreShifts(many), meta));
    return j.includes("พบ 13 ผู้ขาย") && j.includes("และอีก 3 ผู้ขาย") && (j.match(/สัดส่วนซื้อ ÷ ขาย  /g) ?? []).length === 10;
  })());
  ok("from the real figures of the fixture: the ice supplier (bought 2,000 → 4,000 while sales fell) comes first", (() => {
    const w = T.purchaseTrend(db, b1, "2026-11-02", "2026-11-29", "week");
    const list = T.buyingMoreShifts(T.vendorShifts(w, 2));
    return list.length >= 1 && list[0].name === "โพลาร์ แบร์ มิชชั่น" && list[0].flag === "up_while_sales_down";
  })());

  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
