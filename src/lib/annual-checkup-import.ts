// Annual check-up programme — import of the planning workbook (phase 3, docs/annual-checkup-plan.md §6).
//
// Two steps over the same computation:
//   buildImportPlan()   reads nothing but the database and the parsed file and returns WHAT WOULD HAPPEN (nothing is written)
//   commitImport()      recomputes the plan, refuses if it differs from the one the user looked at (planHash), then writes it in one transaction
//
// Rules (from the brief):
//   • staff are matched by employee code AND full name together, never by code alone (the system once held two people with IKG-W46);
//     zero or several candidates is a row "to fix" that is never imported on a guess
//   • people without an account ("รอเพิ่มรายชื่อ คนที่ N") become placeholder externals, named later
//   • idempotent: the same file again changes nothing; a changed cell shows as a change; an order that already has a result or clinical
//     data is never touched (reported as a conflict for clinical staff)
//   • the reason a test is waived is NOT in the file and is never stored here (it lives in the clinical-only table behind the gateway)
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { logPersonaAction } from "./db";
import { applyQueuePlan, isRecorderEligible, listQueueForImport, lockedOrderIds, listExternalNamesForImport, normPersonKey, sexFromTitle, splitThaiName, upsertExternalPerson } from "./annual-checkup-db";
import { offerNameKey } from "./recruita-offer";
import { nameWithPrefix } from "./name";
import type { ParsedMark, ParsedWorkbook } from "./annual-checkup-xlsx";

export type RoundInput = { roundId?: number | null; name?: string | null; yearBe?: number | null; startDate?: string | null; endDate?: string | null; location?: string | null;
  /** Outside examinees the user chose to create: whole paying companies (by name) and/or single rows (sheet row numbers). Nothing is created unless chosen. */
  externals?: { payers: string[]; rows: number[] } | null };

export type PersonMatch =
  | { state: "matched"; userId: number; display: string; warnings: string[] }
  | { state: "needs_fix"; reason: "not_found" | "name_mismatch" | "ambiguous" | "inactive" | "duplicate_row"; message: string }
  | { state: "placeholder"; sortNo: number }
  // group ข — no match among staff and the paying company is outside the group: may become an outside examinee, only when ticked
  | { state: "external_candidate"; selected: boolean; exists: boolean; sponsorCode: string | null }
  // group ค — no match among staff but the paying company is one of ours: never made external, skipped with a reason
  | { state: "skipped"; reason: string };

export type PlanPerson = { sheetRow: number; kind: "employee" | "placeholder" | "named"; group: "a" | "b" | "c" | null; code: string | null; name: string; payer: string; queueNo: number | null; match: PersonMatch; ordered: number; waived: number; externalLab: number };
export type PlanCounts = { add: number; change: number; same: number; remove: number; conflict: number };
/** The queue numbers ("ลำดับ" column): what would be added / changed / left alone, and what could not be placed. */
export type QueuePlan = { add: number; change: number; same: number; noNumber: number; clashes: string[]; skippedNoCode: string[] };
export type ImportPlan = {
  fileIssues: string[];
  round: { mode: "new" | "existing"; id: number | null; name: string; yearBe: number | null; startDate: string | null; endDate: string | null; location: string | null };
  payers: Array<{ name: string; companyId: number | null; external: boolean; isNew: boolean }>;
  programmes: Array<{ payer: string; testCount: number }>;
  people: PlanPerson[];
  orders: PlanCounts;
  queue: QueuePlan;
  conflicts: Array<{ who: string; test: string; reason: string }>;
  perTest: Array<{ code: string; nameTh: string; ordered: number; waived: number; externalLab: number; fileTotal: number | null }>;
  warnings: string[];
  needsFix: number;
  hash: string;
};

/** Who may import a planning file: the owner, or clinic staff holding the recorder flag. (The import creates orders, never results.) */
export function canImportCheckup(user: { id: number; role: string } | null): boolean {
  return !!user && (user.role === "super_admin" || isRecorderEligible(user.id));
}

export class ImportRefused extends Error {
  constructor(public code: "file_issues" | "needs_fix" | "plan_changed" | "round_not_found" | "round_invalid", message: string) { super(message); this.name = "ImportRefused"; }
}

type Subject = { userId: number } | { placeholder: { payer: string; sortNo: number } } | { named: string };
type OrderOp = { subject: Subject; payer: string; testId: number; status: ParsedMark; kind: "add" | "change" | "remove"; orderId: number | null };
type Ops = {
  round: ImportPlan["round"];
  payers: ImportPlan["payers"];
  programmes: Array<{ payer: string; tests: Array<{ testId: number; scope: "all" | "selected" }> }>;
  placeholders: Array<{ payer: string; sortNo: number }>;
  named: Array<{ key: string; payer: string; first: string; last: string; title: string | null; dob: string | null; sponsorCode: string | null }>;
  orders: OrderOp[];
  queue: Array<{ userId: number | null; ph: { payer: string; sortNo: number } | null; queueNo: number }>;
};

const INACTIVE = new Set(["disabled", "resigned", "terminated"]);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type UserRow = { id: number; display_name: string; title_prefix: string | null; status: string; employee_code: string | null };
const userKeys = (u: UserRow) => new Set([offerNameKey(u.display_name), offerNameKey(nameWithPrefix(u.title_prefix, u.display_name))]);
const userLabel = (u: UserRow) => nameWithPrefix(u.title_prefix, u.display_name);

function compute(db: Database.Database, parsed: ParsedWorkbook, input: RoundInput): { plan: ImportPlan; ops: Ops } {
  const fileIssues = parsed.issues.map((i) => `${i.sheet ? `แผ่น ${i.sheet}` : "ไฟล์"}${i.row ? ` แถว ${i.row}` : ""}: ${i.message}`);
  const warnings: string[] = [];

  // ── catalogue ──
  const catalogue = db.prepare("SELECT id, code, name_th FROM annual_checkup_tests WHERE active = 1").all() as Array<{ id: number; code: string; name_th: string }>;
  const testByName = new Map(catalogue.map((t) => [norm(t.name_th), t]));
  for (const h of parsed.testHeaders) if (!testByName.has(norm(h))) fileIssues.push(`รายการตรวจ “${h}” ไม่มีในแคตตาล็อก (เพิ่มในแคตตาล็อกก่อน)`);

  // ── round ──
  let round: ImportPlan["round"];
  if (input.roundId) {
    const r = db.prepare("SELECT id, name, year_be, start_date, end_date, location FROM annual_checkup_rounds WHERE id = ?").get(input.roundId) as
      { id: number; name: string; year_be: number | null; start_date: string | null; end_date: string | null; location: string | null } | undefined;
    if (!r) throw new ImportRefused("round_not_found", "ไม่พบรอบที่เลือก");
    round = { mode: "existing", id: r.id, name: input.name?.trim() || r.name, yearBe: input.yearBe ?? r.year_be, startDate: input.startDate ?? r.start_date, endDate: input.endDate ?? r.end_date, location: input.location ?? r.location };
  } else {
    const name = (input.name ?? "").trim();
    if (!name) throw new ImportRefused("round_invalid", "กรุณาตั้งชื่อรอบ (เช่น ตรวจสุขภาพประจำปี 2569)");
    round = { mode: "new", id: null, name, yearBe: input.yearBe ?? null, startDate: input.startDate ?? null, endDate: input.endDate ?? null, location: input.location ?? null };
  }

  // ── payers (a company we have, or an outside company kept as free text) ──
  const companies = db.prepare("SELECT id, name_th FROM companies").all() as Array<{ id: number; name_th: string }>;
  const companyByName = new Map(companies.map((c) => [norm(c.name_th), c.id]));
  const existingPayers = new Set(round.id ? (db.prepare("SELECT name_th FROM annual_checkup_payers WHERE round_id = ?").all(round.id) as Array<{ name_th: string }>).map((p) => norm(p.name_th)) : []);
  const payerNames = [...new Set([...parsed.people.map((p) => norm(p.payer)), ...parsed.programmes.map((p) => norm(p.payer))].filter(Boolean))];
  const payers = payerNames.map((n) => ({ name: n, companyId: companyByName.get(n) ?? null, external: !companyByName.has(n), isNew: !existingPayers.has(n) }));
  for (const p of payers) if (p.external) warnings.push(`บริษัทผู้จ่าย “${p.name}” ไม่อยู่ในตารางบริษัทของระบบ จะเก็บเป็นบริษัทภายนอก`);

  // ── programmes ──
  const programmes = parsed.programmes.map((pg) => ({
    payer: norm(pg.payer),
    tests: Object.entries(pg.tests).flatMap(([name, scope]) => { const t = testByName.get(norm(name)); return t ? [{ testId: t.id, scope }] : []; })
  }));

  // ── people: match staff by code AND name ──
  const users = db.prepare("SELECT id, display_name, title_prefix, status, employee_code FROM users WHERE COALESCE(is_test_account, 0) = 0").all() as UserRow[];
  const byCode = new Map<string, UserRow[]>();
  for (const u of users) { const k = (u.employee_code ?? "").trim().toUpperCase(); if (k) byCode.set(k, [...(byCode.get(k) ?? []), u]); }
  const byName = new Map<string, UserRow[]>();
  for (const u of users) for (const k of userKeys(u)) byName.set(k, [...(byName.get(k) ?? []), u]);

  const seenCodes = new Set<string>();
  const phCounter = new Map<string, number>();
  const phSeen = new Set<string>();
  const people: PlanPerson[] = [];
  const matched: Array<{ person: typeof parsed.people[number]; userId: number }> = [];
  const placeholders: Array<{ person: typeof parsed.people[number]; payer: string; sortNo: number }> = [];
  const namedRows: Array<typeof parsed.people[number]> = [];

  for (const p of parsed.people) {
    const marks = Object.values(p.marks);
    const base = { sheetRow: p.sheetRow, kind: p.kind, group: null as PlanPerson["group"], code: p.code, name: p.name, payer: norm(p.payer), queueNo: p.seq, ordered: marks.filter((m) => m === "ordered").length, waived: marks.filter((m) => m === "waived").length, externalLab: marks.filter((m) => m === "external_lab").length };
    if (p.kind === "placeholder") {
      const payer = norm(p.payer);
      const sortNo = p.placeholderNo ?? (phCounter.get(payer) ?? 0) + 1;
      phCounter.set(payer, Math.max(phCounter.get(payer) ?? 0, sortNo));
      const key = `${payer}#${sortNo}`;
      if (phSeen.has(key)) { fileIssues.push(`แถว ${p.sheetRow}: “รอเพิ่มรายชื่อ คนที่ ${sortNo}” ของ ${payer} ซ้ำกัน`); continue; }
      phSeen.add(key);
      people.push({ ...base, match: { state: "placeholder", sortNo } });
      placeholders.push({ person: p, payer, sortNo });
      continue;
    }
    const code = (p.code ?? "").trim().toUpperCase();
    if (seenCodes.has(code)) { people.push({ ...base, match: { state: "needs_fix", reason: "duplicate_row", message: `รหัส ${p.code} ซ้ำในไฟล์` } }); continue; }
    seenCodes.add(code);
    const fileKey = offerNameKey(p.name);
    const candidates = byCode.get(code) ?? [];
    const nameMatches = candidates.filter((u) => userKeys(u).has(fileKey));
    const active = nameMatches.filter((u) => !INACTIVE.has(u.status));
    if (active.length === 1) {
      const u = active[0];
      const w: string[] = [];
      const others = candidates.filter((x) => x.id !== u.id);
      if (others.length > 0) w.push(`รหัส ${p.code} ซ้ำในระบบกับ ${others.map(userLabel).join(", ")} — จับคู่ด้วยชื่อ (ควรแก้รหัสในระบบ)`);
      const detail = parsed.detailNames.get(p.code ?? "");
      if (detail && offerNameKey(detail) !== fileKey) w.push(`ชื่อในแผ่นรายการตรวจ “${p.name}” ต่างจากแผ่นรายชื่อ “${detail}”`);
      people.push({ ...base, group: "a", match: { state: "matched", userId: u.id, display: userLabel(u), warnings: w } });
      matched.push({ person: p, userId: u.id });
      continue;
    }
    if (active.length === 0 && nameMatches.length === 0 && candidates.length === 0 && !companyByName.has(norm(p.payer)) && norm(p.payer)) { namedRows.push(p); continue; }
    let fix: PersonMatch;
    if (active.length > 1) fix = { state: "needs_fix", reason: "ambiguous", message: `รหัสและชื่อตรงกับพนักงานมากกว่าหนึ่งคน (${active.map(userLabel).join(", ")})` };
    else if (nameMatches.length > 0) fix = { state: "needs_fix", reason: "inactive", message: `พบ ${userLabel(nameMatches[0])} แต่สถานะไม่ใช่พนักงานที่ทำงานอยู่` };
    else if (candidates.length > 0) fix = { state: "needs_fix", reason: "name_mismatch", message: `มีรหัส ${p.code} ในระบบ แต่ชื่อเป็น “${candidates.map(userLabel).join(", ")}” ไม่ตรงกับ “${p.name}”` };
    else {
      const hint = (byName.get(fileKey) ?? []).filter((u) => !INACTIVE.has(u.status));
      fix = { state: "needs_fix", reason: "not_found", message: hint.length ? `ไม่พบรหัส ${p.code} ในระบบ (มีชื่อเดียวกัน: ${hint.map((u) => `${userLabel(u)} รหัส ${u.employee_code ?? "—"}`).join(", ")})` : `ไม่พบรหัส ${p.code} ในระบบ` };
    }
    people.push({ ...base, match: fix });
  }
  // ── named rows without a staff match: group ข (outside company) / group ค (our own company) ──
  const existingNamed = new Map<string, number>();   // payer#nameKey → external id, for people already in the round
  if (round.id) {
    const names = listExternalNamesForImport(round.id);
    const rows = db.prepare("SELECT e.id, pa.name_th AS payer FROM annual_checkup_externals e JOIN annual_checkup_payers pa ON pa.id = e.payer_id WHERE e.round_id = ? AND e.is_placeholder = 0").all(round.id) as Array<{ id: number; payer: string }>;
    for (const r of rows) { const n = names.get(r.id); if (n) existingNamed.set(`${norm(r.payer)}#${normPersonKey(n.first, n.last)}`, r.id); }
  }
  const pick = input.externals ?? { payers: [], rows: [] };
  const pickPayers = new Set(pick.payers.map(norm)), pickRows = new Set(pick.rows);
  const named: Ops["named"] = [];
  const namedKeys = new Set<string>();
  const namedParsed = new Map<string, typeof parsed.people[number]>();
  for (const p of [...parsed.named, ...namedRows]) {
    const payer = norm(p.payer);
    const base = { sheetRow: p.sheetRow, kind: "named" as const, group: null as PlanPerson["group"], code: p.code, name: p.name, payer, queueNo: p.seq, ordered: Object.values(p.marks).filter((m) => m === "ordered").length, waived: Object.values(p.marks).filter((m) => m === "waived").length, externalLab: Object.values(p.marks).filter((m) => m === "external_lab").length };
    if (!payer || companyByName.has(payer)) {
      people.push({ ...base, group: "c", match: { state: "skipped", reason: !payer ? "ไม่ระบุบริษัทที่รับค่าใช้จ่าย" : "ไม่พบในรายชื่อพนักงานและบริษัทผู้จ่ายอยู่ในกลุ่มของเรา — ไม่สร้างเป็นผู้รับการตรวจภายนอก (ตรวจรหัส/ชื่อ หรือเพิ่มพนักงานก่อน)" } });
      continue;
    }
    const sp = splitThaiName(p.name);
    const key = `${payer}#${normPersonKey(sp.first, sp.last)}`;
    if (!sp.first) { people.push({ ...base, group: "c", match: { state: "skipped", reason: "ไม่มีชื่อ" } }); continue; }
    if (namedKeys.has(key)) { fileIssues.push(`แถว ${p.sheetRow}: ${p.name} (${payer}) ซ้ำกับแถวอื่นในไฟล์`); continue; }
    namedKeys.add(key);
    const selected = pickPayers.has(payer) || pickRows.has(p.sheetRow);
    const exists = existingNamed.has(key);
    people.push({ ...base, group: "b", match: { state: "external_candidate", selected, exists, sponsorCode: p.code } });
    if (selected) { named.push({ key, payer, first: sp.first, last: sp.last, title: sp.title, dob: p.dob, sponsorCode: p.code }); namedParsed.set(key, p); }
  }
  const needsFix = people.filter((p) => p.match.state === "needs_fix").length;

  // ── queue numbers: the "ลำดับ" column, placed for everyone who is imported (matched staff and placeholders) ──
  const queueAsk: Array<{ key: string; label: string; userId: number | null; ph: { payer: string; sortNo: number } | null; no: number | null; sheetRow: number }> = [
    ...matched.map((m) => ({ key: `u${m.userId}`, label: userLabel(users.find((u) => u.id === m.userId) as UserRow), userId: m.userId, ph: null, no: m.person.seq, sheetRow: m.person.sheetRow })),
    ...placeholders.map((x) => ({ key: `p${x.payer}#${x.sortNo}`, label: `${x.payer} คนที่ ${x.sortNo}`, userId: null, ph: { payer: x.payer, sortNo: x.sortNo }, no: x.person.seq, sheetRow: x.person.sheetRow }))
  ];
  const queuePlan: QueuePlan = { add: 0, change: 0, same: 0, noNumber: 0, clashes: [], skippedNoCode: people.filter((x) => x.group === "c").map((x) => `แถว ${x.sheetRow} ${x.name}`) };
  if (queuePlan.skippedNoCode.length > 0) warnings.push(`ข้าม ${queuePlan.skippedNoCode.length} แถวที่ยังไม่มีรหัสพนักงาน (ไม่จับคู่ด้วยชื่ออย่างเดียว): ${queuePlan.skippedNoCode.join(", ")}`);
  const seenNo = new Map<number, string>();
  for (const q of queueAsk) {
    if (q.no == null) continue;
    const dup = seenNo.get(q.no);
    if (dup) fileIssues.push(`ลำดับ ${q.no} ซ้ำในไฟล์ (${dup} และแถว ${q.sheetRow})`);
    else seenNo.set(q.no, `แถว ${q.sheetRow}`);
  }
  const existingQueue = round.id ? listQueueForImport(round.id) : [];
  const exKey = (e: (typeof existingQueue)[number]) => (e.user_id != null ? `u${e.user_id}` : `p${norm(e.ext_payer ?? "")}#${e.ext_sort}`);
  const exByKey = new Map(existingQueue.map((e) => [exKey(e), e]));
  const askKeys = new Set(queueAsk.map((q) => q.key));
  const queueOps: Ops["queue"] = [];
  for (const q of queueAsk) {
    if (q.no == null) { queuePlan.noNumber++; continue; }
    const holder = existingQueue.find((e) => e.queue_no === q.no && !askKeys.has(exKey(e)));
    if (holder) { queuePlan.clashes.push(`ลำดับ ${q.no} ของ ${q.label} ชนกับ ${holder.label} ที่มีอยู่ในรอบแล้วแต่ไม่อยู่ในไฟล์ — ไม่จัดลำดับให้ (แก้ที่หน้าลำดับคิว)`); continue; }
    const have = exByKey.get(q.key);
    if (!have) queuePlan.add++; else if (have.queue_no === q.no) queuePlan.same++; else queuePlan.change++;
    queueOps.push({ userId: q.userId, ph: q.ph, queueNo: q.no });
  }
  if (queuePlan.noNumber > 0) warnings.push(`${queuePlan.noNumber} คนในไฟล์ไม่มีเลขในคอลัมน์ “ลำดับ” จึงยังไม่มีคิว (กำหนดภายหลังที่หน้าลำดับคิว)`);

  // ── orders: file vs what is already there ──
  const locked = round.id ? lockedOrderIds(round.id) : new Set<number>();
  type Existing = { id: number; user_id: number | null; external_id: number | null; test_id: number; status: ParsedMark; payer: string | null; ext_payer: string | null; ext_sort: number | null; ext_first?: string | null; ext_last?: string | null };
  const existing = round.id ? db.prepare(`
    SELECT o.id, o.user_id, o.external_id, o.test_id, o.status, p.name_th AS payer, ep.name_th AS ext_payer, e.sort_no AS ext_sort
      FROM annual_checkup_orders o LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id
      LEFT JOIN annual_checkup_externals e ON e.id = o.external_id LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id
     WHERE o.round_id = ?`).all(round.id) as Existing[] : [];
  const extNames = round.id ? listExternalNamesForImport(round.id) : new Map<number, { first: string; last: string }>();
  for (const e of existing) if (e.external_id != null) { const n = extNames.get(e.external_id); if (n) { e.ext_first = n.first; e.ext_last = n.last; } }
  const subjKey = (e: Existing) => e.user_id != null ? `u${e.user_id}` : e.ext_first ? `n${norm(e.ext_payer ?? "")}#${normPersonKey(e.ext_first, e.ext_last ?? "")}` : `p${norm(e.ext_payer ?? "")}#${e.ext_sort}`;
  const existingBySubject = new Map<string, Existing[]>();
  for (const e of existing) existingBySubject.set(subjKey(e), [...(existingBySubject.get(subjKey(e)) ?? []), e]);

  const ops: OrderOp[] = [];
  const counts: PlanCounts = { add: 0, change: 0, same: 0, remove: 0, conflict: 0 };
  const conflicts: ImportPlan["conflicts"] = [];
  const nameOfTest = new Map(catalogue.map((t) => [t.id, t.name_th]));
  const conflict = (who: string, testId: number, reason: string) => { counts.conflict++; conflicts.push({ who, test: nameOfTest.get(testId) ?? String(testId), reason }); };

  const handle = (key: string, subject: Subject, who: string, payer: string, wanted: Map<number, ParsedMark>) => {
    const have = new Map((existingBySubject.get(key) ?? []).map((e) => [e.test_id, e]));
    for (const [testId, status] of wanted) {
      const e = have.get(testId);
      if (!e) { ops.push({ subject, payer, testId, status, kind: "add", orderId: null }); counts.add++; continue; }
      if (e.status === status && norm(e.payer ?? "") === payer) { counts.same++; continue; }
      if (locked.has(e.id)) { conflict(who, testId, "มีผลหรือข้อมูลทางคลินิกแล้ว ไม่เปลี่ยนให้อัตโนมัติ"); continue; }
      ops.push({ subject, payer, testId, status, kind: "change", orderId: e.id }); counts.change++;
    }
    for (const [testId, e] of have) {
      if (wanted.has(testId)) continue;
      if (locked.has(e.id)) { conflict(who, testId, "ไม่อยู่ในไฟล์แล้ว แต่มีผลหรือข้อมูลทางคลินิก ไม่ลบให้"); continue; }
      ops.push({ subject, payer, testId, status: e.status, kind: "remove", orderId: e.id }); counts.remove++;
    }
  };
  const wantedOf = (p: typeof parsed.people[number]) => {
    const m = new Map<number, ParsedMark>();
    for (const [name, status] of Object.entries(p.marks)) { const t = testByName.get(norm(name)); if (t) m.set(t.id, status); }
    return m;
  };
  for (const { person, userId } of matched) handle(`u${userId}`, { userId }, person.name, norm(person.payer), wantedOf(person));
  for (const n of named) handle(`n${n.key}`, { named: n.key }, [n.title, n.first, n.last].filter(Boolean).join(" "), n.payer, wantedOf(namedParsed.get(n.key) as typeof parsed.people[number]));
  for (const { person, payer, sortNo } of placeholders) handle(`p${payer}#${sortNo}`, { placeholder: { payer, sortNo } }, `${payer} คนที่ ${sortNo}`, payer, wantedOf(person));

  // A person who has orders in this round but is gone from the file loses them — only when every row was understood, otherwise a
  // typo in one row would look like "removed" and wipe that person's orders.
  const inFile = new Set<string>([...matched.map((m) => `u${m.userId}`), ...placeholders.map((p) => `p${p.payer}#${p.sortNo}`)]);
  const goneUsers = [...existingBySubject.keys()].filter((k) => k.startsWith("u") && !inFile.has(k));
  if (goneUsers.length > 0) {
    if (needsFix > 0) warnings.push(`มีคนที่มีคำสั่งตรวจอยู่แล้วแต่ไม่อยู่ในไฟล์ ${goneUsers.length} คน — ยังไม่ลบ เพราะมีแถวที่ต้องแก้ (แก้ให้ครบก่อนแล้วนำเข้าอีกครั้ง)`);
    else for (const k of goneUsers) {
      const rows = existingBySubject.get(k) ?? [];
      const who = userLabel(users.find((u) => u.id === rows[0].user_id) ?? { id: 0, display_name: `#${rows[0].user_id}`, title_prefix: null, status: "", employee_code: null });
      for (const e of rows) {
        if (locked.has(e.id)) conflict(who, e.test_id, "ไม่อยู่ในไฟล์แล้ว แต่มีผลหรือข้อมูลทางคลินิก ไม่ลบให้");
        else { ops.push({ subject: { userId: e.user_id as number }, payer: norm(e.payer ?? ""), testId: e.test_id, status: e.status, kind: "remove", orderId: e.id }); counts.remove++; }
      }
    }
  }
  const goneExternals = [...existingBySubject.keys()].filter((k) => (k.startsWith("p") || k.startsWith("n")) && !inFile.has(k) && ![...namedKeys].some((nk) => `n${nk}` === k));
  if (goneExternals.length > 0) warnings.push(`มีผู้เข้าตรวจภายนอก ${goneExternals.length} รายที่มีคำสั่งตรวจแต่ไม่อยู่ในไฟล์ — คงไว้ ไม่ลบ (อาจเติมชื่อไปแล้ว)`);

  // ── per-test counts, reconciled with the file's own totals row ──
  const perTest = parsed.testHeaders.flatMap((h) => {
    const t = testByName.get(norm(h));
    if (!t) return [];
    const marks = parsed.people.map((p) => p.marks[h]);
    const row = { code: t.code, nameTh: t.name_th, ordered: marks.filter((m) => m === "ordered").length, waived: marks.filter((m) => m === "waived").length, externalLab: marks.filter((m) => m === "external_lab").length, fileTotal: parsed.fileTotals?.[h] ?? null };
    if (row.fileTotal != null && row.fileTotal !== row.ordered) warnings.push(`จำนวนคนในแถวรวมของไฟล์ (${row.fileTotal}) ไม่ตรงกับจำนวนช่อง ✓ ที่อ่านได้ (${row.ordered}) ที่รายการ “${t.name_th}”`);
    return [row];
  });

  const ordersOut = ops.map((o) => ({ ...o, subject: "userId" in o.subject ? { u: o.subject.userId } : "named" in o.subject ? { n: o.subject.named } : o.subject.placeholder }));
  const ops2: Ops = { round, payers, programmes, placeholders: placeholders.map((p) => ({ payer: p.payer, sortNo: p.sortNo })), named, orders: ops, queue: queueOps };
  const hash = crypto.createHash("sha256").update(JSON.stringify({ round, payers, programmes, ph: ops2.placeholders, named, orders: ordersOut, queue: queueOps, needsFix, fileIssues })).digest("hex").slice(0, 24);
  return { plan: { fileIssues, round, payers, programmes: programmes.map((p) => ({ payer: p.payer, testCount: p.tests.length })), people, orders: counts, queue: queuePlan, conflicts, perTest, warnings, needsFix, hash }, ops: ops2 };
}

/** What importing this file would do. Writes nothing. */
export function buildImportPlan(db: Database.Database, parsed: ParsedWorkbook, input: RoundInput): ImportPlan {
  return compute(db, parsed, input).plan;
}

export type CommitResult = { roundId: number; created: boolean; ordersAdded: number; ordersChanged: number; ordersRemoved: number; externalsAdded: number; namedAdded: number; namedFound: number; skippedRows: number; conflicts: number; queueAdded: number; queueChanged: number };

/**
 * Write the plan the user looked at. Refused if the file has problems of its own, if rows still need fixing (unless the user chose to skip
 * them), or if the database changed since the preview (planHash no longer matches).
 */
export function commitImport(db: Database.Database, parsed: ParsedWorkbook, input: RoundInput, actorId: number, opts: { planHash: string; skipUnresolved: boolean }): CommitResult {
  const { plan, ops } = compute(db, parsed, input);
  if (plan.fileIssues.length > 0) throw new ImportRefused("file_issues", "ไฟล์มีปัญหา นำเข้าไม่ได้: " + plan.fileIssues[0]);
  if (plan.needsFix > 0 && !opts.skipUnresolved) throw new ImportRefused("needs_fix", `ยังมี ${plan.needsFix} แถวที่ต้องแก้ — แก้ให้ครบ หรือเลือก “ข้ามแถวที่ต้องแก้”`);
  if (plan.hash !== opts.planHash) throw new ImportRefused("plan_changed", "ข้อมูลเปลี่ยนไประหว่างดูตัวอย่างกับยืนยัน กรุณาดูตัวอย่างใหม่อีกครั้ง");

  return db.transaction((): CommitResult => {
    let roundId = ops.round.id;
    const created = roundId == null;
    if (roundId == null) {
      roundId = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, start_date, end_date, location, status, created_by) VALUES (?,?,?,?,?, 'draft', ?)")
        .run(ops.round.name, ops.round.yearBe, ops.round.startDate, ops.round.endDate, ops.round.location, actorId).lastInsertRowid);
    } else {
      db.prepare("UPDATE annual_checkup_rounds SET name = ?, year_be = ?, start_date = ?, end_date = ?, location = ? WHERE id = ?")
        .run(ops.round.name, ops.round.yearBe, ops.round.startDate, ops.round.endDate, ops.round.location, roundId);
    }
    const rid = roundId;

    const payerId = new Map<string, number>();
    for (const p of ops.payers) {
      const have = (db.prepare("SELECT id FROM annual_checkup_payers WHERE round_id = ? AND name_th = ?").get(rid, p.name) as { id: number } | undefined)?.id;
      payerId.set(p.name, have ?? Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, company_id, name_th, is_external) VALUES (?,?,?,?)").run(rid, p.companyId, p.name, p.external ? 1 : 0).lastInsertRowid));
    }

    for (const pg of ops.programmes) {
      const pid = payerId.get(pg.payer);
      if (pid == null) continue;
      const progId = (db.prepare("SELECT id FROM annual_checkup_programs WHERE round_id = ? AND payer_id = ?").get(rid, pid) as { id: number } | undefined)?.id
        ?? Number(db.prepare("INSERT INTO annual_checkup_programs (round_id, payer_id, name) VALUES (?,?,?)").run(rid, pid, pg.payer).lastInsertRowid);
      db.prepare("DELETE FROM annual_checkup_program_tests WHERE program_id = ?").run(progId);
      const ins = db.prepare("INSERT INTO annual_checkup_program_tests (program_id, test_id, scope) VALUES (?,?,?)");
      for (const t of pg.tests) ins.run(progId, t.testId, t.scope);
    }

    let externalsAdded = 0;
    const externalId = new Map<string, number>();
    for (const ph of ops.placeholders) {
      const pid = payerId.get(ph.payer) as number;
      const have = (db.prepare("SELECT id FROM annual_checkup_externals WHERE round_id = ? AND payer_id = ? AND sort_no = ?").get(rid, pid, ph.sortNo) as { id: number } | undefined)?.id;
      if (have) externalId.set(`${ph.payer}#${ph.sortNo}`, have);
      else {
        externalId.set(`${ph.payer}#${ph.sortNo}`, Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, is_placeholder, sort_no) VALUES (?,?,1,?)").run(rid, pid, ph.sortNo).lastInsertRowid));
        externalsAdded++;
      }
    }

    // outside examinees the user ticked: found again by name + company (+ date of birth), never duplicated
    let namedAdded = 0, namedFound = 0;
    const namedId = new Map<string, number>();
    for (const n of ops.named) {
      const pid = payerId.get(n.payer) as number;
      const r = upsertExternalPerson(rid, pid, { title: n.title, firstName: n.first, lastName: n.last, dob: n.dob, sex: sexFromTitle(n.title), sponsorEmployeeCode: n.sponsorCode }, actorId);
      namedId.set(n.key, r.externalId);
      if (r.created) namedAdded++; else namedFound++;
    }

    let added = 0, changed = 0, removed = 0;
    for (const o of ops.orders) {
      const pid = payerId.get(o.payer) ?? null;
      if (o.kind === "remove") { db.prepare("DELETE FROM annual_checkup_orders WHERE id = ?").run(o.orderId); removed++; continue; }
      if (o.kind === "change") { db.prepare("UPDATE annual_checkup_orders SET status = ?, payer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(o.status, pid, o.orderId); changed++; continue; }
      const userId = "userId" in o.subject ? o.subject.userId : null;
      const extId = "placeholder" in o.subject ? (externalId.get(`${o.subject.placeholder.payer}#${o.subject.placeholder.sortNo}`) as number) : "named" in o.subject ? (namedId.get(o.subject.named) as number) : null;
      db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, external_id, payer_id, test_id, status) VALUES (?,?,?,?,?,?)").run(rid, userId, extId, pid, o.testId, o.status);
      added++;
    }
    // queue numbers (swap-safe, all or nothing); placeholders' externals exist by now
    const q = applyQueuePlan({ id: actorId }, rid, ops.queue.map((x) => ({
      subject: x.userId != null ? { userId: x.userId } : { externalId: externalId.get(`${(x.ph as { payer: string }).payer}#${(x.ph as { sortNo: number }).sortNo}`) as number },
      queueNo: x.queueNo
    })));
    logPersonaAction(actorId, "annual_checkup.import", rid);
    return { roundId: rid, created, ordersAdded: added, ordersChanged: changed, ordersRemoved: removed, externalsAdded, namedAdded, namedFound, skippedRows: plan.needsFix, conflicts: plan.orders.conflict, queueAdded: q.added, queueChanged: q.changed };
  })();
}
