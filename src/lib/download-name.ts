// Readable names for downloaded files (owner 2026-11-24): the file name alone must say which pay round (or month,
// company, branch) the PDF / Excel / CSV was drawn from. Thai names go out as RFC 5987 `filename*` with an ASCII
// fallback for old clients.

const TH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** Remove what a file system or a header cannot carry; keep Thai, letters, digits, space, ( ) . - _ & */
export function safeFileName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*_\s*/g, "_")
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .slice(0, 150) || "download";
}

/** Content-Disposition for `<base>.<ext>`: `filename` (ASCII fallback) + `filename*` (the real, Thai name). */
export function contentDisposition(kind: "attachment" | "inline", base: string, ext: string): string {
  const name = safeFileName(base);
  const full = `${name}.${ext}`;
  const ascii = `${safeFileName(name.replace(/[^\x20-\x7e]+/g, " ")).replace(/[_\s]{2,}/g, "_") || "download"}.${ext}`;
  const enc = encodeURIComponent(full).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii.replace(/"/g, "")}"; filename*=UTF-8''${enc}`;
}

/** "26 ต.ค. 2569" */
export function thDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_SHORT[m - 1]} ${y + 543}`;
}

/** "1-31 ต.ค. 2569" · "26 ต.ค.-1 พ.ย. 2569" · "28 ธ.ค. 2569-3 ม.ค. 2570" */
export function thRange(start: string, end: string): string {
  if (start === end) return thDateShort(start);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) return `${sd}-${ed} ${TH_SHORT[em - 1]} ${ey + 543}`;
  if (sy === ey) return `${sd} ${TH_SHORT[sm - 1]}-${ed} ${TH_SHORT[em - 1]} ${ey + 543}`;
  return `${thDateShort(start)}-${thDateShort(end)}`;
}

/** "ต.ค. 2569" */
export function thMonthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${TH_SHORT[m - 1]} ${y + 543}`;
}

/** Who a pay round is for: monthly = พนักงานประจำ, weekly part-time = พาร์ทไทม์. */
export function roundKindLabel(cycle: string, target: string | null): string {
  if (cycle === "monthly") return "พนักงานประจำ";
  return target === "pt" ? "พาร์ทไทม์" : "รายสัปดาห์";
}

/** "โอนเงิน_พาร์ทไทม์_HYPOPLARAEMIA_งวด 26 ต.ค.-1 พ.ย. 2569_จ่าย 2 พ.ย. 2569" */
export function payRoundBaseName(prefix: string, p: { cycle: string; target: string | null; period_start: string; period_end: string; pay_date: string }, branchName?: string | null): string {
  return [prefix, roundKindLabel(p.cycle, p.target), branchName || "", `งวด ${thRange(p.period_start, p.period_end)}`, `จ่าย ${thDateShort(p.pay_date)}`].filter(Boolean).join("_");
}
