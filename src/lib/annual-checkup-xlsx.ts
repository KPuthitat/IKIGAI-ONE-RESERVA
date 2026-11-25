// Annual check-up programme — reads the planning workbook (phase 3, docs/annual-checkup-plan.md §6). Pure: no database, so it can be
// unit-tested with a workbook built in memory. The importer (annual-checkup-import.ts) matches what is read here to staff and writes it.
//
// Sheets used (by name, with a header-based fallback for the first one):
//   • รายการตรวจรายบุคคล   one row per person: code, name, who pays, a "ตรวจปอดเพิ่ม" flag, then one column per test with
//                          ✓ (ordered) / งด (waived) / แล็บนอก (external lab) / blank (not in the programme) and a totals row
//   • โปรแกรมตามบริษัท      the programme of each paying company: ✓ = everyone, "เฉพาะคนที่ระบุ" = only people flagged ตรวจปอดเพิ่ม
//   • รายชื่อตรวจสุขภาพ      staff details (prefix / first / last name) used only to cross-check the names
// Every other sheet in the file (สรุป, per-company sheets, ตั้งค่า, ข้อมูลที่ต้องตรวจสอบ) is derived from these and is ignored.
import * as XLSX from "xlsx";

export type ParsedMark = "ordered" | "waived" | "external_lab";
export type ParsedPerson = {
  sheetRow: number;                       // 1-based row in the sheet (for messages)
  kind: "employee" | "placeholder" | "named";   // named = a named row with no employee code (maybe an outside examinee); placeholder = "รอเพิ่มรายชื่อ คนที่ N": no name yet, no account
  code: string | null;
  name: string;
  seq: number | null;                     // the "ลำดับ" column = the person's starting queue number (blank / not a positive whole number → null)
  payer: string;
  placeholderNo: number | null;           // the N of "คนที่ N"
  dob: string | null;                     // optional "วันเกิด" column, as yyyy-mm-dd
  lungExtra: boolean;                     // ticked "ตรวจปอดเพิ่ม"
  marks: Record<string, ParsedMark>;      // by test name_th (the column header)
};
export type ParsedProgramme = { payer: string; tests: Record<string, "all" | "selected"> };
export type ParsedWorkbook = {
  testHeaders: string[];                  // the test columns, in file order
  people: ParsedPerson[];
  named: ParsedPerson[];                  // named rows without a code: never matched to staff, offered as outside examinees by the importer
  programmes: ParsedProgramme[];
  fileTotals: Record<string, number> | null;     // the "รวมจำนวนคนที่ตรวจแต่ละรายการ" row, by test name_th
  detailNames: Map<string, string>;       // code → "prefix first last" from the staff-details sheet
  skippedNoCode: Array<{ sheetRow: number; name: string }>;   // named rows with no employee code: left out (not an error, never guessed)
  issues: Array<{ sheet: string; row: number | null; message: string }>;   // problems with the FILE itself (block the import)
};

const SHEET_PEOPLE = "รายการตรวจรายบุคคล";
const SHEET_PROGRAMME = "โปรแกรมตามบริษัท";
const SHEET_DETAILS = "รายชื่อตรวจสุขภาพ";
const LUNG_FLAG = "ตรวจปอดเพิ่ม";
const PLACEHOLDER = /^รอเพิ่มรายชื่อ(?:\s*คนที่\s*(\d+))?/;

const str = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
type Rows = string[][];

function sheetRows(wb: XLSX.WorkBook, name: string): Rows | null {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map((r) => r.map(str));
}
/** "1985-03-02", "02/03/2528" (Buddhist year) or "2/3/1985" → yyyy-mm-dd; anything else → null (never guessed). */
export function parseDob(v: string): string | null {
  const t = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t), y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return null;
  if (y > 2400) y -= 543;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const headerRowIndex = (rows: Rows, needs: string[]): number => rows.findIndex((r) => needs.every((n) => r.includes(n)));

export function parseCheckupWorkbook(buf: Buffer | ArrayBuffer): ParsedWorkbook {
  const out: ParsedWorkbook = { testHeaders: [], people: [], named: [], programmes: [], fileTotals: null, detailNames: new Map(), skippedNoCode: [], issues: [] };
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buf, { type: "buffer" }); }
  catch { out.issues.push({ sheet: "", row: null, message: "อ่านไฟล์ไม่ได้ (ต้องเป็นไฟล์ Excel .xlsx)" }); return out; }

  // ── people + marks ──
  let peopleName = SHEET_PEOPLE;
  let rows = sheetRows(wb, peopleName);
  if (!rows) {
    // fall back to any sheet that has the two header cells
    for (const n of wb.SheetNames) {
      const r = sheetRows(wb, n);
      if (r && headerRowIndex(r, ["รหัสพนักงาน", "ชื่อ-นามสกุล"]) >= 0) { peopleName = n; rows = r; break; }
    }
  }
  if (!rows) { out.issues.push({ sheet: SHEET_PEOPLE, row: null, message: `ไม่พบแผ่น “${SHEET_PEOPLE}”` }); return out; }
  const h = headerRowIndex(rows, ["รหัสพนักงาน", "ชื่อ-นามสกุล"]);
  if (h < 0) { out.issues.push({ sheet: peopleName, row: null, message: "ไม่พบแถวหัวตาราง (รหัสพนักงาน / ชื่อ-นามสกุล)" }); return out; }
  const header = rows[h];
  const col = (name: string) => header.indexOf(name);
  const cSeq = col("ลำดับ"), cCode = col("รหัสพนักงาน"), cName = col("ชื่อ-นามสกุล"), cPayer = col("บริษัทที่รับค่าใช้จ่าย"), cLung = col(LUNG_FLAG), cDob = col("วันเกิด");
  if (cPayer < 0) out.issues.push({ sheet: peopleName, row: h + 1, message: "ไม่พบคอลัมน์ “บริษัทที่รับค่าใช้จ่าย”" });
  // test columns = everything after the payer / lung-flag columns up to the count column ("จำนวนรายการ")
  const cEnd = header.findIndex((x, i) => i > Math.max(cPayer, cLung) && /^จำนวนรายการ/.test(x));
  const firstTest = Math.max(cPayer, cLung) + 1;
  const testCols: Array<{ idx: number; name: string }> = [];
  for (let i = firstTest; i < (cEnd > 0 ? cEnd : header.length); i++) if (header[i]) testCols.push({ idx: i, name: header[i] });
  out.testHeaders = testCols.map((t) => t.name);
  if (testCols.length === 0) out.issues.push({ sheet: peopleName, row: h + 1, message: "ไม่พบคอลัมน์รายการตรวจ" });

  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = row[cName] ?? "";
    if (!name && !row[cCode]) continue;                       // blank spacer row
    if (/^รวมจำนวนคน/.test(name)) {                           // totals row: counts per test
      const t: Record<string, number> = {};
      for (const c of testCols) { const n = Number(String(row[c.idx] ?? "").replace(/,/g, "")); if (Number.isFinite(n) && row[c.idx] !== "") t[c.name] = n; }
      out.fileTotals = t;
      break;                                                  // everything below the totals is a summary table
    }
    if (/^จำนวนคน|^บริษัท/.test(name) && !row[cCode]) break;
    const ph = PLACEHOLDER.exec(name);
    const marks: Record<string, ParsedMark> = {};
    for (const c of testCols) {
      const v = row[c.idx] ?? "";
      if (v === "") continue;
      if (v === "✓") marks[c.name] = "ordered";
      else if (v === "งด") marks[c.name] = "waived";
      else if (v === "แล็บนอก") marks[c.name] = "external_lab";
      else out.issues.push({ sheet: peopleName, row: r + 1, message: `ค่าในช่อง “${c.name}” ของ ${name || row[cCode]} ไม่รู้จัก: “${v}” (ใช้ได้ ✓ / งด / แล็บนอก / ว่าง)` });
    }
    // a named employee row without a code is left out, never matched on the name alone (placeholders have no code by design)
    const seqNum = cSeq >= 0 && /^\d+$/.test(row[cSeq] ?? "") ? Number(row[cSeq]) : null;
    const dob = cDob >= 0 ? parseDob(row[cDob] ?? "") : null;
    if (!ph && !row[cCode]) {
      out.skippedNoCode.push({ sheetRow: r + 1, name });
      out.named.push({ sheetRow: r + 1, kind: "named", code: null, name, seq: seqNum && seqNum > 0 ? seqNum : null, payer: cPayer >= 0 ? row[cPayer] ?? "" : "", placeholderNo: null, dob, lungExtra: cLung >= 0 && row[cLung] === "ตรวจ", marks });
      continue;
    }
    out.people.push({
      sheetRow: r + 1, kind: ph ? "placeholder" : "employee", dob, code: row[cCode] || null, name, seq: seqNum && seqNum > 0 ? seqNum : null, payer: cPayer >= 0 ? row[cPayer] ?? "" : "",
      placeholderNo: ph && ph[1] ? Number(ph[1]) : null, lungExtra: cLung >= 0 && row[cLung] === "ตรวจ", marks
    });
  }
  if (out.people.length === 0) out.issues.push({ sheet: peopleName, row: null, message: "ไม่พบรายชื่อผู้เข้าตรวจ" });
  for (const p of out.people) {
    if (!p.payer) out.issues.push({ sheet: peopleName, row: p.sheetRow, message: `${p.name || p.code} ไม่ระบุบริษัทที่รับค่าใช้จ่าย` });
  }

  // ── programme per paying company ──
  const prog = sheetRows(wb, SHEET_PROGRAMME);
  if (prog) {
    const ph = headerRowIndex(prog, ["บริษัท"]);
    if (ph >= 0) {
      const hd = prog[ph];
      for (let r = ph + 1; r < prog.length; r++) {
        const row = prog[r];
        if (!row[0]) continue;
        const tests: Record<string, "all" | "selected"> = {};
        hd.forEach((t, i) => { if (i > 0 && t) { if (row[i] === "✓") tests[t] = "all"; else if (/^เฉพาะคนที่ระบุ/.test(row[i] ?? "")) tests[t] = "selected"; } });
        out.programmes.push({ payer: row[0], tests });
      }
    }
  }

  // ── staff details, to cross-check the names ──
  const det = sheetRows(wb, SHEET_DETAILS);
  if (det) {
    const dh = headerRowIndex(det, ["รหัสพนักงาน", "ชื่อ", "นามสกุล"]);
    if (dh >= 0) {
      const hd = det[dh], iC = hd.indexOf("รหัสพนักงาน"), iP = hd.indexOf("คำนำหน้า"), iF = hd.indexOf("ชื่อ"), iL = hd.indexOf("นามสกุล");
      for (let r = dh + 1; r < det.length; r++) {
        const row = det[r];
        if (row[iC]) out.detailNames.set(row[iC], [iP >= 0 ? row[iP] : "", row[iF], row[iL]].filter(Boolean).join(" "));
      }
    }
  }
  return out;
}
