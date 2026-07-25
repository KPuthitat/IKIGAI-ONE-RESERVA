// POS parser test (acceptance 6). Builds a synthetic workbook matching the
// real POS export shape and asserts the SOFT DRINK subtotal + date parse.
import * as XLSX from "xlsx";
import { parsePosBuffer, posSelectedTotal, posSelectedQty } from "../src/lib/revshare-pos";

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const same = Math.abs(Number(got) - Number(want)) < 0.005 || got === want;
  if (!same) { console.error(`✗ ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`✓ ${name} = ${got}`);
}

// preamble (varied indent) + header + rows. Discounts negative; SOFT DRINK
// subtotal has Name blank. A line item, a zero-gross CUSTOMER TYPE, and a grand
// total are present to confirm they're skipped.
const aoa: unknown[][] = [
  ["Product sales"],
  ["Date: 15/06/2026 - 21/06/2026"],
  ["Time: 00:00 - 23:59"],
  ["Merchant: Groggy and Friends"],
  [],
  ["Category", "Name", "Code", "Variant", "Qty", "Gross", "Bill discount", "Item discount", "Service charge", "VAT", "Nett"],
  ["SOFT DRINK", "Cola", "SD01", "", 12, 2000, -10, -7.52, 0, 0, 2200],
  ["SOFT DRINK", "", "", "", 20, 3545.0, -20.0, -17.52, 248.0, 248.17, 3940.65],
  ["CUSTOMER TYPE", "", "", "", 0, 0, 0, 0, 0, 0, 0],
  ["", "", "", "", "", 3545.0, 0, 0, 0, 0, 3940.65]
];

const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

const r = parsePosBuffer(buf);

eq("6.month", r.periodMonth, 6);
eq("6.year", r.periodYear, 2026);
eq("6.start", r.periodStart, "2026-06-15");
eq("6.end", r.periodEnd, "2026-06-21");
eq("6.label", r.label, "15–21 มิถุนายน 2569");

const sd = r.categories.find((c) => c.category === "SOFT DRINK");
if (!sd) { console.error("✗ SOFT DRINK subtotal not found"); failed++; }
else {
  eq("6.SOFT DRINK gross", sd.gross, 3545.0);
  eq("6.SOFT DRINK after_discount", sd.afterDiscount, 3507.48);
  eq("6.SOFT DRINK nett", sd.nett, 3940.65);
  eq("6.SOFT DRINK qty (bill count)", sd.qty, 20);
}
eq("6.only one category (CUSTOMER TYPE + total skipped)", r.categories.length, 1);
eq("6.selectedTotal gross", posSelectedTotal(r.categories, ["SOFT DRINK"], "gross"), 3545.0);
eq("6.selectedTotal nett", posSelectedTotal(r.categories, ["soft drink"], "nett"), 3940.65);
eq("6.selectedQty (bills)", posSelectedQty(r.categories, ["soft drink"]), 20);
eq("6.selectedQty unselected = 0", posSelectedQty(r.categories, ["NOPE"]), 0);

if (failed > 0) { console.error(`\nPOS TESTS FAILED: ${failed}`); process.exit(1); }
console.log("\nrevshare-pos: all tests passed");
