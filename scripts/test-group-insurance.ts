// Unit tests for the group-insurance SVC deduction. Run: npm run test:group-insurance
// Rule (owner 2026-08-02): ฿350/month withheld from SVC during the new-hire
// window — FT first 3 calendar months, PT first 12 — counting from hire_date's
// month (month 0). Capped at the SVC available; 0 when out of window / unknown.
import { groupInsuranceDeduction, calendarMonthsSinceHire } from "../src/lib/service-charge";

let failed = 0;
function eq(name: string, got: number, want: number): void {
  if (got !== want) { console.error(`✗ ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`✓ ${name} = ${got}`);
}

// calendarMonthsSinceHire
eq("same month = 0", calendarMonthsSinceHire("2026-06-15", "2026-06"), 0);
eq("next month = 1", calendarMonthsSinceHire("2026-06-15", "2026-07"), 1);
eq("across year", calendarMonthsSinceHire("2025-12-01", "2026-02"), 2);
eq("before hire = negative", calendarMonthsSinceHire("2026-06-01", "2026-05"), -1);

const big = 2000; // plenty of SVC available

// FT — first 3 months (0,1,2) deducted; month 3 onward not
eq("FT month0", groupInsuranceDeduction({ employmentType: "ft", hireDate: "2026-06-10", yearMonth: "2026-06", availablePayout: big }), 350);
eq("FT month2", groupInsuranceDeduction({ employmentType: "ft", hireDate: "2026-06-10", yearMonth: "2026-08", availablePayout: big }), 350);
eq("FT month3 (out)", groupInsuranceDeduction({ employmentType: "ft", hireDate: "2026-06-10", yearMonth: "2026-09", availablePayout: big }), 0);

// PT — first 12 months (0..11) deducted; month 12 not
eq("PT month0", groupInsuranceDeduction({ employmentType: "pt", hireDate: "2026-01-01", yearMonth: "2026-01", availablePayout: big }), 350);
eq("PT month11", groupInsuranceDeduction({ employmentType: "pt", hireDate: "2026-01-01", yearMonth: "2026-12", availablePayout: big }), 350);
eq("PT month12 (out)", groupInsuranceDeduction({ employmentType: "pt", hireDate: "2026-01-01", yearMonth: "2027-01", availablePayout: big }), 0);

// Cap at available SVC — never go negative
eq("cap when SVC < 350", groupInsuranceDeduction({ employmentType: "ft", hireDate: "2026-06-01", yearMonth: "2026-06", availablePayout: 120 }), 120);
eq("zero SVC → 0", groupInsuranceDeduction({ employmentType: "ft", hireDate: "2026-06-01", yearMonth: "2026-06", availablePayout: 0 }), 0);

// Guards
eq("no hire_date → 0", groupInsuranceDeduction({ employmentType: "ft", hireDate: null, yearMonth: "2026-06", availablePayout: big }), 0);
eq("unknown type → 0", groupInsuranceDeduction({ employmentType: null, hireDate: "2026-06-01", yearMonth: "2026-06", availablePayout: big }), 0);
eq("before hire → 0", groupInsuranceDeduction({ employmentType: "pt", hireDate: "2026-06-01", yearMonth: "2026-05", availablePayout: big }), 0);

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log("\nAll group-insurance tests passed");
