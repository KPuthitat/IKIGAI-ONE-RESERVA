// File names that say which pay round a download came from — English / ASCII only.
// Run: node --import tsx scripts/test-download-name.ts
import * as N from "../src/lib/download-name";
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

ok("a range inside one month", N.rangeTok("2026-10-01", "2026-10-31") === "2026.10.01-31");
ok("a range across two months", N.rangeTok("2026-10-26", "2026-11-01") === "2026.10.26-11.01");
ok("a range across the new year shows both years", N.rangeTok("2026-12-28", "2027-01-03") === "2026.12.28-2027.01.03");
ok("a one-day range is a single date", N.rangeTok("2026-11-02", "2026-11-02") === "2026.11.02");
ok("date and month tokens", N.dateTok("2026-11-02") === "2026.11.02" && N.monthTok("2026-11") === "2026.11");
ok("round kinds are English", N.roundKindLabel("monthly", "ft") === "FullTime" && N.roundKindLabel("weekly", "pt") === "PartTime" && N.roundKindLabel("weekly", "all") === "Weekly");

const fixed = { cycle: "monthly", target: "ft", period_start: "2026-10-01", period_end: "2026-10-31", pay_date: "2026-11-05" };
ok("the monthly round's name", N.payRoundBaseName("BankTransfer", fixed, "NAMA-PASTA-SRIRACHA") === "BankTransfer_FullTime_NAMA-PASTA-SRIRACHA_Period-2026.10.01-31_Pay-2026.11.05");
ok("the part-time weekly round's name, without a branch", N.payRoundBaseName("RoundSummary", { cycle: "weekly", target: "pt", period_start: "2026-11-02", period_end: "2026-11-08", pay_date: "2026-11-09" }) === "RoundSummary_PartTime_Period-2026.11.02-08_Pay-2026.11.09");

ok("a token keeps English and digits, spaces become dashes", N.token("NAMA PASTA SRIRACHA", "x") === "NAMA-PASTA-SRIRACHA");
ok("Thai is dropped from a token; an all-Thai name falls back", N.token("HYPO ศาลา", "x") === "HYPO" && N.token("ศาลาชิลล์", "Company-3") === "Company-3" && N.token(null, "U7") === "U7" && N.token("", "U7") === "U7");
ok("the file name is pure ASCII even if Thai is passed in", /^[\x20-\x7e]+$/.test(N.safeFileName("โอนเงิน_Hypo_งวด 2026.10.01-31")) && N.safeFileName("โอนเงิน_Hypo") === "Hypo");
ok("characters a file system cannot hold are removed", N.safeFileName("a/b\\c:d*e?f\"g<h>i|j") === "a-b-c-d-e-f-g-h-i-j");
ok("an empty or all-Thai name falls back", N.safeFileName("///") === "download" && N.safeFileName("") === "download" && N.safeFileName("ทดสอบ") === "download");
ok("a very long name is cut", N.safeFileName("A".repeat(400)).length <= 150);

const cd = N.contentDisposition("attachment", N.payRoundBaseName("BankTransfer", fixed, "HYPO"), "csv");
ok("Content-Disposition is a plain ASCII filename", cd === 'attachment; filename="BankTransfer_FullTime_HYPO_Period-2026.10.01-31_Pay-2026.11.05.csv"');
ok("no header-breaking characters", !/[\r\n"]{2}/.test(N.contentDisposition("inline", "a\r\nb: c\"d", "pdf")) && !/[\r\n]/.test(N.contentDisposition("inline", "a\r\nb: c", "pdf")));
ok("the extension is kept", N.contentDisposition("inline", "x", "pdf").endsWith('x.pdf"'));

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
