// Unit tests for the group-insurance SVC deduction. Run: npm run test:group-insurance
// Rule (owner 2026-08-02): ฿350/month withheld from SVC during the enrolment
// window — FT 3 calendar months, PT 12 — counting from a MANUALLY CHOSEN start
// month (month 0), NOT the hire date. NULL start month = not enrolled → 0.
// Capped at the SVC available; 0 when out of window / unknown / not enrolled.
import { groupInsuranceDeduction, calendarMonthsBetween } from "../src/lib/service-charge";

let failed = 0;
function eq(name: string, got: number, want: number): void {
  if (got !== want) { console.error(`✗ ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`✓ ${name} = ${got}`);
}

// calendarMonthsBetween (accepts YYYY-MM or a full date, sliced to YYYY-MM)
eq("same month = 0", calendarMonthsBetween("2026-06", "2026-06"), 0);
eq("next month = 1", calendarMonthsBetween("2026-06", "2026-07"), 1);
eq("across year", calendarMonthsBetween("2025-12", "2026-02"), 2);
eq("before start = negative", calendarMonthsBetween("2026-06", "2026-05"), -1);
eq("full-date arg sliced", calendarMonthsBetween("2026-06-15", "2026-07"), 1);

const big = 2000; // plenty of SVC available

// FT — first 3 months (0,1,2) deducted; month 3 onward not. Window counts from
// the chosen start month, which may be LATER than the hire date.
eq("FT month0", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-06", yearMonth: "2026-06", availablePayout: big }), 350);
eq("FT month2", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-06", yearMonth: "2026-08", availablePayout: big }), 350);
eq("FT month3 (out)", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-06", yearMonth: "2026-09", availablePayout: big }), 0);

// PT — first 12 months (0..11) deducted; month 12 not
eq("PT month0", groupInsuranceDeduction({ employmentType: "pt", startMonth: "2026-01", yearMonth: "2026-01", availablePayout: big }), 350);
eq("PT month11", groupInsuranceDeduction({ employmentType: "pt", startMonth: "2026-01", yearMonth: "2026-12", availablePayout: big }), 350);
eq("PT month12 (out)", groupInsuranceDeduction({ employmentType: "pt", startMonth: "2026-01", yearMonth: "2027-01", availablePayout: big }), 0);

// Cap at available SVC — never go negative
eq("cap when SVC < 350", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-06", yearMonth: "2026-06", availablePayout: 120 }), 120);
eq("zero SVC → 0", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-06", yearMonth: "2026-06", availablePayout: 0 }), 0);

// Guards
eq("no start month → 0 (not enrolled)", groupInsuranceDeduction({ employmentType: "ft", startMonth: null, yearMonth: "2026-06", availablePayout: big }), 0);
eq("unknown type → 0", groupInsuranceDeduction({ employmentType: null, startMonth: "2026-06", yearMonth: "2026-06", availablePayout: big }), 0);
eq("before start → 0", groupInsuranceDeduction({ employmentType: "pt", startMonth: "2026-06", yearMonth: "2026-05", availablePayout: big }), 0);

// Delayed enrolment (owner's real case): hired earlier but enrolled from 08 —
// the window runs 08,09,10 regardless of hire date.
eq("delayed FT enrol month0 (08)", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-08", yearMonth: "2026-08", availablePayout: big }), 350);
eq("delayed FT enrol still in window (10)", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-08", yearMonth: "2026-10", availablePayout: big }), 350);
eq("delayed FT enrol out (11)", groupInsuranceDeduction({ employmentType: "ft", startMonth: "2026-08", yearMonth: "2026-11", availablePayout: big }), 0);

if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log("\nAll group-insurance tests passed");
