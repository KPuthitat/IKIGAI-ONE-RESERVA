// Readable names for downloaded files (owner 2026-11-24): the file name alone must say which pay round (or month,
// company, branch) the PDF / Excel / CSV was drawn from. English / ASCII only, upper case (owner: "ENG only", "พิมพ์ใหญ่หมด") — Thai names are
// replaced by an English name, the slug, the employee code or an id, so the name is the same everywhere.

/** ASCII-only token: Thai and other characters dropped, spaces and symbols → "-". Empty → `fallback`. */
export function token(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").replace(/[^\x20-\x7e]+/g, " ").replace(/[^A-Za-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return t || fallback;
}

/** Remove what a file system or a header cannot carry; ASCII only, UPPER CASE (owner 2026-11-24). */
export function safeFileName(s: string): string {
  return s.toUpperCase().replace(/[^\x20-\x7e]+/g, " ").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, "-").replace(/_{2,}/g, "_").replace(/^[\s._-]+|[\s._-]+$/g, "").slice(0, 150) || "DOWNLOAD";
}

/** Content-Disposition for `<base>.<ext>`. */
export function contentDisposition(kind: "attachment" | "inline", base: string, ext: string): string {
  return `${kind}; filename="${safeFileName(base).replace(/"/g, "")}.${ext}"`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "2026.11.02" */
export function dateTok(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}.${p2(m)}.${p2(d)}`;
}

/** "2026.10.01-31" (one month) · "2026.10.26-11.01" (two months) · "2026.12.28-2027.01.03" (two years) · "2026.11.02" (one day) */
export function rangeTok(start: string, end: string): string {
  if (start === end) return dateTok(start);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) return `${sy}.${p2(sm)}.${p2(sd)}-${p2(ed)}`;
  if (sy === ey) return `${sy}.${p2(sm)}.${p2(sd)}-${p2(em)}.${p2(ed)}`;
  return `${dateTok(start)}-${dateTok(end)}`;
}

/** "2026.11" */
export function monthTok(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}.${p2(m)}`;
}

/** Who a pay round is for: monthly = FullTime, weekly part-time = PartTime. */
export function roundKindLabel(cycle: string, target: string | null): string {
  if (cycle === "monthly") return "FullTime";
  return target === "pt" ? "PartTime" : "Weekly";
}

/** "BankTransfer_PartTime_HYPOPLARAEMIA_Period-2026.10.26-11.01_Pay-2026.11.02" */
export function payRoundBaseName(prefix: string, p: { cycle: string; target: string | null; period_start: string; period_end: string; pay_date: string }, branchToken?: string | null): string {
  return [prefix, roundKindLabel(p.cycle, p.target), branchToken || "", `Period-${rangeTok(p.period_start, p.period_end)}`, `Pay-${dateTok(p.pay_date)}`].filter(Boolean).join("_");
}
