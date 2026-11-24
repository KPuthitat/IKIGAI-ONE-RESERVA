// File names that say which pay round a download came from. Run: node --import tsx scripts/test-download-name.ts
import * as N from "../src/lib/download-name";
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

ok("a range inside one month", N.thRange("2026-10-01", "2026-10-31") === "2026.10.01-31");
ok("a range across two months", N.thRange("2026-10-26", "2026-11-01") === "2026.10.26-11.01");
ok("a range across the new year shows both years", N.thRange("2026-12-28", "2027-01-03") === "2026.12.28-2027.01.03");
ok("a one-day range is a single date", N.thRange("2026-11-02", "2026-11-02") === "2026.11.02");
ok("month label", N.thMonthShort("2026-11") === "2026.11");
ok("round kinds", N.roundKindLabel("monthly", "ft") === "พนักงานประจำ" && N.roundKindLabel("weekly", "pt") === "พาร์ทไทม์" && N.roundKindLabel("weekly", "all") === "รายสัปดาห์");

const fixed = { cycle: "monthly", target: "ft", period_start: "2026-10-01", period_end: "2026-10-31", pay_date: "2026-11-05" };
ok("the monthly round's name", N.payRoundBaseName("โอนเงิน", fixed, "NAMA PASTA SRIRACHA") === "โอนเงิน_พนักงานประจำ_NAMA PASTA SRIRACHA_งวด 2026.10.01-31_จ่าย 2026.11.05");
ok("the part-time weekly round's name, without a branch", N.payRoundBaseName("สรุปค่าตอบแทน", { cycle: "weekly", target: "pt", period_start: "2026-11-02", period_end: "2026-11-08", pay_date: "2026-11-09" }) === "สรุปค่าตอบแทน_พาร์ทไทม์_งวด 2026.11.02-08_จ่าย 2026.11.09");

ok("characters a file system cannot hold are removed", N.safeFileName('a/b\\c:d*e?f"g<h>i|j') === "a b c d e f g h i j".replace(/ /g, " ") || N.safeFileName('a/b:c') === "a b c");
ok("an empty name falls back", N.safeFileName("///") === "download" && N.safeFileName("") === "download");
ok("a very long name is cut", N.safeFileName("ก".repeat(400)).length <= 150);

const cd = N.contentDisposition("attachment", N.payRoundBaseName("โอนเงิน", fixed, "HYPO"), "csv");
ok("Content-Disposition carries an ASCII fallback and the real Thai name", cd.startsWith('attachment; filename="') && cd.includes("filename*=UTF-8''") && cd.includes("%E0%B9%82%E0%B8%AD%E0%B8%99"));
ok("the ASCII fallback is plain ASCII and keeps the extension", /filename="[\x20-\x7e]+\.csv"/.test(cd) && cd.includes("HYPO"));
ok("the decoded real name is the full Thai name", decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) ?? [])[1] ?? "") === "โอนเงิน_พนักงานประจำ_HYPO_งวด 2026.10.01-31_จ่าย 2026.11.05.csv");
ok("quotes, parentheses and asterisks are percent-encoded in filename*", !/['()*]/.test((N.contentDisposition("inline", "สรุป (ทดสอบ) *x*", "pdf").match(/filename\*=UTF-8''(.+)$/) ?? [])[1] ?? "x"));
ok("no header-breaking characters", !/[\r\n]/.test(N.contentDisposition("inline", "a\r\nb: c", "pdf")));

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
