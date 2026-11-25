// Import of the laboratory's Excel (Omnia Health) into the report (owner 2026-11-25). Two steps over the same computation, like
// the programme import: buildLabPlan() writes nothing and returns exactly what would happen; commitLabPlan() recomputes it, refuses
// if it differs from what the person looked at (planHash), then saves through the gateway (recordResult) — so who may write, the
// locks and the audit trail are the gateway's, not this file's.
//
// Matching is by the person's examination code (AHC69-0001) AND the full name, never the code alone: a row whose name does not
// match the person behind the code is stopped and reported. Nothing is imported silently, nothing is guessed.
import crypto from "node:crypto";
import * as XLSX from "xlsx";
import type Database from "better-sqlite3";
import { getOrderValues, recordResult } from "../annual-checkup-db";
import { enterable, itemsOfTest, valuesFromResult, valuesToInput, type DbItem, type Values } from "./store";
import { flagResult, isCritical, implausible, ageOn, DEFAULT_THRESHOLDS, type Flag } from "./interpret";
import { logPersonaAction } from "../db";

// ── names and codes ────────────────────────────────────────────────────────────────────────────────────
const PREFIX = /^(นางสาว|นาย|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|miss|ms\.?|คุณ)\s*/i;
export const nameKey = (s: string | null | undefined): string => String(s ?? "").trim().replace(PREFIX, "").replace(/[\s.]+/g, "").toLowerCase();

/** AHC69-0001 · "ahc69-0001 " · the tube label AHC69-0001-R → AHC69-0001. */
export function normExamCode(s: string | null | undefined): string {
  const t = String(s ?? "").toUpperCase().replace(/\s+/g, "");
  return t.replace(/^([A-Z]{2,6}\d{2}-\d{2,6})-[A-Z]{1,2}$/, "$1");
}

// ── columns ────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/hz$/, "").replace(/[^a-z0-9ก-๙%]/g, "");
const stripParen = (s: string) => s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");

const CODE_HEADERS = ["รหัสผู้รับการตรวจ", "รหัสผู้ตรวจ", "รหัสผู้เข้ารับการตรวจ", "examcode", "labno", "labnumber", "specimenid", "sampleid", "รหัสตัวอย่าง", "รหัส", "code", "hn", "id"].map(norm);
const NAME_HEADERS = ["ชื่อ-นามสกุล", "ชื่อนามสกุล", "ชื่อสกุล", "ชื่อ-สกุล", "fullname", "patientname", "name", "ชื่อผู้รับการตรวจ", "ชื่อผู้ตรวจ"].map(norm);
const FIRST_HEADERS = ["ชื่อ", "firstname", "first"].map(norm), LAST_HEADERS = ["นามสกุล", "lastname", "last", "surname"].map(norm);

const EXTRA_ALIASES: Record<string, string[]> = {
  WBC: ["wbc", "whitebloodcell", "whitecellcount"], NEUT: ["neutrophil", "neut", "neutrophils", "%neutrophil"], LYMPH: ["lymphocyte", "lymph", "lymphocytes"], MONO: ["monocyte", "mono"],
  EOS: ["eosinophil", "eos"], BASO: ["basophil", "baso"], RBC: ["rbc", "redbloodcell", "rbccount"], HB: ["hb", "hgb", "hemoglobin", "haemoglobin"], HCT: ["hct", "hematocrit"],
  PLT: ["plt", "platelet", "plateletcount"], RBC_MORPH: ["rbcmorphology", "rbcmorph"], FBS: ["fbs", "fastingbloodsugar", "glucose", "fastingglucose", "fpg"], HBA1C: ["hba1c", "a1c", "hemoglobina1c"],
  CHOL: ["cholesterol", "totalcholesterol", "chol"], TG: ["triglyceride", "triglycerides", "tg"], HDL: ["hdl", "hdlcholesterol"], LDL: ["ldl", "ldlcholesterol"], BUN: ["bun", "bloodureanitrogen"],
  CREAT: ["creatinine", "creat", "cr"], EGFR: ["egfr", "gfr"], URIC: ["uricacid", "uric"], AST: ["ast", "sgot", "ast/sgot"], ALT: ["alt", "sgpt", "alt/sgpt"], ALP: ["alp", "alkphos", "alk"],
  TP: ["totalprotein", "tp"], ALB: ["albumin", "alb"], GLOB: ["globulin"], TBIL: ["totalbilirubin", "tbil", "tb"], DBIL: ["directbilirubin", "dbil", "db"], IBIL: ["indirectbilirubin", "ibil"],
  UA_COLOR: ["urinecolor", "uacolor", "colorurine"], UA_APPEAR: ["urineappearance", "uaappearance", "appearanceurine"], UA_SG: ["specificgravity", "sg", "spgr"], UA_PH: ["ph", "urineph"],
  UA_URO: ["urobilinogen"], UA_BIL: ["bilirubin", "urinebilirubin"], UA_NIT: ["nitrite"], UA_LE: ["leukocyteesterase", "le"], UA_ERY: ["erythrocyte", "blood", "urineblood"], UA_PRO: ["protein", "urineprotein"],
  UA_GLU: ["urineglucose", "uaglucose"], UA_KET: ["ketone"], UA_RBC: ["urinerbc", "rbcurine", "rbchpf"], UA_WBC: ["urinewbc", "wbcurine", "wbchpf"], UA_EPI: ["epithelium", "epithelialcell", "epicell"],
  UA_CAST: ["cast"], UA_CRYSTAL: ["crystal"], UA_MUCOUS: ["mucous", "mucus"], UA_BACT: ["bacteria", "bacteriayeastparasite"],
  HAV_IGM: ["antihavigm", "havigm"], HAV_IGG: ["antihavigg", "havigg"], HAV_TOTAL: ["antihavtotal", "antihav", "havtotal"], HBSAG: ["hbsag"], ANTI_HBS: ["antihbs", "hbsab"], ANTI_HBC: ["antihbc"], ANTI_HCV: ["antihcv"],
  VDRL: ["vdrl"], TSH: ["tsh"], FT3: ["ft3", "freet3"], FT4: ["ft4", "freet4"], CORTISOL: ["cortisol"], AFP: ["afp"], CEA: ["cea"], PSA: ["psa"], CA125: ["ca125"], CA153: ["ca153", "ca15-3"], CA199: ["ca199", "ca19-9"],
  FVC_MEAS: ["fvc", "fvcmeasure", "fvcmeasured"], FVC_PRED: ["fvcpred", "fvcpredicted"], FVC_PCT: ["fvc%", "%fvc", "fvcpred%", "fvc%pred", "fvc%predicted"],
  FEV1_MEAS: ["fev1", "fev1measure", "fev1measured"], FEV1_PRED: ["fev1pred", "fev1predicted"], FEV1_PCT: ["fev1%", "%fev1", "fev1pred%", "fev1%pred", "fev1%predicted"],
  FEV1FVC_MEAS: ["fev1/fvc", "fev1fvc", "fev1fvc%"], FEF_MEAS: ["fef2575", "fef25-75", "fef"], FEF_PCT: ["fef2575%", "fef%pred"],
  ST_FOB: ["fecaloccultblood", "fob"], DRUG_AMPH: ["urineamphetamine", "amphetamine", "amph", "methamphetamine"]
};

export type LabColumn = { col: number; header: string; itemCode: string | null; why: "mapped" | "unknown" | "ambiguous" };

function buildColumnIndex(items: DbItem[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  const add = (k: string, code: string) => { if (!k) return; const s = idx.get(k) ?? new Set(); s.add(code); idx.set(k, s); };
  for (const it of items) {
    add(norm(it.code), it.code); add(norm(it.en), it.code); add(norm(stripParen(it.en)), it.code);
    // "WBC : Stool" must not also answer to plain "WBC" (that is the blood count) — the short form is for the other items only
    if (!it.code.startsWith("ST_")) add(norm(it.en.split(":")[0]), it.code);
    for (const a of EXTRA_ALIASES[it.code] ?? []) add(norm(a), it.code);
    const m = /^AUD_([RL])_(\d+)$/.exec(it.code);
    if (m) {
      const f = m[2], sides = m[1] === "R" ? ["r", "rt", "right", "ขวา", "หูขวา"] : ["l", "lt", "left", "ซ้าย", "หูซ้าย"];
      for (const sd of sides) { add(norm(`${sd}${f}`), it.code); add(norm(`${f}${sd}`), it.code); add(norm(`${sd} ${f} hz`), it.code); }
    }
  }
  return idx;
}

// ── cells ──────────────────────────────────────────────────────────────────────────────────────────────
const SYN: Array<[RegExp, string[]]> = [
  [/^(neg|negative|nonreactive|non-reactive|nr|nd|not detected|ไม่พบ(?:สารเสพติด|เชื้อ)?)$/i, ["Negative", "Not found", "No fungus seen"]],
  [/^(pos|positive|reactive|detected|พบ)$/i, ["Positive", "Found"]],
  [/^(normal|norm|ปกติ|wnl)$/i, ["ปกติ", "Normal"]],
  [/^(abnormal|ผิดปกติ|abn)$/i, ["ผิดปกติ", "Abnormal"]],
  [/^(not found|nf|ไม่พบ)$/i, ["Not found"]], [/^(no fungus seen)$/i, ["No fungus seen"]]
];

export type CellParse = { value: number | string | null; problem?: "bad_number" | "bad_choice" };
export function parseCell(item: DbItem, raw: string): CellParse {
  const t = raw.trim();
  if (t === "" || t === "-" || t === "—") return { value: null };
  if (item.kind === "number") {
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) && /^[-+]?\d*\.?\d+$/.test(t.replace(/,/g, "")) ? { value: n } : { value: null, problem: "bad_number" };
  }
  if (item.kind === "choice") {
    const direct = item.choices?.find((c) => c.toLowerCase() === t.toLowerCase());
    if (direct) return { value: direct };
    for (const [re, targets] of SYN) if (re.test(t)) { const hit = targets.find((x) => item.choices?.includes(x)); if (hit) return { value: hit }; }
    return { value: null, problem: "bad_choice" };
  }
  return { value: t.slice(0, 1000) };
}

// ── reading the workbook ────────────────────────────────────────────────────────────────────────────────
export type LabRow = { sheetRow: number; code: string; name: string; cells: Record<number, string> };
export type ParsedLab = { sheet: string; columns: LabColumn[]; rows: LabRow[]; issues: string[]; hasName: boolean };
const str = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

export function parseLabWorkbook(buf: Buffer | ArrayBuffer, items: DbItem[]): ParsedLab {
  const out: ParsedLab = { sheet: "", columns: [], rows: [], issues: [], hasName: false };
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buf, { type: "buffer" }); } catch { out.issues.push("อ่านไฟล์ไม่ได้ (ต้องเป็นไฟล์ Excel .xlsx)"); return out; }
  const idx = buildColumnIndex(items.filter((i) => i.kind !== "file" && !i.computed));
  for (const name of wb.SheetNames) {
    const rows = (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }) as unknown[][]).map((r) => r.map(str));
    const h = rows.slice(0, 20).findIndex((r) => r.some((c) => CODE_HEADERS.includes(norm(c))));
    if (h < 0) continue;
    const head = rows[h];
    const codeCol = head.findIndex((c) => CODE_HEADERS.includes(norm(c)));
    let nameCols = head.map((c, i) => (NAME_HEADERS.includes(norm(c)) ? i : -1)).filter((i) => i >= 0);
    if (!nameCols.length) {
      const f = head.findIndex((c) => FIRST_HEADERS.includes(norm(c))), l = head.findIndex((c) => LAST_HEADERS.includes(norm(c)));
      nameCols = [f, l].filter((i) => i >= 0);
    }
    const skip = new Set([codeCol, ...nameCols]);
    out.sheet = name; out.hasName = nameCols.length > 0;
    head.forEach((hd, col) => {
      if (skip.has(col) || !hd) return;
      const keys = [norm(hd), norm(stripParen(hd))].filter(Boolean);
      let found = new Set<string>();
      for (const k of keys) { const s = idx.get(k); if (s && s.size) { found = s; break; } }
      out.columns.push(found.size === 1 ? { col, header: hd, itemCode: [...found][0], why: "mapped" } : found.size > 1 ? { col, header: hd, itemCode: null, why: "ambiguous" } : { col, header: hd, itemCode: null, why: "unknown" });
    });
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r];
      const code = row[codeCol] ?? "";
      if (!code && nameCols.every((c) => !row[c])) continue;
      const cells: Record<number, string> = {};
      for (const c of out.columns) if (row[c.col]) cells[c.col] = row[c.col];
      out.rows.push({ sheetRow: r + 1, code, name: nameCols.map((c) => row[c]).filter(Boolean).join(" "), cells });
    }
    if (out.rows.length) return out;
  }
  out.issues.push("ไม่พบแถวหัวตารางที่มีคอลัมน์ \"รหัสผู้รับการตรวจ\" ในไฟล์นี้");
  return out;
}

// ── the round's people and their codes ──────────────────────────────────────────────────────────────────
export type Subject = { key: string; userId: number | null; externalId: number | null; label: string; name: string; employeeCode: string | null; sex: "M" | "F" | null; dob: string | null; examCode: string | null };

export function roundSubjects(db: Database.Database, roundId: number): Subject[] {
  const emps = db.prepare(`
    SELECT DISTINCT u.id, u.display_name, u.title_prefix, u.employee_code, u.gender, u.dob, ec.exam_code
      FROM annual_checkup_orders o JOIN users u ON u.id = o.user_id
      LEFT JOIN annual_checkup_exam_codes ec ON ec.round_id = o.round_id AND ec.user_id = u.id
     WHERE o.round_id = ? AND o.user_id IS NOT NULL`).all(roundId) as Array<{ id: number; display_name: string; title_prefix: string | null; employee_code: string | null; gender: string | null; dob: string | null; exam_code: string | null }>;
  const exts = db.prepare(`
    SELECT e.id, e.full_name, e.sex, e.dob, e.sort_no, ec.exam_code
      FROM annual_checkup_externals e LEFT JOIN annual_checkup_exam_codes ec ON ec.round_id = e.round_id AND ec.external_id = e.id
     WHERE e.round_id = ? AND e.is_placeholder = 0 AND e.full_name IS NOT NULL`).all(roundId) as Array<{ id: number; full_name: string; sex: "M" | "F" | null; dob: string | null; sort_no: number | null; exam_code: string | null }>;
  const seen = new Set<number>();
  const out: Subject[] = [];
  for (const u of emps) {
    if (seen.has(u.id)) continue; seen.add(u.id);
    out.push({ key: `u${u.id}`, userId: u.id, externalId: null, label: `${u.title_prefix ?? ""}${u.display_name}`, name: u.display_name, employeeCode: u.employee_code, sex: u.gender === "male" ? "M" : u.gender === "female" ? "F" : null, dob: u.dob ? u.dob.slice(0, 10) : null, examCode: u.exam_code });
  }
  for (const e of exts) out.push({ key: `e${e.id}`, userId: null, externalId: e.id, label: e.full_name, name: e.full_name, employeeCode: null, sex: e.sex, dob: e.dob ? e.dob.slice(0, 10) : null, examCode: e.exam_code });
  return out;
}

export type RegisterLine = { line: number; code: string; ref: string; result: "registered" | "same" | "code_taken" | "person_has_other_code" | "not_found" | "ambiguous" | "bad_code"; who?: string };
/** Lines "AHC69-0001 IKG-W46" or "AHC69-0001<TAB>นายสมชาย ใจดี": the person is found by employee code, else by exact full name. */
export function registerExamCodes(db: Database.Database, actorId: number, roundId: number, text: string, dryRun = false): RegisterLine[] {
  const subjects = roundSubjects(db, roundId);
  const out: RegisterLine[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const doInsert = db.prepare("INSERT INTO annual_checkup_exam_codes (round_id, user_id, external_id, exam_code, created_by) VALUES (?,?,?,?,?)");
  lines.forEach((l, i) => {
    if (!l) return;
    const m = /^(\S+)[\s,;\t]+(.+)$/.exec(l);
    const code = normExamCode(m?.[1]);
    const ref = (m?.[2] ?? "").trim();
    if (!m || !/^[A-Z]{2,6}\d{2}-\d{2,6}$/.test(code)) { out.push({ line: i + 1, code: m?.[1] ?? l, ref, result: "bad_code" }); return; }
    const byEmp = subjects.filter((s) => s.employeeCode && s.employeeCode.toLowerCase() === ref.toLowerCase());
    const cand = byEmp.length ? byEmp : subjects.filter((s) => nameKey(s.name) === nameKey(ref) || nameKey(s.label) === nameKey(ref));
    if (cand.length === 0) { out.push({ line: i + 1, code, ref, result: "not_found" }); return; }
    if (cand.length > 1) { out.push({ line: i + 1, code, ref, result: "ambiguous" }); return; }
    const p = cand[0];
    if (p.examCode === code) { out.push({ line: i + 1, code, ref, result: "same", who: p.label }); return; }
    if (p.examCode) { out.push({ line: i + 1, code, ref, result: "person_has_other_code", who: p.label }); return; }
    if (subjects.some((s) => s.examCode === code) || out.some((x) => x.code === code && x.result === "registered")) { out.push({ line: i + 1, code, ref, result: "code_taken", who: p.label }); return; }
    if (!dryRun) { doInsert.run(roundId, p.userId, p.externalId, code, actorId); p.examCode = code; }
    out.push({ line: i + 1, code, ref, result: "registered", who: p.label });
  });
  if (!dryRun && out.some((x) => x.result === "registered")) logPersonaAction(actorId, "health_report.exam_codes", roundId);
  return out;
}

// ── plan ────────────────────────────────────────────────────────────────────────────────────────────────
export type CellPlan = {
  col: number; itemCode: string; header: string; raw: string; value: number | string | null; problem?: CellParse["problem"];
  existing: number | string | null; state: "new" | "same" | "conflict" | "bad" | "not_ordered" | "locked" | "empty"; flag: Flag | null; critical: boolean; implausible: boolean;
};
export type RowPlan = {
  sheetRow: number; code: string; fileName: string; status: "ready" | "unregistered" | "name_mismatch" | "no_code" | "nothing";
  person: string | null; suggestion: { label: string; key: string } | null; message: string | null; cells: CellPlan[];
};
export type LabPlan = {
  sheet: string; issues: string[]; columns: LabColumn[]; rows: RowPlan[];
  counts: { rows: number; ready: number; blocked: number; newCells: number; sameCells: number; conflicts: number; bad: number; notOrdered: number; locked: number; implausible: number; critical: number };
  hash: string;
};

export function buildLabPlan(db: Database.Database, actor: { id: number }, roundId: number, parsed: ParsedLab, items: DbItem[], opts: { registerByName?: boolean } = {}): LabPlan {
  const subjects = roundSubjects(db, roundId);
  const byCode = new Map(subjects.filter((s) => s.examCode).map((s) => [s.examCode as string, s]));
  const itemBy = new Map(items.map((i) => [i.code, i]));
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const orderOf = db.prepare(`SELECT o.id, o.status FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.round_id = ? AND t.code = ? AND (o.user_id = ? OR o.external_id = ?)`);
  const taken = new Set(byCode.keys());

  const rows: RowPlan[] = parsed.rows.map((r) => {
    const code = normExamCode(r.code);
    const base: RowPlan = { sheetRow: r.sheetRow, code, fileName: r.name, status: "nothing", person: null, suggestion: null, message: null, cells: [] };
    if (!code) return { ...base, status: "no_code", message: "แถวนี้ไม่มีรหัสผู้รับการตรวจ" };
    let who = byCode.get(code) ?? null;
    if (!who) {
      const byName = r.name ? subjects.filter((s) => !s.examCode && (nameKey(s.name) === nameKey(r.name) || nameKey(s.label) === nameKey(r.name))) : [];
      if (opts.registerByName && byName.length === 1 && !taken.has(code)) { who = { ...byName[0], examCode: code }; taken.add(code); base.message = `ผูกรหัส ${code} กับ ${byName[0].label} ตามชื่อที่ตรง`; }
      else return { ...base, status: "unregistered", message: `รหัส ${code} ยังไม่ได้ผูกกับใครในรอบนี้`, suggestion: byName.length === 1 && !taken.has(code) ? { label: byName[0].label, key: byName[0].key } : null };
    }
    if (r.name && nameKey(r.name) !== nameKey(who.name) && nameKey(r.name) !== nameKey(who.label)) {
      return { ...base, status: "name_mismatch", person: who.label, message: `ชื่อไม่ตรง: ในไฟล์ "${r.name}" แต่รหัส ${code} เป็นของ "${who.label}" — ไม่นำเข้าแถวนี้` };
    }
    const age = ageOn(who.dob, today);
    const cells: CellPlan[] = [];
    for (const c of parsed.columns) {
      if (!c.itemCode) continue;
      const raw = r.cells[c.col] ?? "";
      if (raw.trim() === "") continue;
      const it = itemBy.get(c.itemCode)!;
      const p = parseCell(it, raw);
      const mk = (state: CellPlan["state"], existing: CellPlan["existing"] = null): CellPlan => ({
        col: c.col, itemCode: it.code, header: c.header, raw, value: p.value, problem: p.problem, existing, state,
        flag: p.value == null ? null : flagResult(it, p.value, who!.sex, age),
        critical: typeof p.value === "number" && isCritical(it, p.value, who!.sex, age, DEFAULT_THRESHOLDS), implausible: typeof p.value === "number" && implausible(it, p.value)
      });
      if (p.problem) { cells.push(mk("bad")); continue; }
      const o = orderOf.get(roundId, it.test, who.userId, who.externalId) as { id: number; status: string } | undefined;
      if (!o || o.status === "waived") { cells.push(mk("not_ordered")); continue; }
      const cur = getOrderValues(actor, o.id);
      if (cur.status && cur.status !== "draft") { cells.push(mk("locked")); continue; }
      const had = valuesFromResult(itemsOfTest(items, it.test), cur)[it.code] ?? null;
      cells.push(mk(had == null ? "new" : String(had) === String(p.value) ? "same" : "conflict", had));
    }
    return { ...base, status: cells.length ? "ready" : "nothing", person: who.label, cells, message: cells.length ? base.message : "ไม่มีค่าในแถวนี้ที่ตรงกับรายการตรวจ" };
  });

  const all = rows.flatMap((r) => r.cells);
  const counts = {
    rows: rows.length, ready: rows.filter((r) => r.status === "ready").length, blocked: rows.filter((r) => r.status !== "ready" && r.status !== "nothing").length,
    newCells: all.filter((c) => c.state === "new").length, sameCells: all.filter((c) => c.state === "same").length, conflicts: all.filter((c) => c.state === "conflict").length,
    bad: all.filter((c) => c.state === "bad").length, notOrdered: all.filter((c) => c.state === "not_ordered").length, locked: all.filter((c) => c.state === "locked").length,
    implausible: all.filter((c) => c.implausible).length, critical: all.filter((c) => c.critical).length
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify({ roundId, rows: rows.map((r) => [r.code, r.status, r.cells.map((c) => [c.itemCode, c.value, c.state, c.existing])]) })).digest("hex").slice(0, 24);
  return { sheet: parsed.sheet, issues: parsed.issues, columns: parsed.columns, rows, counts, hash };
}

export class LabImportRefused extends Error { constructor(public code: "plan_changed" | "nothing_to_import" | "not_allowed", msg: string) { super(msg); } }

export type CommitOpts = { planHash: string; overwrite: boolean; registerByName: boolean; confirmImplausible: boolean };
export type CommitResult = { rows: number; cellsSaved: number; overwritten: number; skipped: number; registered: number };

/** Saves what the plan showed. Conflicts are written only with overwrite; implausible numbers only with confirmImplausible; locked results never. */
export function commitLabPlan(db: Database.Database, actor: { id: number }, roundId: number, parsed: ParsedLab, items: DbItem[], o: CommitOpts): CommitResult {
  const plan = buildLabPlan(db, actor, roundId, parsed, items, { registerByName: o.registerByName });
  if (plan.hash !== o.planHash) throw new LabImportRefused("plan_changed", "ข้อมูลเปลี่ยนไปหลังจากที่ดูตัวอย่าง กรุณาตรวจตัวอย่างอีกครั้ง");
  const subjects = roundSubjects(db, roundId);
  const insertCode = db.prepare("INSERT INTO annual_checkup_exam_codes (round_id, user_id, external_id, exam_code, created_by) VALUES (?,?,?,?,?)");
  const orderOf = db.prepare(`SELECT o.id FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.round_id = ? AND t.code = ? AND (o.user_id = ? OR o.external_id = ?)`);
  const itemBy = new Map(items.map((i) => [i.code, i]));
  const res: CommitResult = { rows: 0, cellsSaved: 0, overwritten: 0, skipped: 0, registered: 0 };
  db.transaction(() => {
    for (const row of plan.rows) {
      if (row.status !== "ready") continue;
      let who = subjects.find((s) => s.examCode === row.code) ?? null;
      if (!who && o.registerByName) {
        const cand = subjects.filter((s) => !s.examCode && (nameKey(s.name) === nameKey(row.fileName) || nameKey(s.label) === nameKey(row.fileName)));
        if (cand.length === 1) { insertCode.run(roundId, cand[0].userId, cand[0].externalId, row.code, actor.id); cand[0].examCode = row.code; who = cand[0]; res.registered++; }
      }
      if (!who) continue;
      const byTest = new Map<string, Values>();
      for (const c of row.cells) {
        const writable = c.state === "new" || (c.state === "conflict" && o.overwrite);
        if (!writable || (c.implausible && !o.confirmImplausible)) { if (c.state !== "same") res.skipped++; continue; }
        const it = itemBy.get(c.itemCode)!;
        const m = byTest.get(it.test) ?? {}; m[c.itemCode] = c.value; byTest.set(it.test, m);
        res.cellsSaved++; if (c.state === "conflict") res.overwritten++;
      }
      for (const [test, vals] of byTest) {
        const ord = orderOf.get(roundId, test, who.userId, who.externalId) as { id: number } | undefined;
        if (!ord) continue;
        const testItems = itemsOfTest(items, test);
        const merged = enterable(testItems).length === 1 ? vals : { ...valuesFromResult(testItems, getOrderValues(actor, ord.id)), ...vals };
        recordResult(actor, ord.id, valuesToInput(testItems, merged));
      }
      res.rows++;
    }
  })();
  logPersonaAction(actor.id, "health_report.lab_import", roundId);
  return res;
}
