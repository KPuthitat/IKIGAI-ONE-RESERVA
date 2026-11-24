// Readable names for downloaded files (owner 2026-11-24): the file name alone must say which pay round (or month,
// company, branch) the PDF / Excel / CSV was drawn from. Thai names go out as RFC 5987 `filename*` with an ASCII
// fallback for old clients.

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

const p2 = (n: number) => String(n).padStart(2, "0");

/** "2026.11.02" (Gregorian year, numbers only — owner 2026-11-24) */
export function thDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}.${p2(m)}.${p2(d)}`;
}

/** "2026.10.01-31" (one month) · "2026.10.26-11.01" (two months) · "2026.12.28-2027.01.03" (two years) · "2026.11.02" (one day) */
export function thRange(start: string, end: string): string {
  if (start === end) return thDateShort(start);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) return `${sy}.${p2(sm)}.${p2(sd)}-${p2(ed)}`;
  if (sy === ey) return `${sy}.${p2(sm)}.${p2(sd)}-${p2(em)}.${p2(ed)}`;
  return `${thDateShort(start)}-${thDateShort(end)}`;
}

/** "2026.11" */
export function thMonthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}.${p2(m)}`;
}

/** Who a pay round is for: monthly = พนักงานประจำ, weekly part-time = พาร์ทไทม์. */
export function roundKindLabel(cycle: string, target: string | null): string {
  if (cycle === "monthly") return "พนักงานประจำ";
  return target === "pt" ? "พาร์ทไทม์" : "รายสัปดาห์";
}

/** "โอนเงิน_พาร์ทไทม์_HYPOPLARAEMIA_งวด 2026.10.26-11.01_จ่าย 2026.11.02" */
export function payRoundBaseName(prefix: string, p: { cycle: string; target: string | null; period_start: string; period_end: string; pay_date: string }, branchName?: string | null): string {
  return [prefix, roundKindLabel(p.cycle, p.target), branchName || "", `งวด ${thRange(p.period_start, p.period_end)}`, `จ่าย ${thDateShort(p.pay_date)}`].filter(Boolean).join("_");
}
