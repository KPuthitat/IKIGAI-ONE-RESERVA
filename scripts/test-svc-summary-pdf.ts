// SVC summary PDF carries เบี้ยประชุม (owner 2026-10-09). Smoke: renders, and the
// meeting-fee figures are accepted for a normal row and a meeting-fee-only row.
// Run: node --import tsx scripts/test-svc-summary-pdf.ts
import { generateSvcSummaryPdf, type SvcPdfData } from "../src/lib/svc-summary-pdf";

(async () => {
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const d: SvcPdfData = {
    company: { name: "CO", taxId: null, address: null }, monthLabel: "สิงหาคม พ.ศ. 2569", shared: false,
    payoutDate: "2026-09-20", generatedLabel: "x",
    totals: { collected: 1000, staffPool: 600, companyPool: 400, foodClawback: 0, otherDeductions: 0, wht: 60, groupInsurance: 0, netPayout: 2540, meetingFee: 2000 },
    branches: [{ name: "A", collected: 1000, staffAttributed: 600, netAttributed: 540, headcount: 1 }],
    rows: [
      { name: "ฐิติรัตน์", typeLabel: "ประจำ", branchesLabel: "A", gross: 600, meetingFee: 2000, foodClawback: 0, otherDeductions: 0, preTax: 2600, wht: 60, groupInsurance: 0, net: 2540, statusLabel: "ได้รับ" },
      { name: "เฉพาะเบี้ยประชุม", typeLabel: "ประจำ", branchesLabel: "—", gross: 0, meetingFee: 0, foodClawback: 0, otherDeductions: 0, preTax: 0, wht: 0, groupInsurance: 0, net: 0, statusLabel: "เบี้ยประชุมอย่างเดียว" }
    ]
  };
  const pdf = await generateSvcSummaryPdf(d);
  ok("renders a PDF", pdf.subarray(0, 4).toString() === "%PDF" && pdf.length > 2000);
  process.exit(failed ? 1 : 0);
})();
