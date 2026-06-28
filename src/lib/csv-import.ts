// Shared CSV-import helpers (server-only) used by the ACCOUNTA expense + income
// bulk importers. Kept tiny + dependency-free so both routes parse identically.

/** Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF, leading
 *  BOM. Returns rows of string cells (blank rows dropped). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch === "\r") { /* skip */ }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export const truthy = (v: string) => /^(1|true|yes|y|ใช่|มี)$/i.test(v.trim());

/** Excel rewrites CSV dates into the locale format (Thai = DD/MM/YYYY) the
 *  moment the file is opened before upload, which made a strict YYYY-MM-DD check
 *  reject every row (owner 2026-06-27). Accept YYYY-MM-DD as-is, and convert a
 *  day-first DD/MM/YYYY or DD-MM-YYYY — incl. a Buddhist year (>2500 → −543).
 *  Returns the normalised YYYY-MM-DD, or null when unparseable. */
export function normDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y > 2500) y -= 543;
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}
