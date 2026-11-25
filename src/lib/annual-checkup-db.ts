// Annual health check-up programme — THE gateway (phase 2, docs/annual-checkup-plan.md §4.3).
//
// This is the only module allowed to read or write annual_checkup_results / _order_clinical / _conclusions / _result_revisions
// (scripts/scan-build-risks.mjs fails the build if another file mentions them). SQLite has no row-level security, so who may READ
// is decided here; who may WRITE is decided here AND by the triggers in annual-checkup-schema.ts.
//
//   • employee        → only their own results, only those released (status 'released')
//   • recorder        → clinic-branch staff with the recorder flag: record / waive-reason / read clinical
//   • approver        → a clinic doctor with the approver flag + licence number, unlocked this session: verify / revise / release
//   • HR / admin      → progress counts only (no function here returns them a result row, a waive reason or a comment)
//   • super_admin     → grants / revokes the two flags; sees progress; sees NO result unless they are themselves eligible clinic staff
//
// Every function takes the actor first and re-reads the actor from the database (never trusts flags the caller passes), and every
// read or write of a result leaves a row in annual_checkup_audit in the same transaction.
import crypto from "node:crypto";
import { getDb, logPersonaAction } from "./db";
import { approverOk, recorderOk } from "./annual-checkup-schema";
import { nameWithPrefix } from "./name";

export type AcActor = { id: number };
export type AcSubject = { userId: number; externalId?: undefined } | { externalId: number; userId?: undefined };
export type Capability = "recorder" | "approver";
export type Interpretation = "normal" | "abnormal" | "follow_up";

export class AnnualCheckupForbidden extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); this.name = "AnnualCheckupForbidden"; }
}
export class AnnualCheckupInvalid extends Error {
  constructor(public code: string, detail?: string) { super(detail ?? code); this.name = "AnnualCheckupInvalid"; }
}
export const isAnnualCheckupForbidden = (e: unknown): e is AnnualCheckupForbidden => e instanceof AnnualCheckupForbidden;
export const isAnnualCheckupInvalid = (e: unknown): e is AnnualCheckupInvalid => e instanceof AnnualCheckupInvalid;

// ── actor + eligibility (same SQL fragments the triggers use) ──────────────────────────────────────────────────────

type ActorRow = { id: number; role: "super_admin" | "admin" | "staff"; status: string; is_hr_analytics: number };

function loadActor(actor: AcActor): ActorRow {
  const row = getDb().prepare("SELECT id, role, status, is_hr_analytics FROM users WHERE id = ?").get(actor?.id) as ActorRow | undefined;
  if (!row || ["disabled", "resigned", "terminated"].includes(row.status)) throw new AnnualCheckupForbidden("unauthenticated");
  return row;
}

const evalSql = (fragment: string, id: number): boolean =>
  !!(getDb().prepare(`SELECT ${fragment} AS ok`).get({ id }) as { ok: number }).ok;

/** Active, flagged recorder (or approver), and on the clinic branch roster right now. */
export const isRecorderEligible = (userId: number): boolean => evalSql(recorderOk("@id"), userId);
/** Active clinic doctor with the approver flag and a licence number on file. (The session unlock is checked separately.) */
export const isApproverEligible = (userId: number): boolean => evalSql(approverOk("@id"), userId);

function requireRecorder(actor: AcActor): ActorRow {
  const a = loadActor(actor);
  if (!isRecorderEligible(a.id)) throw new AnnualCheckupForbidden("not_recorder");
  return a;
}
function requireApprover(actor: AcActor, licenseUnlocked: boolean): ActorRow {
  const a = loadActor(actor);
  if (!isApproverEligible(a.id)) throw new AnnualCheckupForbidden("not_approver");
  if (!licenseUnlocked) throw new AnnualCheckupForbidden("license_not_unlocked");
  return a;
}

/** The licence number the doctor types at the unlock gate (digits compared, like Mounjaro's verifyClinicalLicense). */
export function verifyApproverLicense(actor: AcActor, provided: string): boolean {
  const a = loadActor(actor);
  if (!isApproverEligible(a.id)) return false;
  const want = ((getDb().prepare("SELECT license_no FROM users WHERE id = ?").get(a.id) as { license_no: string | null }).license_no ?? "").replace(/\D/g, "");
  return want.length > 0 && want === (provided ?? "").replace(/\D/g, "");
}

/** A refusal raised by one of the database triggers surfaces as a Forbidden carrying the trigger's message. */
function guard<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof Error && e.message.startsWith("annual_checkup:")) throw new AnnualCheckupForbidden("db_refused", e.message);
    throw e;
  }
}

function audit(actorId: number, action: string, subject: { user_id: number | null; external_id: number | null } | null, roundId: number | null, orderId: number | null, detail?: string): void {
  getDb().prepare(`
    INSERT INTO annual_checkup_audit (actor_id, action, subject_user_id, subject_external_id, round_id, order_id, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(actorId, action, subject?.user_id ?? null, subject?.external_id ?? null, roundId, orderId, detail ?? null);
}

const subjectCols = (s: AcSubject) => ({ user_id: s.userId ?? null, external_id: s.externalId ?? null });
const clean = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// ── for the importer: which orders must not be changed or removed ──────────────────────────────────────────────────────

/**
 * Orders of a round that already have a result or clinical data (a waive reason / an outside lab's name). The import never changes
 * or removes these — it reports them as conflicts for clinical staff to settle. Returns ids only, so nothing clinical leaks to the caller.
 */
export function lockedOrderIds(roundId: number): Set<number> {
  const rows = getDb().prepare(`
    SELECT o.id FROM annual_checkup_orders o
     WHERE o.round_id = ? AND (EXISTS (SELECT 1 FROM annual_checkup_results r WHERE r.order_id = o.id)
                            OR EXISTS (SELECT 1 FROM annual_checkup_order_clinical c WHERE c.order_id = o.id))
  `).all(roundId) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

// ── grants (super_admin only) ──────────────────────────────────────────────────────────────────────────────────────

const FLAG: Record<Capability, "health_result_recorder" | "health_result_approver"> = {
  recorder: "health_result_recorder", approver: "health_result_approver"
};

export function grantCapability(actor: AcActor, targetUserId: number, capability: Capability, reason: string): void {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  if (!clean(reason)) throw new AnnualCheckupInvalid("reason_required");
  const db = getDb();
  guard(() => db.transaction(() => {
    // the trigger refuses anyone who is not active clinic staff (and, for approver, not a doctor with a licence number)
    db.prepare("INSERT INTO annual_checkup_grants (user_id, capability, action, by_user_id, reason) VALUES (?, ?, 'grant', ?, ?)").run(targetUserId, capability, a.id, clean(reason));
    db.prepare(`UPDATE users SET ${FLAG[capability]} = 1 WHERE id = ?`).run(targetUserId);
  })());
  logPersonaAction(a.id, `annual_checkup.grant.${capability}`, targetUserId);
}

export function revokeCapability(actor: AcActor, targetUserId: number, capability: Capability, reason: string): void {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  if (!clean(reason)) throw new AnnualCheckupInvalid("reason_required");
  const db = getDb();
  guard(() => db.transaction(() => {
    db.prepare("INSERT INTO annual_checkup_grants (user_id, capability, action, by_user_id, reason) VALUES (?, ?, 'revoke', ?, ?)").run(targetUserId, capability, a.id, clean(reason));
    db.prepare(`UPDATE users SET ${FLAG[capability]} = 0 WHERE id = ?`).run(targetUserId);
  })());
  logPersonaAction(a.id, `annual_checkup.revoke.${capability}`, targetUserId);
}

export function listGrants(actor: AcActor): Array<Record<string, unknown>> {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  return getDb().prepare(`
    SELECT g.id, g.user_id, u.display_name AS user_name, g.capability, g.action, g.by_user_id, g.reason, g.created_at
      FROM annual_checkup_grants g JOIN users u ON u.id = g.user_id ORDER BY g.id DESC
  `).all() as Array<Record<string, unknown>>;
}

// ── recording (recorder) ───────────────────────────────────────────────────────────────────────────────────────────

export type ResultInput = {
  valueNum?: number | null; valueText?: string | null; valueJson?: string | null; unit?: string | null; refText?: string | null;
  interpretation?: Interpretation | null; filePath?: string | null; fileMime?: string | null;
};

const INTERPRETATIONS = new Set(["normal", "abnormal", "follow_up"]);

function normalizeInput(d: ResultInput) {
  if (d.interpretation != null && !INTERPRETATIONS.has(d.interpretation)) throw new AnnualCheckupInvalid("bad_interpretation");
  if (d.valueNum != null && !Number.isFinite(d.valueNum)) throw new AnnualCheckupInvalid("bad_value");
  return {
    value_num: d.valueNum ?? null, value_text: clean(d.valueText), value_json: clean(d.valueJson, 8000), unit: clean(d.unit, 40),
    ref_text: clean(d.refText, 200), interpretation: d.interpretation ?? null, file_path: clean(d.filePath, 500), file_mime: clean(d.fileMime, 100)
  };
}

type OrderRow = { id: number; round_id: number; user_id: number | null; external_id: number | null; status: "ordered" | "waived" | "external_lab" };
const loadOrder = (orderId: number): OrderRow => {
  const o = getDb().prepare("SELECT id, round_id, user_id, external_id, status FROM annual_checkup_orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!o) throw new AnnualCheckupInvalid("order_not_found");
  return o;
};

/** Record (or overwrite while still draft) the result of one ordered test. A waived test cannot have a result; an external-lab test needs the lab's file. */
export function recordResult(actor: AcActor, orderId: number, data: ResultInput): number {
  const a = requireRecorder(actor);
  const v = normalizeInput(data);
  const db = getDb();
  return guard(() => db.transaction(() => {
    const o = loadOrder(orderId);
    if (o.status === "waived") throw new AnnualCheckupInvalid("order_waived");
    const cur = db.prepare("SELECT id, status, file_path FROM annual_checkup_results WHERE order_id = ?").get(orderId) as { id: number; status: string; file_path: string | null } | undefined;
    const keepFile = data.filePath === undefined && data.fileMime === undefined;     // editing the values must not drop an attached file
    if (o.status === "external_lab" && !v.file_path && !(keepFile && cur?.file_path)) throw new AnnualCheckupInvalid("external_lab_needs_file");
    let id: number;
    if (!cur) {
      id = Number(db.prepare(`
        INSERT INTO annual_checkup_results (order_id, value_num, value_text, value_json, unit, ref_text, interpretation, file_path, file_mime, recorded_by)
        VALUES (@order_id, @value_num, @value_text, @value_json, @unit, @ref_text, @interpretation, @file_path, @file_mime, @by)
      `).run({ order_id: orderId, ...v, by: a.id }).lastInsertRowid);
    } else {
      if (cur.status !== "draft") throw new AnnualCheckupInvalid("result_locked");
      id = cur.id;
      db.prepare(`
        UPDATE annual_checkup_results SET value_num=@value_num, value_text=@value_text, value_json=@value_json, unit=@unit, ref_text=@ref_text,
               interpretation=@interpretation, file_path = CASE WHEN @keep = 1 THEN file_path ELSE @file_path END,
               file_mime = CASE WHEN @keep = 1 THEN file_mime ELSE @file_mime END, recorded_by=@by, recorded_at=CURRENT_TIMESTAMP
         WHERE id=@id
      `).run({ id, ...v, by: a.id, keep: keepFile ? 1 : 0 });
    }
    audit(a.id, cur ? "result.update" : "result.record", o, o.round_id, o.id);
    return id;
  })());
}

/** The medical reason for waiving a test and the outside lab's name — kept apart from the orders HR can count. */
export function setOrderClinical(actor: AcActor, orderId: number, d: { waiveReason?: string | null; externalLabName?: string | null }): void {
  const a = requireRecorder(actor);
  const db = getDb();
  guard(() => db.transaction(() => {
    const o = loadOrder(orderId);
    db.prepare(`
      INSERT INTO annual_checkup_order_clinical (order_id, waive_reason, external_lab_name, set_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET waive_reason = excluded.waive_reason, external_lab_name = excluded.external_lab_name,
                                          set_by = excluded.set_by, set_at = CURRENT_TIMESTAMP
    `).run(orderId, clean(d.waiveReason), clean(d.externalLabName, 200), a.id);
    audit(a.id, "order_clinical.set", o, o.round_id, o.id);
  })());
}

export function getOrderClinical(actor: AcActor, orderId: number): { waive_reason: string | null; external_lab_name: string | null } | null {
  const a = requireRecorder(actor);
  const o = loadOrder(orderId);
  audit(a.id, "order_clinical.view", o, o.round_id, o.id);
  return (getDb().prepare("SELECT waive_reason, external_lab_name FROM annual_checkup_order_clinical WHERE order_id = ?").get(orderId) as
    { waive_reason: string | null; external_lab_name: string | null } | undefined) ?? null;
}

/** Everything clinical staff see about one person in one round, drafts included. */
export function getSubjectClinical(actor: AcActor, roundId: number, subject: AcSubject): {
  results: Array<Record<string, unknown>>; conclusion: Record<string, unknown> | null; submission: { submitted_at: string; by_name: string } | null;
} {
  const a = requireRecorder(actor);
  const db = getDb();
  const col = subject.userId != null ? "o.user_id" : "o.external_id";
  const id = subject.userId ?? subject.externalId;
  const results = db.prepare(`
    SELECT o.id AS order_id, o.status AS order_status, t.code, t.name_th, t.name_en, t.unit AS test_unit,
           oc.waive_reason, oc.external_lab_name,
           r.id AS result_id, r.revision, r.status AS result_status, r.value_num, r.value_text, r.value_json, r.unit, r.ref_text,
           t.value_kind, r.interpretation, CASE WHEN r.file_path IS NOT NULL THEN 1 ELSE 0 END AS has_file, r.recorded_by, r.recorded_at, r.verified_by, r.verified_at, r.released_at
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
      LEFT JOIN annual_checkup_order_clinical oc ON oc.order_id = o.id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND ${col} = ? ORDER BY t.sort_no
  `).all(roundId, id) as Array<Record<string, unknown>>;
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const conclusion = (db.prepare(`SELECT summary, doctor_comment, verified_by, verified_at, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ?`)
    .get(roundId, id) as Record<string, unknown> | undefined) ?? null;
  const submission = (db.prepare(`SELECT sb.submitted_at, u.display_name AS by_name FROM annual_checkup_submissions sb JOIN users u ON u.id = sb.submitted_by WHERE sb.round_id = ? AND sb.${ccol} = ?`)
    .get(roundId, id) as { submitted_at: string; by_name: string } | undefined) ?? null;
  audit(a.id, "subject.view", subjectCols(subject), roundId, null);
  return { results, conclusion, submission };
}

// ── approval (approver doctor, licence unlocked) ───────────────────────────────────────────────────────────────────

type ResultRow = { id: number; order_id: number; revision: number; status: "draft" | "verified" | "released";
  value_num: number | null; value_text: string | null; value_json: string | null; unit: string | null; ref_text: string | null;
  interpretation: Interpretation | null; file_path: string | null; file_mime: string | null };

const loadResult = (id: number): ResultRow => {
  const r = getDb().prepare("SELECT id, order_id, revision, status, value_num, value_text, value_json, unit, ref_text, interpretation, file_path, file_mime FROM annual_checkup_results WHERE id = ?")
    .get(id) as ResultRow | undefined;
  if (!r) throw new AnnualCheckupInvalid("result_not_found");
  return r;
};

export function verifyResult(actor: AcActor, resultId: number, opts: { licenseUnlocked: boolean }): void {
  const a = requireApprover(actor, opts.licenseUnlocked);
  const db = getDb();
  guard(() => db.transaction(() => {
    const r = loadResult(resultId);
    if (r.status !== "draft") throw new AnnualCheckupInvalid("not_draft");
    if (r.value_num == null && !r.value_text && !r.value_json && !r.file_path) throw new AnnualCheckupInvalid("result_empty");
    const o = loadOrder(r.order_id);
    db.prepare("UPDATE annual_checkup_results SET status = 'verified', verified_by = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.id, r.id);
    audit(a.id, "result.verify", o, o.round_id, o.id);
  })());
}

/** Change a verified / released result: the current version is snapshotted, the revision number goes up and the result is a draft again. */
export function reviseResult(actor: AcActor, resultId: number, data: ResultInput, reason: string, opts: { licenseUnlocked: boolean }): void {
  const a = requireApprover(actor, opts.licenseUnlocked);
  if (!clean(reason)) throw new AnnualCheckupInvalid("reason_required");
  const db = getDb();
  guard(() => db.transaction(() => {
    const r = loadResult(resultId);
    if (r.status === "draft") throw new AnnualCheckupInvalid("not_locked");
    const o = loadOrder(r.order_id);
    const merged = normalizeInput({
      valueNum: data.valueNum !== undefined ? data.valueNum : r.value_num, valueText: data.valueText !== undefined ? data.valueText : r.value_text,
      valueJson: data.valueJson !== undefined ? data.valueJson : r.value_json, unit: data.unit !== undefined ? data.unit : r.unit,
      refText: data.refText !== undefined ? data.refText : r.ref_text, interpretation: data.interpretation !== undefined ? data.interpretation : r.interpretation,
      filePath: data.filePath !== undefined ? data.filePath : r.file_path, fileMime: data.fileMime !== undefined ? data.fileMime : r.file_mime
    });
    db.prepare("INSERT INTO annual_checkup_result_revisions (result_id, revision, snapshot_json, reason, revised_by) VALUES (?, ?, ?, ?, ?)")
      .run(r.id, r.revision, JSON.stringify(r), clean(reason), a.id);
    db.prepare(`
      UPDATE annual_checkup_results SET revision = revision + 1, status = 'draft', value_num=@value_num, value_text=@value_text, value_json=@value_json,
             unit=@unit, ref_text=@ref_text, interpretation=@interpretation, file_path=@file_path, file_mime=@file_mime,
             recorded_by=@by, recorded_at=CURRENT_TIMESTAMP, verified_by=NULL, verified_at=NULL, released_by=NULL, released_at=NULL
       WHERE id=@id
    `).run({ id: r.id, ...merged, by: a.id });
    audit(a.id, "result.revise", o, o.round_id, o.id, clean(reason) ?? undefined);
  })());
}

export function saveConclusion(actor: AcActor, roundId: number, subject: AcSubject, d: { summary?: Interpretation | null; doctorComment?: string | null }, opts: { licenseUnlocked: boolean }): void {
  const a = requireApprover(actor, opts.licenseUnlocked);
  if (d.summary != null && !INTERPRETATIONS.has(d.summary)) throw new AnnualCheckupInvalid("bad_interpretation");
  const db = getDb();
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const id = subject.userId ?? subject.externalId;
  guard(() => db.transaction(() => {
    const cur = db.prepare(`SELECT id, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ?`).get(roundId, id) as { id: number; released_at: string | null } | undefined;
    if (cur?.released_at) throw new AnnualCheckupInvalid("conclusion_released");
    if (cur) {
      db.prepare("UPDATE annual_checkup_conclusions SET summary = ?, doctor_comment = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(d.summary ?? null, clean(d.doctorComment, 4000), a.id, cur.id);
    } else {
      db.prepare(`INSERT INTO annual_checkup_conclusions (round_id, ${ccol}, summary, doctor_comment, verified_by) VALUES (?, ?, ?, ?, ?)`)
        .run(roundId, id, d.summary ?? null, clean(d.doctorComment, 4000), a.id);
    }
    audit(a.id, "conclusion.save", subjectCols(subject), roundId, null);
  })());
}

/**
 * Open one person's results to them. Needs the conclusion and every test that is not waived verified (or already released).
 * Returns how many results were released now. The LINE card is sent by the caller afterwards (phase 5) — never with a value in it.
 */
export function releaseSubject(actor: AcActor, roundId: number, subject: AcSubject, opts: { licenseUnlocked: boolean }): number {
  const a = requireApprover(actor, opts.licenseUnlocked);
  const db = getDb();
  const col = subject.userId != null ? "o.user_id" : "o.external_id";
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const id = subject.userId ?? subject.externalId;
  return guard(() => db.transaction(() => {
    const concl = db.prepare(`SELECT id, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ?`).get(roundId, id) as { id: number; released_at: string | null } | undefined;
    if (!concl) throw new AnnualCheckupInvalid("no_conclusion");
    const rows = db.prepare(`
      SELECT o.status AS order_status, r.id AS result_id, r.status AS result_status
        FROM annual_checkup_orders o LEFT JOIN annual_checkup_results r ON r.order_id = o.id WHERE o.round_id = ? AND ${col} = ?
    `).all(roundId, id) as Array<{ order_status: string; result_id: number | null; result_status: string | null }>;
    const required = rows.filter((x) => x.order_status !== "waived");
    if (required.length === 0) throw new AnnualCheckupInvalid("nothing_to_release");
    if (required.some((x) => x.result_status !== "verified" && x.result_status !== "released")) throw new AnnualCheckupInvalid("not_all_verified");
    let n = 0;
    for (const x of required) {
      if (x.result_status === "verified") {
        db.prepare("UPDATE annual_checkup_results SET status = 'released', released_by = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.id, x.result_id);
        n++;
      }
    }
    if (!concl.released_at) db.prepare("UPDATE annual_checkup_conclusions SET released_by = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.id, concl.id);
    // results of a person who already had their results released were changed and approved again → tell them once
    if (concl.released_at && n > 0 && subject.userId != null) db.prepare("INSERT INTO annual_checkup_revision_notices (round_id, user_id) VALUES (?, ?)").run(roundId, subject.userId);
    audit(a.id, "subject.release", subjectCols(subject), roundId, null, `released ${n}`);
    return n;
  })());
}

// ── employee: own released results only ────────────────────────────────────────────────────────────────────────────

export function getMyReleasedResults(actor: AcActor, roundId: number): {
  results: Array<Record<string, unknown>>; conclusion: { summary: string | null; doctor_comment: string | null; released_at: string } | null;
} {
  const a = loadActor(actor);
  const db = getDb();
  // The employee is the subject by construction: a.id comes from the session, never from a parameter.
  // The stored file path never leaves here — the page gets a result id and a flag, and opens the file through getMyResultFile.
  const results = db.prepare(`
    SELECT r.id AS result_id, t.code, t.name_th, t.name_en, t.value_kind, r.value_num, r.value_text, r.value_json, r.unit, r.ref_text, r.interpretation,
           CASE WHEN r.file_path IS NOT NULL THEN 1 ELSE 0 END AS has_file, r.released_at
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
      JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND o.user_id = ? AND r.status = 'released' ORDER BY t.sort_no
  `).all(roundId, a.id) as Array<Record<string, unknown>>;
  const conclusion = (db.prepare("SELECT summary, doctor_comment, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND user_id = ? AND released_at IS NOT NULL")
    .get(roundId, a.id) as { summary: string | null; doctor_comment: string | null; released_at: string } | undefined) ?? null;
  audit(a.id, "self.view", { user_id: a.id, external_id: null }, roundId, null);
  return { results, conclusion };
}

/** Rounds in which the signed-in employee has results released to them (newest first). Nothing about the content. */
export function getMyRounds(actor: AcActor): Array<{ id: number; name: string; year_be: number | null; released_at: string }> {
  const a = loadActor(actor);
  return getDb().prepare(`
    SELECT r.id, r.name, r.year_be, c.released_at
      FROM annual_checkup_conclusions c JOIN annual_checkup_rounds r ON r.id = c.round_id
     WHERE c.user_id = ? AND c.released_at IS NOT NULL ORDER BY c.released_at DESC, r.id DESC
  `).all(a.id) as Array<{ id: number; name: string; year_be: number | null; released_at: string }>;
}

/** The file behind one of the employee's OWN released results; null for anyone else's, or one not released. Audited. */
export function getMyResultFile(actor: AcActor, resultId: number): { path: string; mime: string } | null {
  const a = loadActor(actor);
  const r = getDb().prepare(`
    SELECT r.file_path, r.file_mime, o.round_id FROM annual_checkup_results r JOIN annual_checkup_orders o ON o.id = r.order_id
     WHERE r.id = ? AND o.user_id = ? AND r.status = 'released' AND r.file_path IS NOT NULL
  `).get(resultId, a.id) as { file_path: string; file_mime: string | null; round_id: number } | undefined;
  if (!r) return null;
  audit(a.id, "self.file", { user_id: a.id, external_id: null }, r.round_id, resultId);
  return { path: r.file_path, mime: r.file_mime ?? "application/octet-stream" };
}

// ── LINE notice bookkeeping (system job: no signed-in person) ─────────────────────────────────────────────────────────

/** People whose results were released but who have not been told yet and can be (an active account linked to LINE). */
export function listPendingNotifications(limit = 50): Array<{ conclusion_id: number; user_id: number; line_user_id: string }> {
  return getDb().prepare(`
    SELECT c.id AS conclusion_id, c.user_id, u.line_user_id
      FROM annual_checkup_conclusions c JOIN users u ON u.id = c.user_id
     WHERE c.released_at IS NOT NULL AND c.notified_at IS NULL AND c.user_id IS NOT NULL
       AND u.status NOT IN ('disabled', 'resigned', 'terminated') AND u.line_user_id IS NOT NULL AND u.line_user_id <> ''
     ORDER BY c.id LIMIT ?
  `).all(limit) as Array<{ conclusion_id: number; user_id: number; line_user_id: string }>;
}
export function markNotified(conclusionId: number): void {
  getDb().prepare("UPDATE annual_checkup_conclusions SET notified_at = CURRENT_TIMESTAMP WHERE id = ? AND notified_at IS NULL").run(conclusionId);
}

/** For the recorders: who has released results but no LINE linked, so nobody told them (names only, never a result). */
export function getRoundLineGaps(actor: AcActor, roundId: number): string[] {
  requireRecorder(actor);
  return (getDb().prepare(`
    SELECT u.display_name, u.title_prefix
      FROM annual_checkup_conclusions c JOIN users u ON u.id = c.user_id
     WHERE c.round_id = ? AND c.released_at IS NOT NULL AND (u.line_user_id IS NULL OR u.line_user_id = '')
       AND u.status NOT IN ('disabled', 'resigned', 'terminated') ORDER BY u.display_name
  `).all(roundId) as Array<{ display_name: string; title_prefix: string | null }>).map((x) => nameWithPrefix(x.title_prefix, x.display_name));
}

// ── printable report for a person without an account (clinical staff, after release) ──────────────────────────────────

export function getExternalReport(actor: AcActor, roundId: number, externalId: number): {
  round: { name: string; year_be: number | null }; person: { label: string; sex: "M" | "F" | null; dob: string | null; payer: string };
  results: Array<Record<string, unknown>>; conclusion: { summary: string | null; doctor_comment: string | null; released_at: string; doctor: string | null; license_no: string | null };
} {
  const a = requireRecorder(actor);
  const db = getDb();
  const e = db.prepare("SELECT e.full_name, e.sort_no, e.sex, e.dob, p.name_th AS payer FROM annual_checkup_externals e JOIN annual_checkup_payers p ON p.id = e.payer_id WHERE e.id = ? AND e.round_id = ?")
    .get(externalId, roundId) as { full_name: string | null; sort_no: number; sex: "M" | "F" | null; dob: string | null; payer: string } | undefined;
  if (!e) throw new AnnualCheckupInvalid("subject_not_found");
  const round = db.prepare("SELECT name, year_be FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { name: string; year_be: number | null };
  const c = db.prepare(`
    SELECT c.summary, c.doctor_comment, c.released_at, u.display_name AS doctor, u.title_prefix AS doctor_prefix, u.license_no
      FROM annual_checkup_conclusions c LEFT JOIN users u ON u.id = c.released_by WHERE c.round_id = ? AND c.external_id = ? AND c.released_at IS NOT NULL
  `).get(roundId, externalId) as { summary: string | null; doctor_comment: string | null; released_at: string; doctor: string | null; doctor_prefix: string | null; license_no: string | null } | undefined;
  if (!c) throw new AnnualCheckupInvalid("not_released");
  const results = db.prepare(`
    SELECT t.code, t.name_th, t.value_kind, r.value_num, r.value_text, r.value_json, r.unit, r.ref_text, r.interpretation
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND o.external_id = ? AND r.status = 'released' ORDER BY t.sort_no
  `).all(roundId, externalId) as Array<Record<string, unknown>>;
  audit(a.id, "external.report", { user_id: null, external_id: externalId }, roundId, null);
  return {
    round, person: { label: externalLabel(e.full_name, e.sort_no, e.payer), sex: e.sex, dob: e.dob, payer: e.payer }, results,
    conclusion: { summary: c.summary, doctor_comment: c.doctor_comment, released_at: c.released_at, doctor: c.doctor ? nameWithPrefix(c.doctor_prefix, c.doctor) : null, license_no: c.license_no }
  };
}

/** "Who opened my results" — everything done to this person's results by someone else. */
export function getMyAuditTrail(actor: AcActor): Array<{ action: string; by_name: string; created_at: string }> {
  const a = loadActor(actor);
  return getDb().prepare(`
    SELECT x.action, u.display_name AS by_name, x.created_at
      FROM annual_checkup_audit x JOIN users u ON u.id = x.actor_id
     WHERE x.subject_user_id = ? AND x.actor_id <> ? ORDER BY x.id DESC LIMIT 200
  `).all(a.id, a.id) as Array<{ action: string; by_name: string; created_at: string }>;
}

// ── HR / admin / super_admin: counts only ──────────────────────────────────────────────────────────────────────────

export type ProgressState = "not_checked" | "checked" | "awaiting_result" | "released";
export type Progress = { total: number; byState: Record<ProgressState, number>; byPayer: Array<{ payer: string; total: number; byState: Record<ProgressState, number> }> };
const emptyStates = (): Record<ProgressState, number> => ({ not_checked: 0, checked: 0, awaiting_result: 0, released: 0 });

/**
 * Progress for a round. States (per person): not_checked = nothing recorded; checked = some of the required tests recorded;
 * awaiting_result = every required test recorded, not all released yet; released = all released. Waived tests are not required.
 * Nothing here says which test, which value, or why — and a person with only waived tests simply counts as not_checked.
 */
export function getProgress(actor: AcActor, roundId: number): Progress {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || a.role === "admin" || a.is_hr_analytics === 1)) throw new AnnualCheckupForbidden("not_allowed");
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.user_id, o.external_id, COALESCE(p.name_th, 'ไม่ระบุ') AS payer,
           SUM(o.status <> 'waived') AS required,
           SUM(o.status <> 'waived' AND r.id IS NOT NULL) AS recorded,
           SUM(o.status <> 'waived' AND r.status = 'released') AS released
      FROM annual_checkup_orders o LEFT JOIN annual_checkup_results r ON r.order_id = o.id
      LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id
     WHERE o.round_id = ? GROUP BY o.user_id, o.external_id, p.name_th
  `).all(roundId) as Array<{ user_id: number | null; external_id: number | null; payer: string; required: number; recorded: number; released: number }>;
  const out: Progress = { total: 0, byState: emptyStates(), byPayer: [] };
  const payer = new Map<string, { payer: string; total: number; byState: Record<ProgressState, number> }>();
  for (const r of rows) {
    const state: ProgressState = r.required > 0 && r.released === r.required ? "released"
      : r.recorded === 0 ? "not_checked" : r.recorded < r.required ? "checked" : "awaiting_result";
    out.total++; out.byState[state]++;
    const p = payer.get(r.payer) ?? { payer: r.payer, total: 0, byState: emptyStates() };
    p.total++; p.byState[state]++; payer.set(r.payer, p);
  }
  out.byPayer = [...payer.values()];
  return out;
}


// ── clinical screens (phase 4): lists, sheets, files ───────────────────────────────────────────────────────────────

export const subjectKey = (s: AcSubject): string => (s.userId != null ? `u${s.userId}` : `e${s.externalId}`);
export function parseSubjectKey(k: string): AcSubject | null {
  const m = /^([ue])(\d{1,9})$/.exec(k ?? "");
  return m ? (m[1] === "u" ? { userId: Number(m[2]) } : { externalId: Number(m[2]) }) : null;
}

export type RoundSummary = { id: number; name: string; status: string; year_be: number | null; subjects: number; required: number; recorded: number; verified: number; released: number };

export function listRoundsClinical(actor: AcActor): RoundSummary[] {
  requireRecorder(actor);
  return getDb().prepare(`
    SELECT r.id, r.name, r.status, r.year_be,
           (SELECT COUNT(DISTINCT COALESCE(o.user_id, -o.external_id)) FROM annual_checkup_orders o WHERE o.round_id = r.id) AS subjects,
           (SELECT COUNT(*) FROM annual_checkup_orders o WHERE o.round_id = r.id AND o.status <> 'waived') AS required,
           (SELECT COUNT(*) FROM annual_checkup_orders o JOIN annual_checkup_results x ON x.order_id = o.id WHERE o.round_id = r.id AND o.status <> 'waived') AS recorded,
           (SELECT COUNT(*) FROM annual_checkup_orders o JOIN annual_checkup_results x ON x.order_id = o.id WHERE o.round_id = r.id AND o.status <> 'waived' AND x.status IN ('verified','released')) AS verified,
           (SELECT COUNT(*) FROM annual_checkup_orders o JOIN annual_checkup_results x ON x.order_id = o.id WHERE o.round_id = r.id AND o.status <> 'waived' AND x.status = 'released') AS released
      FROM annual_checkup_rounds r ORDER BY r.id DESC
  `).all() as RoundSummary[];
}

export type SubjectRow = {
  key: string; kind: "employee" | "external"; label: string; code: string | null; payer: string;
  required: number; recorded: number; verified: number; released: number; hasConclusion: boolean; conclusionReleased: boolean;
  submitted: boolean;                      // the recorder has sent this person's results to the doctor
  returned: boolean;                       // the doctor sent them back to be fixed and nobody has sent them again
};
export type TestRow = { code: string; nameTh: string; required: number; recorded: number; verified: number; released: number };

const externalLabel = (full: string | null, sortNo: number | null, payer: string) => full ?? `รอเพิ่มรายชื่อ คนที่ ${sortNo ?? "?"} (${payer})`;

export function getRoundOverview(actor: AcActor, roundId: number): { round: { id: number; name: string; status: string }; subjects: SubjectRow[]; tests: TestRow[] } {
  const a = requireRecorder(actor);
  const db = getDb();
  const round = db.prepare("SELECT id, name, status FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { id: number; name: string; status: string } | undefined;
  if (!round) throw new AnnualCheckupInvalid("round_not_found");
  const rows = db.prepare(`
    SELECT o.user_id, o.external_id, u.display_name, u.title_prefix, u.employee_code, e.full_name, e.sort_no,
           COALESCE(p.name_th, ep.name_th, 'ไม่ระบุ') AS payer,
           SUM(o.status <> 'waived') AS required,
           SUM(o.status <> 'waived' AND r.id IS NOT NULL) AS recorded,
           SUM(o.status <> 'waived' AND r.status IN ('verified','released')) AS verified,
           SUM(o.status <> 'waived' AND r.status = 'released') AS released,
           MAX(c.id) AS concl_id, MAX(c.released_at) AS concl_released, MAX(sb.id) AS sub_id,
           MAX(EXISTS (SELECT 1 FROM annual_checkup_returns rt WHERE rt.round_id = o.round_id AND rt.resolved_at IS NULL AND ((o.user_id IS NOT NULL AND rt.user_id = o.user_id) OR (o.external_id IS NOT NULL AND rt.external_id = o.external_id)))) AS returned
      FROM annual_checkup_orders o
      LEFT JOIN users u ON u.id = o.user_id LEFT JOIN annual_checkup_externals e ON e.id = o.external_id
      LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
      LEFT JOIN annual_checkup_conclusions c ON c.round_id = o.round_id AND ((o.user_id IS NOT NULL AND c.user_id = o.user_id) OR (o.external_id IS NOT NULL AND c.external_id = o.external_id))
      LEFT JOIN annual_checkup_submissions sb ON sb.round_id = o.round_id AND ((o.user_id IS NOT NULL AND sb.user_id = o.user_id) OR (o.external_id IS NOT NULL AND sb.external_id = o.external_id))
     WHERE o.round_id = ? GROUP BY o.user_id, o.external_id
  `).all(roundId) as Array<{ user_id: number | null; external_id: number | null; display_name: string | null; title_prefix: string | null; employee_code: string | null;
    full_name: string | null; sort_no: number | null; payer: string; required: number; recorded: number; verified: number; released: number; concl_id: number | null; concl_released: string | null; sub_id: number | null; returned: number }>;
  const subjects: SubjectRow[] = rows.map((r) => ({
    key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, kind: (r.user_id != null ? "employee" : "external") as SubjectRow["kind"],
    label: r.user_id != null ? nameWithPrefix(r.title_prefix, r.display_name ?? "") : externalLabel(r.full_name, r.sort_no, r.payer),
    code: r.employee_code, payer: r.payer, required: r.required, recorded: r.recorded, verified: r.verified, released: r.released,
    hasConclusion: r.concl_id != null, conclusionReleased: !!r.concl_released, submitted: r.sub_id != null && !r.returned, returned: !!r.returned
  })).sort((x, y) => (x.kind === y.kind ? x.label.localeCompare(y.label, "th") : x.kind === "employee" ? -1 : 1));
  const tests = db.prepare(`
    SELECT t.code, t.name_th AS nameTh, SUM(o.status <> 'waived') AS required, SUM(o.status <> 'waived' AND r.id IS NOT NULL) AS recorded,
           SUM(o.status <> 'waived' AND r.status IN ('verified','released')) AS verified, SUM(o.status <> 'waived' AND r.status = 'released') AS released
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? GROUP BY t.id ORDER BY t.sort_no
  `).all(roundId) as TestRow[];
  audit(a.id, "round.view", null, roundId, null);
  return { round, subjects, tests };
}

/** Name and payer of one person in a round, for the top of their page. */
export function getSubjectHeader(actor: AcActor, roundId: number, subject: AcSubject): { key: string; kind: "employee" | "external"; label: string; code: string | null; payer: string | null; sex: "M" | "F" | null } {
  requireRecorder(actor);
  const db = getDb();
  if (subject.userId != null) {
    const u = db.prepare("SELECT display_name, title_prefix, employee_code, gender FROM users WHERE id = ?").get(subject.userId) as { display_name: string; title_prefix: string | null; employee_code: string | null; gender: string | null } | undefined;
    if (!u) throw new AnnualCheckupInvalid("subject_not_found");
    const p = db.prepare("SELECT p.name_th FROM annual_checkup_orders o LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id WHERE o.round_id = ? AND o.user_id = ? LIMIT 1").get(roundId, subject.userId) as { name_th: string | null } | undefined;
    return { key: subjectKey(subject), kind: "employee", label: nameWithPrefix(u.title_prefix, u.display_name), code: u.employee_code, payer: p?.name_th ?? null, sex: u.gender === "male" ? "M" : u.gender === "female" ? "F" : null };
  }
  const e = db.prepare("SELECT e.full_name, e.sort_no, e.sex, p.name_th AS payer FROM annual_checkup_externals e JOIN annual_checkup_payers p ON p.id = e.payer_id WHERE e.id = ? AND e.round_id = ?").get(subject.externalId, roundId) as { full_name: string | null; sort_no: number; sex: "M" | "F" | null; payer: string } | undefined;
  if (!e) throw new AnnualCheckupInvalid("subject_not_found");
  return { key: subjectKey(subject), kind: "external", label: externalLabel(e.full_name, e.sort_no, e.payer), code: null, payer: e.payer, sex: e.sex };
}

/** Date of birth of a person in a round (an employee's from users, an outside person's from the round) — for age-banded reference ranges. */
export function getSubjectDob(actor: AcActor, subject: AcSubject): string | null {
  requireRecorder(actor);
  const db = getDb();
  const row = subject.userId != null
    ? db.prepare("SELECT dob FROM users WHERE id = ?").get(subject.userId) as { dob: string | null } | undefined
    : db.prepare("SELECT dob FROM annual_checkup_externals WHERE id = ?").get(subject.externalId) as { dob: string | null } | undefined;
  const d = row?.dob ?? null;
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

export type ItemSheetRow = {
  order_id: number; key: string; label: string; code: string | null; payer: string; sex: "M" | "F" | null; dob: string | null;
  result_status: "draft" | "verified" | "released" | null; value_num: number | null; value_text: string | null; value_json: string | null;
};

/** Everyone in a round who has this test (not waived), with the stored values — for entering one report item for the whole round. */
export function getItemSheetRows(actor: AcActor, roundId: number, testCode: string): ItemSheetRow[] {
  const a = requireRecorder(actor);
  const db = getDb();
  const raw = db.prepare(`
    SELECT o.id AS order_id, o.user_id, o.external_id, u.display_name, u.title_prefix, u.employee_code, u.gender, u.dob AS u_dob, e.full_name, e.sort_no, e.sex AS e_sex, e.dob AS e_dob,
           COALESCE(p.name_th, ep.name_th, 'ไม่ระบุ') AS payer, r.status AS result_status, r.value_num, r.value_text, r.value_json
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
      LEFT JOIN users u ON u.id = o.user_id LEFT JOIN annual_checkup_externals e ON e.id = o.external_id
      LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND t.code = ? AND o.status <> 'waived'
  `).all(roundId, testCode) as Array<Record<string, unknown>>;
  const rows: ItemSheetRow[] = raw.map((r) => {
    const emp = r.user_id != null;
    const d = ((emp ? r.u_dob : r.e_dob) as string | null) ?? null;
    return {
      order_id: r.order_id as number, key: emp ? `u${r.user_id}` : `e${r.external_id}`,
      label: emp ? nameWithPrefix(r.title_prefix as string | null, r.display_name as string) : externalLabel(r.full_name as string | null, r.sort_no as number | null, r.payer as string),
      code: (r.employee_code as string | null) ?? null, payer: r.payer as string,
      sex: emp ? (r.gender === "male" ? "M" : r.gender === "female" ? "F" : null) : ((r.e_sex as "M" | "F" | null) ?? null),
      dob: d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null,
      result_status: (r.result_status as ItemSheetRow["result_status"]) ?? null, value_num: (r.value_num as number | null) ?? null, value_text: (r.value_text as string | null) ?? null, value_json: (r.value_json as string | null) ?? null
    };
  }).sort((x, y) => (x.key[0] === y.key[0] ? x.label.localeCompare(y.label, "th") : x.key[0] === "u" ? -1 : 1));
  audit(a.id, "test.view", null, roundId, null, testCode);
  return rows;
}

/** The stored values of one order's draft/locked result, for merging a single item into it. */
export function getOrderValues(actor: AcActor, orderId: number): { status: "draft" | "verified" | "released" | null; value_num: number | null; value_text: string | null; value_json: string | null } {
  requireRecorder(actor);
  const r = getDb().prepare("SELECT status, value_num, value_text, value_json FROM annual_checkup_results WHERE order_id = ?").get(orderId) as { status: "draft" | "verified" | "released"; value_num: number | null; value_text: string | null; value_json: string | null } | undefined;
  return r ?? { status: null, value_num: null, value_text: null, value_json: null };
}

/** Give a "รอเพิ่มรายชื่อ" place its name (people without an account). */
export function setExternalName(actor: AcActor, externalId: number, d: { fullName: string; sex?: "M" | "F" | null; dob?: string | null }): void {
  const a = requireRecorder(actor);
  const name = clean(d.fullName, 200);
  if (!name) throw new AnnualCheckupInvalid("name_required");
  if (d.sex != null && d.sex !== "M" && d.sex !== "F") throw new AnnualCheckupInvalid("bad_value");
  if (d.dob != null && !/^\d{4}-\d{2}-\d{2}$/.test(d.dob)) throw new AnnualCheckupInvalid("bad_value");
  const db = getDb();
  guard(() => db.transaction(() => {
    const e = db.prepare("SELECT id, round_id FROM annual_checkup_externals WHERE id = ?").get(externalId) as { id: number; round_id: number } | undefined;
    if (!e) throw new AnnualCheckupInvalid("subject_not_found");
    db.prepare("UPDATE annual_checkup_externals SET full_name = ?, is_placeholder = 0, sex = ?, dob = ? WHERE id = ?").run(name, d.sex ?? null, d.dob ?? null, externalId);
    audit(a.id, "external.name", { user_id: null, external_id: externalId }, e.round_id, null);
  })());
}

export type SheetRow = {
  order_id: number; order_status: "ordered" | "waived" | "external_lab"; key: string; label: string; code: string | null; payer: string;
  result_id: number | null; revision: number | null; result_status: "draft" | "verified" | "released" | null;
  value_num: number | null; value_text: string | null; unit: string | null; ref_text: string | null; interpretation: Interpretation | null; has_file: boolean;
};

/** One test across every person in a round, for entering the same test for many people at once. */
export function getTestSheet(actor: AcActor, roundId: number, testCode: string): { test: { code: string; nameTh: string; valueKind: string; unit: string | null }; rows: SheetRow[] } {
  const a = requireRecorder(actor);
  const db = getDb();
  const t = db.prepare("SELECT id, code, name_th, value_kind, unit FROM annual_checkup_tests WHERE code = ?").get(testCode) as { id: number; code: string; name_th: string; value_kind: string; unit: string | null } | undefined;
  if (!t) throw new AnnualCheckupInvalid("test_not_found");
  const raw = db.prepare(`
    SELECT o.id AS order_id, o.status AS order_status, o.user_id, o.external_id, u.display_name, u.title_prefix, u.employee_code, e.full_name, e.sort_no,
           COALESCE(p.name_th, ep.name_th, 'ไม่ระบุ') AS payer,
           r.id AS result_id, r.revision, r.status AS result_status, r.value_num, r.value_text, r.unit, r.ref_text, r.interpretation,
           CASE WHEN r.file_path IS NOT NULL THEN 1 ELSE 0 END AS has_file
      FROM annual_checkup_orders o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN annual_checkup_externals e ON e.id = o.external_id
      LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND o.test_id = ?
  `).all(roundId, t.id) as Array<Record<string, unknown>>;
  const rows: SheetRow[] = raw.map((r) => ({
    order_id: r.order_id as number, order_status: r.order_status as SheetRow["order_status"],
    key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`,
    label: r.user_id != null ? nameWithPrefix(r.title_prefix as string | null, r.display_name as string) : externalLabel(r.full_name as string | null, r.sort_no as number | null, r.payer as string),
    code: (r.employee_code as string | null) ?? null, payer: r.payer as string, result_id: (r.result_id as number | null) ?? null, revision: (r.revision as number | null) ?? null,
    result_status: (r.result_status as SheetRow["result_status"]) ?? null, value_num: (r.value_num as number | null) ?? null, value_text: (r.value_text as string | null) ?? null,
    unit: (r.unit as string | null) ?? null, ref_text: (r.ref_text as string | null) ?? null, interpretation: (r.interpretation as Interpretation | null) ?? null, has_file: !!r.has_file
  })).sort((x, y) => (x.key[0] === y.key[0] ? x.label.localeCompare(y.label, "th") : x.key[0] === "u" ? -1 : 1));
  audit(a.id, "test.view", null, roundId, null, testCode);
  return { test: { code: t.code, nameTh: t.name_th, valueKind: t.value_kind, unit: t.unit }, rows };
}

/** Attach a lab file to a draft result (creating the draft if there is none yet). The server has already stored the file. */
export function attachResultFile(actor: AcActor, orderId: number, f: { filePath: string; fileMime: string }): number {
  const a = requireRecorder(actor);
  if (!clean(f.filePath, 500)) throw new AnnualCheckupInvalid("bad_value");
  const db = getDb();
  return guard(() => db.transaction(() => {
    const o = loadOrder(orderId);
    if (o.status === "waived") throw new AnnualCheckupInvalid("order_waived");
    const cur = db.prepare("SELECT id, status FROM annual_checkup_results WHERE order_id = ?").get(orderId) as { id: number; status: string } | undefined;
    let id: number;
    if (!cur) id = Number(db.prepare("INSERT INTO annual_checkup_results (order_id, file_path, file_mime, recorded_by) VALUES (?,?,?,?)").run(orderId, f.filePath, clean(f.fileMime, 100), a.id).lastInsertRowid);
    else {
      if (cur.status !== "draft") throw new AnnualCheckupInvalid("result_locked");
      id = cur.id;
      db.prepare("UPDATE annual_checkup_results SET file_path = ?, file_mime = ?, recorded_by = ?, recorded_at = CURRENT_TIMESTAMP WHERE id = ?").run(f.filePath, clean(f.fileMime, 100), a.id, id);
    }
    audit(a.id, "result.attach", o, o.round_id, o.id);
    return id;
  })());
}

/** Where a result's file is, for clinical staff (the route streams it). Audited. */
export function getResultFileClinical(actor: AcActor, resultId: number): { path: string; mime: string } | null {
  const a = requireRecorder(actor);
  const r = getDb().prepare("SELECT r.file_path, r.file_mime, o.id AS order_id, o.round_id, o.user_id, o.external_id FROM annual_checkup_results r JOIN annual_checkup_orders o ON o.id = r.order_id WHERE r.id = ?")
    .get(resultId) as { file_path: string | null; file_mime: string | null; order_id: number; round_id: number; user_id: number | null; external_id: number | null } | undefined;
  if (!r || !r.file_path) return null;
  audit(a.id, "file.view", r, r.round_id, r.order_id);
  return { path: r.file_path, mime: r.file_mime ?? "application/octet-stream" };
}

/** The doctor's draft conclusion, so the person page can pre-fill it. */
export const isApproverUser = (userId: number): boolean => isApproverEligible(userId);

// ── queue number + QR check-in (phase 6) ───────────────────────────────────────────────────────────────────────────────
// The queue table holds a place in the line, an appointment time and the arrival stamp — no health data. Who sees what:
//   • employee        → only their own row, and only in an OPEN round; they get their own QR token (nobody else's)
//   • clinic recorder → every row of every round, may look a token up and check people in (live eligibility, audited)
//   • branch manager  → name + queue number + arrived / not yet, only for employees of the branches they administer; never the
//                       tests, the payer or the token
//   • HR / others     → nothing
// Waived tests are never shown to the employee (a waiver can hint at a medical reason).

export type QueueTest = { code: string; name_th: string };
export type StationState = { code: string; name_th: string; passed: boolean; passed_at: string | null; /** the employee's own tick (not official) */ self_marked: boolean };
export type MyQueue = { round_id: number; round_name: string; location: string | null; date: string | null; appt_time: string | null;
  queue_no: number; tests: QueueTest[]; checkin_token: string; checked_in_at: string | null;
  /** After check-in only: the sample-kit number and the stations to visit (with which are done). Empty / null before. */
  kit_no: string | null; stations: StationState[] };

const orderedTests = (roundId: number, col: "user_id" | "external_id", id: number): QueueTest[] =>
  getDb().prepare(`
    SELECT t.code, t.name_th FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
     WHERE o.round_id = ? AND o.${col} = ? AND o.status <> 'waived' ORDER BY t.sort_no
  `).all(roundId, id) as QueueTest[];

/**
 * The stations a person must visit (from their non-waived tests) and which they have passed. Waived tests never create a station.
 * A person with a test that has no station simply has nothing to visit for it.
 */
function stationsFor(queueId: number, roundId: number, col: "user_id" | "external_id", id: number): StationState[] {
  return getDb().prepare(`
    SELECT s.code, s.name_th, CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS passed, p.passed_at,
           CASE WHEN m.station_id IS NOT NULL THEN 1 ELSE 0 END AS self_marked
      FROM annual_checkup_stations s
      LEFT JOIN annual_checkup_station_passes p ON p.station_id = s.id AND p.queue_id = ?
      LEFT JOIN annual_checkup_station_selfmarks m ON m.station_id = s.id AND m.queue_id = ?
     WHERE s.active = 1 AND EXISTS (
       SELECT 1 FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
        WHERE o.round_id = ? AND o.${col} = ? AND o.status <> 'waived' AND t.station_id = s.id)
     ORDER BY s.sort_no, s.id
  `).all(queueId, queueId, roundId, id).map((r) => { const x = r as { code: string; name_th: string; passed: number; passed_at: string | null; self_marked: number }; return { code: x.code, name_th: x.name_th, passed: x.passed === 1, passed_at: x.passed_at, self_marked: x.self_marked === 1 }; });
}

/** The signed-in employee's own place in line for each open round. The token returned is theirs alone. */
export function getMyQueue(actor: AcActor): MyQueue[] {
  const a = loadActor(actor);
  const rows = getDb().prepare(`
    SELECT q.id AS queue_id, r.id AS round_id, r.name AS round_name, r.location, r.start_date AS date, COALESCE(q.appt_time, r.appt_time) AS appt_time,
           q.queue_no, q.checkin_token, q.checked_in_at, q.kit_no
      FROM annual_checkup_queue q JOIN annual_checkup_rounds r ON r.id = q.round_id
     WHERE q.user_id = ? AND r.status = 'open' ORDER BY r.id DESC
  `).all(a.id) as Array<Omit<MyQueue, "tests" | "stations"> & { queue_id: number }>;
  return rows.map(({ queue_id, ...r }) => ({
    ...r, tests: orderedTests(r.round_id, "user_id", a.id),
    // the route and the kit number are shown only once clinic staff have scanned the person in
    kit_no: r.checked_in_at ? r.kit_no : null,
    stations: r.checked_in_at ? stationsFor(queue_id, r.round_id, "user_id", a.id) : []
  }));
}

/**
 * The employee ticks / unticks "I have been through this station" on their OWN queue entry. Only for someone already checked in, only for a
 * station on their own route, and only while the round is open. Never touches the clinic's official passes. Idempotent.
 */
export function setMyStationMark(actor: AcActor, roundId: number, stationCode: string, marked: boolean): void {
  const a = loadActor(actor);
  const q = getDb().prepare(`
    SELECT q.id, q.checked_in_at FROM annual_checkup_queue q JOIN annual_checkup_rounds r ON r.id = q.round_id
     WHERE q.user_id = ? AND q.round_id = ? AND r.status = 'open'
  `).get(a.id, roundId) as { id: number; checked_in_at: string | null } | undefined;
  if (!q) throw new AnnualCheckupInvalid("queue_not_found");
  if (!q.checked_in_at) throw new AnnualCheckupInvalid("not_checked_in");
  const st = stationsFor(q.id, roundId, "user_id", a.id).find((x) => x.code === stationCode);
  if (!st) throw new AnnualCheckupInvalid("station_not_needed");
  const stationId = (getDb().prepare("SELECT id FROM annual_checkup_stations WHERE code = ?").get(stationCode) as { id: number }).id;
  if (marked) getDb().prepare("INSERT OR IGNORE INTO annual_checkup_station_selfmarks (queue_id, station_id) VALUES (?, ?)").run(q.id, stationId);
  else getDb().prepare("DELETE FROM annual_checkup_station_selfmarks WHERE queue_id = ? AND station_id = ?").run(q.id, stationId);
}

/**
 * The employee checks themselves in (owner 2026-11-21), after scanning the registration poster: their own queue row of an OPEN round only.
 * Idempotent. The sample-kit number, station passes and results stay with clinic staff. The database allows this one write only on the
 * person's own row (see annual_checkup_queue_upd).
 */
export function selfCheckIn(actor: AcActor, roundId: number): { already: boolean } {
  const a = loadActor(actor);
  const q = getDb().prepare(`
    SELECT q.id, q.checked_in_at FROM annual_checkup_queue q JOIN annual_checkup_rounds r ON r.id = q.round_id
     WHERE q.user_id = ? AND q.round_id = ? AND r.status = 'open'
  `).get(a.id, roundId) as { id: number; checked_in_at: string | null } | undefined;
  if (!q) throw new AnnualCheckupInvalid("queue_not_found");
  if (q.checked_in_at) return { already: true };
  guard(() => getDb().transaction(() => {
    getDb().prepare("UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND checked_in_at IS NULL").run(a.id, q.id);
    audit(a.id, "queue.selfcheckin", { user_id: a.id, external_id: null }, roundId, null);
  })());
  return { already: false };
}

/**
 * The employee records their OWN pass of a station (owner 2026-11-21): they scan the station's QR and confirm, so staff are not made to scan every
 * person at every station. Only after check-in, only for a station on their own route, only in an open round; idempotent; official like a
 * staff scan (append-only), audited as queue.station.self. Nothing can be undone from here.
 */
export function selfPassStation(actor: AcActor, roundId: number, stationCode: string): { already: boolean } {
  const a = loadActor(actor);
  const q = getDb().prepare(`
    SELECT q.id, q.checked_in_at FROM annual_checkup_queue q JOIN annual_checkup_rounds r ON r.id = q.round_id
     WHERE q.user_id = ? AND q.round_id = ? AND r.status = 'open'
  `).get(a.id, roundId) as { id: number; checked_in_at: string | null } | undefined;
  if (!q) throw new AnnualCheckupInvalid("queue_not_found");
  if (!q.checked_in_at) throw new AnnualCheckupInvalid("not_checked_in");
  const st = stationsFor(q.id, roundId, "user_id", a.id).find((x) => x.code === stationCode);
  if (!st) throw new AnnualCheckupInvalid("station_not_needed");
  if (st.passed) return { already: true };
  const stationId = (getDb().prepare("SELECT id FROM annual_checkup_stations WHERE code = ?").get(stationCode) as { id: number }).id;
  guard(() => getDb().transaction(() => {
    getDb().prepare("INSERT OR IGNORE INTO annual_checkup_station_passes (queue_id, station_id, passed_by) VALUES (?, ?, ?)").run(q.id, stationId, a.id);
    audit(a.id, "queue.station.self", { user_id: a.id, external_id: null }, roundId, null, stationCode);
  })());
  return { already: false };
}

export type QueueScan = { queue_id: number; round_id: number; round_name: string; /** subject key for the person page: u<userId> / e<externalId> */ key: string; kind: "employee" | "external"; label: string; code: string | null;
  payer: string | null; queue_no: number; appt_time: string | null; tests: QueueTest[]; checked_in_at: string | null; checked_in_by: string | null;
  kit_no: string | null; stations: StationState[] };

function loadQueueScan(where: string, arg: string | number): QueueScan | null {
  const q = getDb().prepare(`
    SELECT q.id AS queue_id, q.round_id, r.name AS round_name, q.user_id, q.external_id, q.queue_no, COALESCE(q.appt_time, r.appt_time) AS appt_time, q.kit_no,
           q.checked_in_at, ci.display_name AS ci_name, ci.title_prefix AS ci_prefix,
           u.display_name, u.title_prefix, u.employee_code, e.full_name, e.sort_no, ep.name_th AS ext_payer
      FROM annual_checkup_queue q JOIN annual_checkup_rounds r ON r.id = q.round_id
      LEFT JOIN users u ON u.id = q.user_id LEFT JOIN annual_checkup_externals e ON e.id = q.external_id
      LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id LEFT JOIN users ci ON ci.id = q.checked_in_by
     WHERE ${where}
  `).get(arg) as { queue_id: number; round_id: number; round_name: string; user_id: number | null; external_id: number | null; queue_no: number; appt_time: string | null; kit_no: string | null;
    checked_in_at: string | null; ci_name: string | null; ci_prefix: string | null; display_name: string | null; title_prefix: string | null; employee_code: string | null;
    full_name: string | null; sort_no: number | null; ext_payer: string | null } | undefined;
  if (!q) return null;
  const isUser = q.user_id != null;
  const payer = isUser
    ? ((getDb().prepare("SELECT p.name_th FROM annual_checkup_orders o LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id WHERE o.round_id = ? AND o.user_id = ? AND p.id IS NOT NULL LIMIT 1").get(q.round_id, q.user_id) as { name_th: string } | undefined)?.name_th ?? null)
    : q.ext_payer;
  return {
    queue_id: q.queue_id, round_id: q.round_id, round_name: q.round_name, key: isUser ? `u${q.user_id}` : `e${q.external_id}`, kind: isUser ? "employee" : "external",
    label: isUser ? nameWithPrefix(q.title_prefix, q.display_name ?? "") : externalLabel(q.full_name, q.sort_no ?? 0, q.ext_payer ?? ""),
    code: q.employee_code, payer, queue_no: q.queue_no, appt_time: q.appt_time,
    tests: orderedTests(q.round_id, isUser ? "user_id" : "external_id", (isUser ? q.user_id : q.external_id) as number),
    checked_in_at: q.checked_in_at, checked_in_by: q.ci_name ? nameWithPrefix(q.ci_prefix, q.ci_name) : null,
    kit_no: q.kit_no, stations: stationsFor(q.queue_id, q.round_id, isUser ? "user_id" : "external_id", (isUser ? q.user_id : q.external_id) as number)
  };
}

/** Clinic staff scan a QR: the token → who it is, their number and tests. null for an unknown token (nothing is revealed about why). */
export function lookupQueueByToken(actor: AcActor, token: string): QueueScan | null {
  const a = requireRecorder(actor);
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const s = loadQueueScan("q.checkin_token = ?", token);
  if (!s) return null;
  audit(a.id, "queue.scan", s.kind === "employee" ? { user_id: userOfQueue(s.queue_id), external_id: null } : { user_id: null, external_id: externalOfQueue(s.queue_id) }, s.round_id, null);
  return s;
}
const userOfQueue = (qid: number): number | null => (getDb().prepare("SELECT user_id FROM annual_checkup_queue WHERE id = ?").get(qid) as { user_id: number | null } | undefined)?.user_id ?? null;
const externalOfQueue = (qid: number): number | null => (getDb().prepare("SELECT external_id FROM annual_checkup_queue WHERE id = ?").get(qid) as { external_id: number | null } | undefined)?.external_id ?? null;

const KIT_RE = /^[A-Za-z0-9._-]{1,30}$/;
/** A kit number as the barcode / the staff typed it: trimmed, letters digits . _ - only, up to 30. */
function cleanKit(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const k = v.trim();
  if (!KIT_RE.test(k)) throw new AnnualCheckupInvalid("bad_kit_no");
  return k;
}
/** A kit number belongs to one person per round. */
function assertKitFree(roundId: number, kit: string, exceptQueueId: number): void {
  const other = getDb().prepare("SELECT queue_no FROM annual_checkup_queue WHERE round_id = ? AND kit_no = ? AND id <> ?").get(roundId, kit, exceptQueueId) as { queue_no: number } | undefined;
  if (other) throw new AnnualCheckupInvalid("kit_no_taken", `ชุดนี้ถูกใช้กับลำดับที่ ${other.queue_no} แล้ว`);
}

/**
 * Check a person in (by scanned token, or by the row's id from the roster — the way people without an account are checked in), and link the
 * sample-kit number the staff scanned / typed. Idempotent: a second scan changes nothing and says who checked them in and when (it only fills in a
 * kit number that was still missing). The trigger refuses anyone but a live eligible recorder.
 */
export function checkIn(actor: AcActor, ref: { token: string } | { queueId: number }, opts: { kitNo?: string | null } = {}): { already: boolean; scan: QueueScan } {
  const a = requireRecorder(actor);
  const scan = "token" in ref
    ? (typeof ref.token === "string" && /^[0-9a-f]{32}$/.test(ref.token) ? loadQueueScan("q.checkin_token = ?", ref.token) : null)
    : loadQueueScan("q.id = ?", ref.queueId);
  if (!scan) throw new AnnualCheckupInvalid("queue_not_found");
  const kit = cleanKit(opts.kitNo);
  if (kit) assertKitFree(scan.round_id, kit, scan.queue_id);
  if (scan.checked_in_at) {
    if (kit && !scan.kit_no) { setKitNoInner(a.id, scan, kit); return { already: true, scan: loadQueueScan("q.id = ?", scan.queue_id) as QueueScan }; }
    return { already: true, scan };
  }
  const subj = scan.kind === "employee" ? { user_id: userOfQueue(scan.queue_id), external_id: null } : { user_id: null, external_id: externalOfQueue(scan.queue_id) };
  guard(() => getDb().transaction(() => {
    getDb().prepare(`UPDATE annual_checkup_queue SET checked_in_at = CURRENT_TIMESTAMP, checked_in_by = @by, updated_at = CURRENT_TIMESTAMP,
                       kit_no = COALESCE(@kit, kit_no), kit_set_by = CASE WHEN @kit IS NULL THEN kit_set_by ELSE @by END, kit_set_at = CASE WHEN @kit IS NULL THEN kit_set_at ELSE CURRENT_TIMESTAMP END
                      WHERE id = @id AND checked_in_at IS NULL`).run({ by: a.id, kit, id: scan.queue_id });
    audit(a.id, "queue.checkin", subj, scan.round_id, null, kit ? `kit ${kit}` : undefined);
  })());
  return { already: false, scan: loadQueueScan("q.id = ?", scan.queue_id) as QueueScan };
}

function setKitNoInner(actorId: number, scan: QueueScan, kit: string): void {
  const subj = scan.kind === "employee" ? { user_id: userOfQueue(scan.queue_id), external_id: null } : { user_id: null, external_id: externalOfQueue(scan.queue_id) };
  guard(() => getDb().transaction(() => {
    getDb().prepare("UPDATE annual_checkup_queue SET kit_no = ?, kit_set_by = ?, kit_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(kit, actorId, scan.queue_id);
    audit(actorId, "queue.kit", subj, scan.round_id, null, `kit ${kit}`);
  })());
}

/** Correct a person's sample-kit number (clinic recorders). */
export function setKitNo(actor: AcActor, queueId: number, kitNo: string): QueueScan {
  const a = requireRecorder(actor);
  const scan = loadQueueScan("q.id = ?", queueId);
  if (!scan) throw new AnnualCheckupInvalid("queue_not_found");
  const kit = cleanKit(kitNo);
  if (!kit) throw new AnnualCheckupInvalid("bad_kit_no");
  assertKitFree(scan.round_id, kit, scan.queue_id);
  setKitNoInner(a.id, scan, kit);
  return loadQueueScan("q.id = ?", queueId) as QueueScan;
}

/**
 * Mark a station passed (staff at the station scan the QR). Only for someone already checked in, and only for a station on their route
 * (a station of one of their non-waived tests). Idempotent. Clinic recorders only (gateway and trigger).
 */
export function passStation(actor: AcActor, ref: { token: string } | { queueId: number }, stationCode: string): { already: boolean; scan: QueueScan } {
  const a = requireRecorder(actor);
  const scan = "token" in ref
    ? (typeof ref.token === "string" && /^[0-9a-f]{32}$/.test(ref.token) ? loadQueueScan("q.checkin_token = ?", ref.token) : null)
    : loadQueueScan("q.id = ?", ref.queueId);
  if (!scan) throw new AnnualCheckupInvalid("queue_not_found");
  if (!scan.checked_in_at) throw new AnnualCheckupInvalid("not_checked_in");
  const st = scan.stations.find((x) => x.code === stationCode);
  if (!st) throw new AnnualCheckupInvalid("station_not_needed");
  if (st.passed) return { already: true, scan };
  const stationId = (getDb().prepare("SELECT id FROM annual_checkup_stations WHERE code = ?").get(stationCode) as { id: number }).id;
  const subj = scan.kind === "employee" ? { user_id: userOfQueue(scan.queue_id), external_id: null } : { user_id: null, external_id: externalOfQueue(scan.queue_id) };
  guard(() => getDb().transaction(() => {
    getDb().prepare("INSERT OR IGNORE INTO annual_checkup_station_passes (queue_id, station_id, passed_by) VALUES (?, ?, ?)").run(scan.queue_id, stationId, a.id);
    audit(a.id, "queue.station", subj, scan.round_id, null, stationCode);
  })());
  return { already: false, scan: loadQueueScan("q.id = ?", scan.queue_id) as QueueScan };
}

export type QueueRosterRow = { queue_id: number; key: string; kind: "employee" | "external"; label: string; code: string | null; payer: string | null;
  queue_no: number; appt_time: string | null; checked_in_at: string | null; checked_in_by: string | null;
  kit_no: string | null; stations_done: number; stations_total: number };

/** The whole round's roster in queue order, for the clinic. */
export function listQueue(actor: AcActor, roundId: number): QueueRosterRow[] {
  const a = requireRecorder(actor);
  const ids = getDb().prepare("SELECT id, user_id, external_id FROM annual_checkup_queue WHERE round_id = ? ORDER BY queue_no").all(roundId) as Array<{ id: number; user_id: number | null; external_id: number | null }>;
  const out = ids.map((r) => {
    const s = loadQueueScan("q.id = ?", r.id) as QueueScan;
    return { queue_id: s.queue_id, key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, kind: s.kind, label: s.label, code: s.code, payer: s.payer,
      queue_no: s.queue_no, appt_time: s.appt_time, checked_in_at: s.checked_in_at, checked_in_by: s.checked_in_by,
      kit_no: s.kit_no, stations_done: s.stations.filter((x) => x.passed).length, stations_total: s.stations.length };
  });
  audit(a.id, "queue.list", null, roundId, null);
  return out;
}

/** A branch manager's view: only employees of the branches they administer; name, number and arrived-or-not, nothing else. */
export function listQueueForManager(actor: AcActor, roundId: number): Array<{ label: string; queue_no: number; arrived: boolean }> {
  const a = loadActor(actor);
  if (a.role !== "admin") throw new AnnualCheckupForbidden("not_allowed");
  const rows = getDb().prepare(`
    SELECT DISTINCT q.queue_no, q.checked_in_at, u.display_name, u.title_prefix
      FROM annual_checkup_queue q JOIN users u ON u.id = q.user_id
      JOIN user_branches ub ON ub.user_id = q.user_id
      JOIN user_branches mine ON mine.branch_id = ub.branch_id AND mine.user_id = ? AND mine.is_admin = 1
     WHERE q.round_id = ? AND u.status NOT IN ('disabled', 'resigned', 'terminated') ORDER BY q.queue_no
  `).all(a.id, roundId) as Array<{ queue_no: number; checked_in_at: string | null; display_name: string; title_prefix: string | null }>;
  return rows.map((r) => ({ label: nameWithPrefix(r.title_prefix, r.display_name), queue_no: r.queue_no, arrived: !!r.checked_in_at }));
}

/**
 * Open or close a round (owner / clinic recorder). Employees see their queue number and QR only while the round is "open"; an imported round
 * starts as "draft". Never moves a round back to draft once people have checked in (that would hide a live day).
 */
export function setRoundStatus(actor: AcActor, roundId: number, status: "open" | "closed" | "draft"): { changed: boolean } {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  const db = getDb();
  const r = db.prepare("SELECT status FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { status: string } | undefined;
  if (!r) throw new AnnualCheckupInvalid("round_not_found");
  if (r.status === status) return { changed: false };
  if (status === "draft" && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_queue WHERE round_id = ? AND checked_in_at IS NOT NULL").get(roundId) as { n: number }).n > 0)
    throw new AnnualCheckupInvalid("round_has_checkins", "มีคนเช็กอินในรอบนี้แล้ว จึงเปลี่ยนกลับเป็นร่างไม่ได้");
  db.prepare("UPDATE annual_checkup_rounds SET status = ? WHERE id = ?").run(status, roundId);
  audit(a.id, "round.status", { user_id: null, external_id: null }, roundId, null, status);
  return { changed: true };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export type RoundInfo = { name: string; yearBe: number | null; startDate: string | null; endDate: string | null; location: string | null };

/** Edit a round's name, year, dates and place (owner / clinic recorder). Never touches people, orders or results. */
export function updateRoundInfo(actor: AcActor, roundId: number, info: RoundInfo): void {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  const name = clean(info.name, 120);
  if (!name) throw new AnnualCheckupInvalid("bad_value", "กรุณาตั้งชื่อรอบ");
  if (info.yearBe != null && (!Number.isInteger(info.yearBe) || info.yearBe < 2500 || info.yearBe > 2700)) throw new AnnualCheckupInvalid("bad_value", "ปี พ.ศ. ไม่ถูกต้อง");
  for (const d of [info.startDate, info.endDate]) if (d && !ISO_DATE.test(d)) throw new AnnualCheckupInvalid("bad_value", "วันที่ไม่ถูกต้อง");
  if (info.startDate && info.endDate && info.endDate < info.startDate) throw new AnnualCheckupInvalid("bad_value", "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม");
  const r = getDb().prepare("UPDATE annual_checkup_rounds SET name = ?, year_be = ?, start_date = ?, end_date = ?, location = ? WHERE id = ?")
    .run(name, info.yearBe, info.startDate || null, info.endDate || null, clean(info.location, 200), roundId);
  if (r.changes === 0) throw new AnnualCheckupInvalid("round_not_found");
  audit(a.id, "round.update", null, roundId, null, name);
}

/**
 * Delete a round that was imported by mistake (owner / clinic recorder). Only a round that holds no health data and has nobody checked in:
 * no results, clinical notes, conclusions or sent-to-doctor records, and no queue row with a check-in (those are protected by the database).
 * It must not be open. Removes the people, orders, queue numbers, payers and programmes of that round. The audit trail is kept.
 */
export function deleteRound(actor: AcActor, roundId: number, confirmName: string): { people: number } {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  const db = getDb();
  const r = db.prepare("SELECT name, status FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { name: string; status: string } | undefined;
  if (!r) throw new AnnualCheckupInvalid("round_not_found");
  if (typeof confirmName !== "string" || confirmName.trim() !== r.name.trim()) throw new AnnualCheckupInvalid("bad_value", "ชื่อรอบที่พิมพ์ยืนยันไม่ตรง");
  if (r.status === "open") throw new AnnualCheckupInvalid("round_is_open", "ต้องปิดรอบก่อนจึงลบได้");
  const n = (sql: string) => (db.prepare(sql).get(roundId) as { n: number }).n;
  if (n("SELECT COUNT(*) n FROM annual_checkup_queue WHERE round_id = ? AND checked_in_at IS NOT NULL") > 0) throw new AnnualCheckupInvalid("round_has_checkins", "มีคนเช็กอินในรอบนี้แล้ว จึงลบไม่ได้ (ใช้ปิดรอบแทน)");
  if (n("SELECT COUNT(*) n FROM annual_checkup_results res JOIN annual_checkup_orders o ON o.id = res.order_id WHERE o.round_id = ?") > 0
    || n("SELECT COUNT(*) n FROM annual_checkup_order_clinical c JOIN annual_checkup_orders o ON o.id = c.order_id WHERE o.round_id = ?") > 0
    || n("SELECT COUNT(*) n FROM annual_checkup_conclusions WHERE round_id = ?") > 0
    || n("SELECT COUNT(*) n FROM annual_checkup_submissions WHERE round_id = ?") > 0)
    throw new AnnualCheckupInvalid("round_has_data", "รอบนี้มีผลตรวจหรือข้อมูลคลินิกแล้ว จึงลบไม่ได้ (ใช้ปิดรอบแทน)");
  const people = n("SELECT COUNT(DISTINCT COALESCE(user_id, -external_id)) n FROM annual_checkup_orders WHERE round_id = ?");
  guard(() => db.transaction(() => {
    db.prepare("DELETE FROM annual_checkup_station_selfmarks WHERE queue_id IN (SELECT id FROM annual_checkup_queue WHERE round_id = ?)").run(roundId);
    db.prepare("DELETE FROM annual_checkup_queue WHERE round_id = ?").run(roundId);
    db.prepare("DELETE FROM annual_checkup_orders WHERE round_id = ?").run(roundId);
    db.prepare("DELETE FROM annual_checkup_program_tests WHERE program_id IN (SELECT id FROM annual_checkup_programs WHERE round_id = ?)").run(roundId);
    db.prepare("DELETE FROM annual_checkup_programs WHERE round_id = ?").run(roundId);
    db.prepare("DELETE FROM annual_checkup_externals WHERE round_id = ?").run(roundId);
    db.prepare("DELETE FROM annual_checkup_payers WHERE round_id = ?").run(roundId);
    db.prepare("DELETE FROM annual_checkup_rounds WHERE id = ?").run(roundId);
    audit(a.id, "round.delete", null, roundId, null, r.name);
  })());
  return { people };
}

/** Importer / admin: place a person in the line (add, or change their number / appointment time). The owner or a clinic recorder only. */
export function upsertQueueRow(actor: AcActor, roundId: number, subject: AcSubject, queueNo: number, apptTime?: string | null): { id: number; action: "added" | "changed" | "same" } {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  if (!Number.isInteger(queueNo) || queueNo <= 0) throw new AnnualCheckupInvalid("bad_queue_no");
  if (apptTime != null && apptTime !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(apptTime)) throw new AnnualCheckupInvalid("bad_value");
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM annual_checkup_rounds WHERE id = ?").get(roundId)) throw new AnnualCheckupInvalid("round_not_found");
  const col = subject.userId != null ? "user_id" : "external_id";
  const sid = (subject.userId ?? subject.externalId) as number;
  const taken = db.prepare("SELECT id, user_id, external_id FROM annual_checkup_queue WHERE round_id = ? AND queue_no = ?").get(roundId, queueNo) as { id: number; user_id: number | null; external_id: number | null } | undefined;
  const mine = db.prepare(`SELECT id, queue_no, appt_time FROM annual_checkup_queue WHERE round_id = ? AND ${col} = ?`).get(roundId, sid) as { id: number; queue_no: number; appt_time: string | null } | undefined;
  if (taken && taken.id !== mine?.id) throw new AnnualCheckupInvalid("queue_no_taken");
  const appt = apptTime ? apptTime : null;
  return guard(() => db.transaction(() => {
    if (!mine) {
      const id = Number(db.prepare(`INSERT INTO annual_checkup_queue (round_id, ${col}, queue_no, appt_time) VALUES (?, ?, ?, ?)`).run(roundId, sid, queueNo, appt).lastInsertRowid);
      audit(a.id, "queue.add", subjectCols(subject), roundId, null, `no ${queueNo}`);
      return { id, action: "added" as const };
    }
    if (mine.queue_no === queueNo && (apptTime === undefined || mine.appt_time === appt)) return { id: mine.id, action: "same" as const };
    db.prepare("UPDATE annual_checkup_queue SET queue_no = ?, appt_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(queueNo, apptTime === undefined ? mine.appt_time : appt, mine.id);
    audit(a.id, "queue.change", subjectCols(subject), roundId, null, `no ${mine.queue_no} -> ${queueNo}`);
    return { id: mine.id, action: "changed" as const };
  })());
}

/** Importer: who is already in the line (numbers and names only), so a plan can say add / change / same / clash. */
export function listQueueForImport(roundId: number): Array<{ user_id: number | null; ext_payer: string | null; ext_sort: number | null; label: string; queue_no: number; checked_in: boolean }> {
  return (getDb().prepare(`
    SELECT q.user_id, ep.name_th AS ext_payer, e.sort_no AS ext_sort, q.queue_no, q.checked_in_at, u.display_name, u.title_prefix, e.full_name
      FROM annual_checkup_queue q LEFT JOIN users u ON u.id = q.user_id LEFT JOIN annual_checkup_externals e ON e.id = q.external_id
      LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id WHERE q.round_id = ?
  `).all(roundId) as Array<{ user_id: number | null; ext_payer: string | null; ext_sort: number | null; queue_no: number; checked_in_at: string | null; display_name: string | null; title_prefix: string | null; full_name: string | null }>)
    .map((r) => ({ user_id: r.user_id, ext_payer: r.ext_payer, ext_sort: r.ext_sort, queue_no: r.queue_no, checked_in: !!r.checked_in_at,
      label: r.user_id != null ? nameWithPrefix(r.title_prefix, r.display_name ?? "") : externalLabel(r.full_name, r.ext_sort, r.ext_payer ?? "") }));
}

/**
 * Importer: set many people's numbers at once. All-or-nothing and swap-safe (a person moving to a number another person is leaving works):
 * rows that change are first parked above the range, then given their new numbers. Refused if two items want the same number or a number is
 * held by someone who is not part of this batch. The owner or a clinic recorder only.
 */
export function applyQueuePlan(actor: AcActor, roundId: number, items: Array<{ subject: AcSubject; queueNo: number }>): { added: number; changed: number; same: number } {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  const db = getDb();
  const wantedNos = new Set<number>();
  for (const it of items) {
    if (!Number.isInteger(it.queueNo) || it.queueNo <= 0 || it.queueNo >= 1_000_000) throw new AnnualCheckupInvalid("bad_queue_no");
    if (wantedNos.has(it.queueNo)) throw new AnnualCheckupInvalid("queue_no_taken");
    wantedNos.add(it.queueNo);
  }
  return guard(() => db.transaction(() => {
    const col = (s: AcSubject) => (s.userId != null ? "user_id" : "external_id");
    const sid = (s: AcSubject) => (s.userId ?? s.externalId) as number;
    const mineOf = (s: AcSubject) => db.prepare(`SELECT id, queue_no FROM annual_checkup_queue WHERE round_id = ? AND ${col(s)} = ?`).get(roundId, sid(s)) as { id: number; queue_no: number } | undefined;
    const batchIds = new Set<number>();
    for (const it of items) { const m = mineOf(it.subject); if (m) batchIds.add(m.id); }
    for (const it of items) {
      const holder = db.prepare("SELECT id FROM annual_checkup_queue WHERE round_id = ? AND queue_no = ?").get(roundId, it.queueNo) as { id: number } | undefined;
      if (holder && !batchIds.has(holder.id)) throw new AnnualCheckupInvalid("queue_no_taken");
    }
    let added = 0, changed = 0, same = 0;
    const toSet: Array<{ id: number; no: number; subject: AcSubject }> = [];
    for (const it of items) {
      const m = mineOf(it.subject);
      if (!m) { toSet.push({ id: -1, no: it.queueNo, subject: it.subject }); continue; }
      if (m.queue_no === it.queueNo) { same++; continue; }
      db.prepare("UPDATE annual_checkup_queue SET queue_no = queue_no + 1000000, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
      toSet.push({ id: m.id, no: it.queueNo, subject: it.subject });
    }
    for (const t of toSet) {
      if (t.id < 0) {
        db.prepare(`INSERT INTO annual_checkup_queue (round_id, ${col(t.subject)}, queue_no) VALUES (?, ?, ?)`).run(roundId, sid(t.subject), t.no);
        audit(a.id, "queue.add", subjectCols(t.subject), roundId, null, `no ${t.no}`); added++;
      } else {
        db.prepare("UPDATE annual_checkup_queue SET queue_no = ? WHERE id = ?").run(t.no, t.id);
        audit(a.id, "queue.change", subjectCols(t.subject), roundId, null, `-> ${t.no}`); changed++;
      }
    }
    return { added, changed, same };
  })());
}

/** The owner's / a recorder's list for editing numbers and times (no check-in controls, no tests). */
export function listQueueForAdmin(actor: AcActor, roundId: number): QueueRosterRow[] {
  const a = loadActor(actor);
  if (!(a.role === "super_admin" || isRecorderEligible(a.id))) throw new AnnualCheckupForbidden("not_allowed");
  const ids = getDb().prepare("SELECT id, user_id, external_id FROM annual_checkup_queue WHERE round_id = ? ORDER BY queue_no").all(roundId) as Array<{ id: number; user_id: number | null; external_id: number | null }>;
  return ids.map((r) => {
    const s = loadQueueScan("q.id = ?", r.id) as QueueScan;
    return { queue_id: s.queue_id, key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, kind: s.kind, label: s.label, code: s.code, payer: s.payer,
      queue_no: s.queue_no, appt_time: s.appt_time, checked_in_at: s.checked_in_at, checked_in_by: s.checked_in_by,
      kit_no: s.kit_no, stations_done: s.stations.filter((x) => x.passed).length, stations_total: s.stations.length };
  });
}

// ── sending results to the doctor (phase 7) ────────────────────────────────────────────────────────────────────────────

/**
 * The recorder hands a person's results to the doctor once EVERY test that is not waived has at least a draft result. Can be repeated (after a
 * correction) — the time is refreshed. Nothing here changes a result.
 */
export function submitToDoctor(actor: AcActor, roundId: number, subject: AcSubject): { submitted_at: string; awaiting: number } {
  const a = requireRecorder(actor);
  const db = getDb();
  const col = subject.userId != null ? "user_id" : "external_id";
  const ocol = subject.userId != null ? "o.user_id" : "o.external_id";
  const id = (subject.userId ?? subject.externalId) as number;
  const missing = db.prepare(`
    SELECT COUNT(*) n FROM annual_checkup_orders o LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND ${ocol} = ? AND o.status <> 'waived' AND r.id IS NULL
  `).get(roundId, id) as { n: number };
  const total = db.prepare(`SELECT COUNT(*) n FROM annual_checkup_orders o WHERE o.round_id = ? AND ${ocol} = ? AND o.status <> 'waived'`).get(roundId, id) as { n: number };
  if (total.n === 0) throw new AnnualCheckupInvalid("subject_not_found");
  if (missing.n > 0) throw new AnnualCheckupInvalid("not_all_recorded");
  guard(() => db.transaction(() => {
    const have = db.prepare(`SELECT id FROM annual_checkup_submissions WHERE round_id = ? AND ${col} = ?`).get(roundId, id) as { id: number } | undefined;
    if (have) db.prepare("UPDATE annual_checkup_submissions SET submitted_by = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.id, have.id);
    else db.prepare(`INSERT INTO annual_checkup_submissions (round_id, ${col}, submitted_by) VALUES (?, ?, ?)`).run(roundId, id, a.id);
    db.prepare(`UPDATE annual_checkup_returns SET resolved_at = CURRENT_TIMESTAMP WHERE round_id = ? AND ${col} = ? AND resolved_at IS NULL`).run(roundId, id);
    audit(a.id, "result.submit", subjectCols(subject), roundId, null);
  })());
  const at = (db.prepare(`SELECT submitted_at FROM annual_checkup_submissions WHERE round_id = ? AND ${col} = ?`).get(roundId, id) as { submitted_at: string }).submitted_at;
  return { submitted_at: at, awaiting: countAwaitingDoctor(roundId) };
}

/** How many people the doctor still has to look at: sent by a recorder and at least one required result still a draft. A count, nothing else. */
export function countAwaitingDoctor(roundId: number): number {
  return (getDb().prepare(`
    SELECT COUNT(*) n FROM annual_checkup_submissions sb
     WHERE sb.round_id = ?
       AND NOT EXISTS (SELECT 1 FROM annual_checkup_returns rt WHERE rt.round_id = sb.round_id AND rt.resolved_at IS NULL
                         AND ((sb.user_id IS NOT NULL AND rt.user_id = sb.user_id) OR (sb.external_id IS NOT NULL AND rt.external_id = sb.external_id)))
       AND EXISTS (
       SELECT 1 FROM annual_checkup_orders o JOIN annual_checkup_results r ON r.order_id = o.id
        WHERE o.round_id = sb.round_id AND o.status <> 'waived' AND r.status = 'draft'
          AND ((sb.user_id IS NOT NULL AND o.user_id = sb.user_id) OR (sb.external_id IS NOT NULL AND o.external_id = sb.external_id)))
  `).get(roundId) as { n: number }).n;
}

/** System job: the LINE ids of the doctors who may approve (live eligibility), for the "results are waiting" notice. */
export function listApproverLineIds(): string[] {
  return (getDb().prepare(`
    SELECT u.line_user_id FROM users u
     WHERE u.line_user_id IS NOT NULL AND u.line_user_id <> '' AND ${approverOk("u.id")}
  `).all() as Array<{ line_user_id: string }>).map((r) => r.line_user_id);
}


// ── the doctor's wording, sending back, releasing a whole company (health report PR 4) ─────────────────────────────────

export type SectionNote = { section: string; summary_text: string | null; recommendation_text: string | null };

/** The doctor's per-section wording for one person (recorders and doctors read it; the person reads it only after release, through getMySectionNotes). */
export function getSectionNotes(actor: AcActor, roundId: number, subject: AcSubject): SectionNote[] {
  requireRecorder(actor);
  const ccol = subject.userId != null ? "user_id" : "external_id";
  return getDb().prepare(`SELECT section, summary_text, recommendation_text FROM annual_checkup_section_notes WHERE round_id = ? AND ${ccol} = ?`)
    .all(roundId, subject.userId ?? subject.externalId) as SectionNote[];
}

/** Write one section's wording ("overall" = the closing summary). Doctors only. Editing after release records a notice so the person is told. */
export function saveSectionNote(actor: AcActor, roundId: number, subject: AcSubject, section: string, d: { summary?: string | null; recommendation?: string | null }, opts: { licenseUnlocked: boolean }): void {
  const a = requireApprover(actor, opts.licenseUnlocked);
  if (!/^[a-z_]{2,20}$/.test(section)) throw new AnnualCheckupInvalid("bad_value");
  const db = getDb();
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const id = (subject.userId ?? subject.externalId) as number;
  guard(() => db.transaction(() => {
    const cur = db.prepare(`SELECT id FROM annual_checkup_section_notes WHERE round_id = ? AND ${ccol} = ? AND section = ?`).get(roundId, id, section) as { id: number } | undefined;
    const sum = clean(d.summary, 4000), rec = clean(d.recommendation, 4000);
    if (cur) db.prepare("UPDATE annual_checkup_section_notes SET summary_text = ?, recommendation_text = ?, written_by = ?, written_at = CURRENT_TIMESTAMP WHERE id = ?").run(sum, rec, a.id, cur.id);
    else db.prepare(`INSERT INTO annual_checkup_section_notes (round_id, ${ccol}, section, summary_text, recommendation_text, written_by) VALUES (?, ?, ?, ?, ?, ?)`).run(roundId, id, section, sum, rec, a.id);
    const rel = db.prepare(`SELECT released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ?`).get(roundId, id) as { released_at: string | null } | undefined;
    if (rel?.released_at && subject.userId != null) db.prepare("INSERT INTO annual_checkup_revision_notices (round_id, user_id) VALUES (?, ?)").run(roundId, subject.userId);
    audit(a.id, rel?.released_at ? "note.revise" : "note.save", subjectCols(subject), roundId, null, section);
  })());
}

/** The person's own released wording (only once their conclusion is released). */
export function getMySectionNotes(actor: AcActor, roundId: number): SectionNote[] {
  const a = loadActor(actor);
  return getDb().prepare(`
    SELECT n.section, n.summary_text, n.recommendation_text
      FROM annual_checkup_section_notes n JOIN annual_checkup_conclusions c ON c.round_id = n.round_id AND c.user_id = n.user_id
     WHERE n.round_id = ? AND n.user_id = ? AND c.released_at IS NOT NULL
  `).all(roundId, a.id) as SectionNote[];
}

/** The doctor sends a person back to the recorder who sent them, with what to fix. The person is no longer "waiting for the doctor" until the recorder sends them again (the submission itself is never deleted). */
export function returnToRecorder(actor: AcActor, roundId: number, subject: AcSubject, note: string, opts: { licenseUnlocked: boolean }): void {
  const a = requireApprover(actor, opts.licenseUnlocked);
  const text = clean(note, 2000);
  if (!text) throw new AnnualCheckupInvalid("reason_required");
  const db = getDb();
  const col = subject.userId != null ? "user_id" : "external_id";
  const id = (subject.userId ?? subject.externalId) as number;
  guard(() => db.transaction(() => {
    const sub = db.prepare(`SELECT submitted_by FROM annual_checkup_submissions WHERE round_id = ? AND ${col} = ?`).get(roundId, id) as { submitted_by: number } | undefined;
    db.prepare(`INSERT INTO annual_checkup_returns (round_id, ${col}, note, returned_by, to_user) VALUES (?, ?, ?, ?, ?)`).run(roundId, id, text, a.id, sub?.submitted_by ?? null);
    audit(a.id, "result.return", subjectCols(subject), roundId, null);
  })());
}

export type ReturnedJob = { key: string; label: string; note: string; returned_at: string; by_name: string; round_id: number };
/** Work waiting for this recorder: persons the doctor sent back to them (or to any recorder when the original sender is unknown). */
export function listMyReturns(actor: AcActor, roundId?: number): ReturnedJob[] {
  const a = requireRecorder(actor);
  const rows = getDb().prepare(`
    SELECT rt.round_id, rt.user_id, rt.external_id, rt.note, rt.returned_at, d.display_name AS by_name, u.display_name, u.title_prefix, e.full_name, e.sort_no,
           COALESCE((SELECT name_th FROM annual_checkup_payers p WHERE p.id = e.payer_id), '') AS payer
      FROM annual_checkup_returns rt JOIN users d ON d.id = rt.returned_by
      LEFT JOIN users u ON u.id = rt.user_id LEFT JOIN annual_checkup_externals e ON e.id = rt.external_id
     WHERE rt.resolved_at IS NULL AND (rt.to_user IS NULL OR rt.to_user = ?) AND (? IS NULL OR rt.round_id = ?)
     ORDER BY rt.returned_at DESC
  `).all(a.id, roundId ?? null, roundId ?? null) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, round_id: r.round_id as number,
    label: r.user_id != null ? nameWithPrefix(r.title_prefix as string | null, r.display_name as string) : externalLabel(r.full_name as string | null, r.sort_no as number | null, r.payer as string),
    note: r.note as string, returned_at: r.returned_at as string, by_name: r.by_name as string
  }));
}

/** The latest open note on one person (shown to whoever opens that person). */
export function getOpenReturn(actor: AcActor, roundId: number, subject: AcSubject): { note: string; by_name: string; returned_at: string } | null {
  requireRecorder(actor);
  const col = subject.userId != null ? "rt.user_id" : "rt.external_id";
  return (getDb().prepare(`SELECT rt.note, d.display_name AS by_name, rt.returned_at FROM annual_checkup_returns rt JOIN users d ON d.id = rt.returned_by WHERE rt.round_id = ? AND ${col} = ? AND rt.resolved_at IS NULL ORDER BY rt.id DESC LIMIT 1`)
    .get(roundId, subject.userId ?? subject.externalId) as { note: string; by_name: string; returned_at: string } | undefined) ?? null;
}

/** Verify every draft result of one person in one go (the doctor looked at the whole booklet). Returns how many were verified. */
export function verifyAllForSubject(actor: AcActor, roundId: number, subject: AcSubject, opts: { licenseUnlocked: boolean }): number {
  requireApprover(actor, opts.licenseUnlocked);
  const db = getDb();
  const col = subject.userId != null ? "o.user_id" : "o.external_id";
  const ids = db.prepare(`
    SELECT r.id FROM annual_checkup_orders o JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND ${col} = ? AND o.status <> 'waived' AND r.status = 'draft'
       AND (r.value_num IS NOT NULL OR r.value_text IS NOT NULL OR r.value_json IS NOT NULL OR r.file_path IS NOT NULL)
  `).all(roundId, subject.userId ?? subject.externalId) as Array<{ id: number }>;
  for (const x of ids) verifyResult(actor, x.id, opts);
  return ids.length;
}

/** Open the results of everyone of one paying company whose conclusion is written and whose results are all verified; the rest are listed with why. */
export function releaseCompany(actor: AcActor, roundId: number, payerId: number, opts: { licenseUnlocked: boolean }): { released: number; people: number; skipped: Array<{ label: string; reason: string }> } {
  requireApprover(actor, opts.licenseUnlocked);
  const db = getDb();
  const subs = db.prepare(`
    SELECT DISTINCT o.user_id, o.external_id, u.display_name, u.title_prefix, e.full_name, e.sort_no, COALESCE(p.name_th, 'ไม่ระบุ') AS payer
      FROM annual_checkup_orders o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN annual_checkup_externals e ON e.id = o.external_id
      LEFT JOIN annual_checkup_payers p ON p.id = COALESCE(o.payer_id, e.payer_id)
     WHERE o.round_id = ? AND COALESCE(o.payer_id, e.payer_id) = ?
  `).all(roundId, payerId) as Array<{ user_id: number | null; external_id: number | null; display_name: string | null; title_prefix: string | null; full_name: string | null; sort_no: number | null; payer: string }>;
  const out = { released: 0, people: 0, skipped: [] as Array<{ label: string; reason: string }> };
  for (const s of subs) {
    const subject: AcSubject = s.user_id != null ? { userId: s.user_id } : { externalId: s.external_id as number };
    const label = s.user_id != null ? nameWithPrefix(s.title_prefix, s.display_name ?? "") : externalLabel(s.full_name, s.sort_no, s.payer);
    try { const n = releaseSubject(actor, roundId, subject, opts); if (n > 0) { out.released += n; out.people++; } }
    catch (e) {
      const code = isAnnualCheckupInvalid(e) ? e.code : "error";
      out.skipped.push({ label, reason: code === "no_conclusion" ? "ยังไม่มีสรุปผลของแพทย์" : code === "not_all_verified" ? "ยังมีรายการที่ยังไม่ตรวจสอบ" : code === "nothing_to_release" ? "ไม่มีรายการให้เปิดผล" : "เปิดผลไม่ได้" });
    }
  }
  return out;
}

/** People whose released results were changed and approved again and have not been told yet (only those with LINE linked). */
export function listPendingRevisionNotices(limit = 50): Array<{ id: number; user_id: number; line_user_id: string }> {
  return getDb().prepare(`
    SELECT n.id, n.user_id, u.line_user_id FROM annual_checkup_revision_notices n JOIN users u ON u.id = n.user_id
     WHERE n.sent_at IS NULL AND u.status NOT IN ('disabled', 'resigned', 'terminated') AND u.line_user_id IS NOT NULL AND u.line_user_id <> ''
     ORDER BY n.id LIMIT ?
  `).all(limit) as Array<{ id: number; user_id: number; line_user_id: string }>;
}
export function markRevisionNoticed(id: number): void {
  getDb().prepare("UPDATE annual_checkup_revision_notices SET sent_at = CURRENT_TIMESTAMP WHERE id = ? AND sent_at IS NULL").run(id);
}


// ── the report a person reads (health report PR 5) ─────────────────────────────────────────────────────────────────────

export type ReportResultRow = {
  code: string; name_th: string; value_num: number | null; value_text: string | null; value_json: string | null; unit: string | null;
  has_file: number; result_id: number; released_at: string | null;
};
export type ReportData = {
  round: { id: number; name: string; year_be: number | null; exam_date: string | null };
  person: { kind: "employee" | "external"; label: string; sex: "M" | "F" | null; dob: string | null; employee_code: string | null; company: string | null; position: string | null; department: string | null; user_id: number | null };
  results: ReportResultRow[];
  history: Record<number, ReportResultRow[]>;          // year_be → released results of that earlier round (employees only: an outside person has one round)
  notes: SectionNote[];
  conclusion: { summary: string | null; doctor_comment: string | null; released_at: string } | null;
};

const RELEASED_SQL = `
  SELECT t.code, t.name_th, r.value_num, r.value_text, r.value_json, r.unit, CASE WHEN r.file_path IS NOT NULL THEN 1 ELSE 0 END AS has_file, r.id AS result_id, r.released_at
    FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id JOIN annual_checkup_results r ON r.order_id = o.id
   WHERE o.round_id = ? AND r.status = 'released' AND `;

/** Internal: everything the report needs for ONE person, only once their conclusion is released. No authorisation here — callers do it. */
function collectReportData(roundId: number, subject: AcSubject): ReportData | null {
  const db = getDb();
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const ocol = subject.userId != null ? "o.user_id" : "o.external_id";
  const id = (subject.userId ?? subject.externalId) as number;
  const concl = db.prepare(`SELECT summary, doctor_comment, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ? AND released_at IS NOT NULL`).get(roundId, id) as ReportData["conclusion"] | undefined;
  if (!concl) return null;
  const round = db.prepare("SELECT id, name, year_be, start_date FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { id: number; name: string; year_be: number | null; start_date: string | null } | undefined;
  if (!round) return null;
  const results = db.prepare(`${RELEASED_SQL} ${ocol} = ? ORDER BY t.sort_no`).all(roundId, id) as ReportResultRow[];
  const notes = db.prepare(`SELECT section, summary_text, recommendation_text FROM annual_checkup_section_notes WHERE round_id = ? AND ${ccol} = ?`).all(roundId, id) as SectionNote[];
  let person: ReportData["person"];
  if (subject.userId != null) {
    const u = db.prepare("SELECT display_name, title_prefix, employee_code, gender, dob, job_title FROM users WHERE id = ?").get(subject.userId) as { display_name: string; title_prefix: string | null; employee_code: string | null; gender: string | null; dob: string | null; job_title: string | null } | undefined;
    if (!u) return null;
    const co = db.prepare("SELECT p.name_th FROM annual_checkup_orders o LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id WHERE o.round_id = ? AND o.user_id = ? LIMIT 1").get(roundId, subject.userId) as { name_th: string | null } | undefined;
    const br = db.prepare("SELECT b.name FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY ub.branch_id LIMIT 1").get(subject.userId) as { name: string } | undefined;
    person = { kind: "employee", label: nameWithPrefix(u.title_prefix, u.display_name), sex: u.gender === "male" ? "M" : u.gender === "female" ? "F" : null, dob: u.dob ? u.dob.slice(0, 10) : null, employee_code: u.employee_code, company: co?.name_th ?? null, position: u.job_title, department: br?.name ?? null, user_id: subject.userId };
  } else {
    const e = db.prepare("SELECT e.full_name, e.sex, e.dob, p.name_th AS payer FROM annual_checkup_externals e JOIN annual_checkup_payers p ON p.id = e.payer_id WHERE e.id = ?").get(subject.externalId) as { full_name: string | null; sex: "M" | "F" | null; dob: string | null; payer: string } | undefined;
    if (!e?.full_name) return null;
    person = { kind: "external", label: e.full_name, sex: e.sex, dob: e.dob ? e.dob.slice(0, 10) : null, employee_code: null, company: e.payer, position: null, department: null, user_id: null };
  }
  const history: ReportData["history"] = {};
  if (subject.userId != null && round.year_be != null) {
    const prev = db.prepare(`
      SELECT r.id, r.year_be FROM annual_checkup_conclusions c JOIN annual_checkup_rounds r ON r.id = c.round_id
       WHERE c.user_id = ? AND c.released_at IS NOT NULL AND r.id <> ? AND r.year_be IS NOT NULL AND r.year_be < ? ORDER BY r.year_be DESC LIMIT 2
    `).all(subject.userId, roundId, round.year_be) as Array<{ id: number; year_be: number }>;
    for (const p of prev) if (!history[p.year_be]) history[p.year_be] = db.prepare(`${RELEASED_SQL} o.user_id = ? ORDER BY t.sort_no`).all(p.id, subject.userId) as ReportResultRow[];
  }
  const exam = round.start_date ?? concl.released_at.slice(0, 10);
  return { round: { id: round.id, name: round.name, year_be: round.year_be, exam_date: exam }, person, results, history, notes, conclusion: concl };
}

/** The signed-in employee's own released report. Audited as a self view. */
export function getMyReportData(actor: AcActor, roundId: number): ReportData | null {
  const a = loadActor(actor);
  const d = collectReportData(roundId, { userId: a.id });
  if (d) audit(a.id, "self.view", { user_id: a.id, external_id: null }, roundId, null);
  return d;
}

/** The report for clinical staff, after release (used to print / check what the person sees). */
export function getReportDataClinical(actor: AcActor, roundId: number, subject: AcSubject): ReportData | null {
  const a = requireRecorder(actor);
  const d = collectReportData(roundId, subject);
  if (d) audit(a.id, "subject.view", subjectCols(subject), roundId, null);
  return d;
}

// ── links for people without an account ──
const LINK_MAX_FAILS = 5, LINK_LOCK_MINUTES = 30;
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const plusMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString().slice(0, 19).replace("T", " ");

export type LinkInfo = { id: number; round_id: number; external_id: number; expires_at: string; open_count: number; last_opened_at: string | null; revoked_at: string | null; created_at: string; locked_until: string | null };

/** Make a link for an outside person whose results are released. The token is returned ONCE and never stored (only its hash). */
export function createAccessLink(actor: AcActor, roundId: number, externalId: number, days: number, opts: { reissue?: boolean } = {}): { token: string; expires_at: string; revoked: number } {
  const a = requireRecorder(actor);
  const db = getDb();
  const d = Math.min(90, Math.max(1, Math.floor(days)));
  return guard(() => db.transaction(() => {
    const e = db.prepare("SELECT e.dob, x.id_last4 FROM annual_checkup_externals e LEFT JOIN annual_checkup_external_details x ON x.external_id = e.id WHERE e.id = ? AND e.round_id = ?").get(externalId, roundId) as { dob: string | null; id_last4: string | null } | undefined;
    if (!e) throw new AnnualCheckupInvalid("subject_not_found");
    if (!e.dob && !e.id_last4) throw new AnnualCheckupInvalid("dob_required");   // nothing to check the person against
    const rel = db.prepare("SELECT 1 FROM annual_checkup_conclusions WHERE round_id = ? AND external_id = ? AND released_at IS NOT NULL").get(roundId, externalId);
    if (!rel) throw new AnnualCheckupInvalid("not_released");
    // reissue: every link still open for this person is cancelled first (a lost or forwarded link stops working)
    const revoked = opts.reissue ? db.prepare("UPDATE annual_checkup_access_links SET revoked_at = CURRENT_TIMESTAMP WHERE round_id = ? AND external_id = ? AND revoked_at IS NULL").run(roundId, externalId).changes : 0;
    const token = crypto.randomBytes(24).toString("base64url");
    const expires = plusMin(d * 24 * 60);
    db.prepare("INSERT INTO annual_checkup_access_links (round_id, external_id, token_hash, expires_at, created_by) VALUES (?,?,?,?,?)").run(roundId, externalId, sha(token), expires, a.id);
    audit(a.id, "link.create", { user_id: null, external_id: externalId }, roundId, null, `days ${d}${revoked ? `, reissued (${revoked} cancelled)` : ""}`);
    return { token, expires_at: expires, revoked };
  })());
}

export function listAccessLinks(actor: AcActor, roundId: number, externalId: number): LinkInfo[] {
  requireRecorder(actor);
  return getDb().prepare("SELECT id, round_id, external_id, expires_at, open_count, last_opened_at, revoked_at, created_at, locked_until FROM annual_checkup_access_links WHERE round_id = ? AND external_id = ? ORDER BY id DESC")
    .all(roundId, externalId) as LinkInfo[];
}
export function revokeAccessLink(actor: AcActor, linkId: number): void {
  const a = requireRecorder(actor);
  const r = getDb().prepare("UPDATE annual_checkup_access_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL").run(linkId);
  if (r.changes > 0) audit(a.id, "link.revoke", null, null, null, `link ${linkId}`);
}

export type LinkState = { id: number; usable: boolean; reason: "ok" | "expired" | "revoked" | "locked"; locked_until: string | null };
/** Public: what a token is (never says whether a date of birth exists). null = no such link. */
export function resolveAccessLink(token: string): LinkState | null {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const l = getDb().prepare("SELECT id, expires_at, revoked_at, locked_until FROM annual_checkup_access_links WHERE token_hash = ?").get(sha(token)) as { id: number; expires_at: string; revoked_at: string | null; locked_until: string | null } | undefined;
  if (!l) return null;
  const now = nowSql();
  const reason = l.revoked_at ? "revoked" : l.expires_at <= now ? "expired" : l.locked_until && l.locked_until > now ? "locked" : "ok";
  return { id: l.id, usable: reason === "ok", reason, locked_until: l.locked_until };
}

/** Public: check a date of birth (yyyy-mm-dd, Christian era). Wrong answers are counted; five in a row lock the link for 30 minutes. */
export function verifyAccessLink(token: string, dobIso: string | null, idLast4?: string | null): { ok: true; linkId: number } | { ok: false; reason: "invalid" | "expired" | "revoked" | "locked" | "wrong"; attemptsLeft?: number } {
  const st = resolveAccessLink(token);
  if (!st) return { ok: false, reason: "invalid" };
  if (!st.usable) return { ok: false, reason: st.reason as "expired" | "revoked" | "locked" };
  const db = getDb();
  const row = db.prepare("SELECT l.failed_count, e.dob, x.id_last4 FROM annual_checkup_access_links l JOIN annual_checkup_externals e ON e.id = l.external_id LEFT JOIN annual_checkup_external_details x ON x.external_id = e.id WHERE l.id = ?").get(st.id) as { failed_count: number; dob: string | null; id_last4: string | null };
  // either proof opens the link: the date of birth, or the last 4 characters of the ID the clinic has on file
  const byDob = !!row.dob && !!dobIso && /^\d{4}-\d{2}-\d{2}$/.test(dobIso) && row.dob.slice(0, 10) === dobIso;
  const byId = !!row.id_last4 && !!idLast4 && /^[A-Za-z0-9]{4}$/.test(idLast4) && row.id_last4.toUpperCase() === idLast4.toUpperCase();
  const good = byDob || byId;
  if (good) {
    db.prepare("UPDATE annual_checkup_access_links SET failed_count = 0, locked_until = NULL, open_count = open_count + 1, last_opened_at = CURRENT_TIMESTAMP WHERE id = ?").run(st.id);
    return { ok: true, linkId: st.id };
  }
  const fails = row.failed_count + 1;
  if (fails >= LINK_MAX_FAILS) db.prepare("UPDATE annual_checkup_access_links SET failed_count = 0, locked_until = ? WHERE id = ?").run(plusMin(LINK_LOCK_MINUTES), st.id);
  else db.prepare("UPDATE annual_checkup_access_links SET failed_count = ? WHERE id = ?").run(fails, st.id);
  return fails >= LINK_MAX_FAILS ? { ok: false, reason: "locked" } : { ok: false, reason: "wrong", attemptsLeft: LINK_MAX_FAILS - fails };
}

/** Public, after the date of birth was accepted: the report behind a link, if the link is still usable. Every call is logged (actor 0 = the link). */
export function getLinkReportData(linkId: number): ReportData | null {
  const db = getDb();
  const l = db.prepare("SELECT round_id, external_id, expires_at, revoked_at FROM annual_checkup_access_links WHERE id = ?").get(linkId) as { round_id: number; external_id: number; expires_at: string; revoked_at: string | null } | undefined;
  if (!l || l.revoked_at || l.expires_at <= nowSql()) return null;
  const d = collectReportData(l.round_id, { externalId: l.external_id });
  if (d) audit(0, "link.view", { user_id: null, external_id: l.external_id }, l.round_id, null, `link ${linkId}`);
  return d;
}

/** The file behind a result, opened from a link (a result of THAT person only, released). */
export function getLinkResultFile(linkId: number, resultId: number): { path: string; mime: string } | null {
  const db = getDb();
  const l = db.prepare("SELECT round_id, external_id, expires_at, revoked_at FROM annual_checkup_access_links WHERE id = ?").get(linkId) as { round_id: number; external_id: number; expires_at: string; revoked_at: string | null } | undefined;
  if (!l || l.revoked_at || l.expires_at <= nowSql()) return null;
  const r = db.prepare(`
    SELECT r.file_path, r.file_mime FROM annual_checkup_results r JOIN annual_checkup_orders o ON o.id = r.order_id
     WHERE r.id = ? AND o.round_id = ? AND o.external_id = ? AND r.status = 'released' AND r.file_path IS NOT NULL
  `).get(resultId, l.round_id, l.external_id) as { file_path: string; file_mime: string | null } | undefined;
  if (!r) return null;
  audit(0, "link.file", { user_id: null, external_id: l.external_id }, l.round_id, resultId, `link ${linkId}`);
  return { path: r.file_path, mime: r.file_mime ?? "application/octet-stream" };
}


// ── permissions screen, the doctors' overview, sharing with HR (health report PR 7) ─────────────────────────────────

export type ClinicPerson = { id: number; name: string; employee_code: string | null; status: string; clinical_role: string | null; has_license: boolean; recorder: boolean; approver: boolean; approver_blocker: string | null; in_clinic: boolean };

function eligibilityNote(row: { status: string; clinical_role: string | null; license_no: string | null }, inClinic: boolean): string | null {
  if (["disabled", "resigned", "terminated"].includes(row.status)) return "ไม่ได้ทำงานแล้ว";
  if (!inClinic) return "ไม่ได้อยู่สาขา AT HOME CLINIC";
  if (row.clinical_role !== "doctor") return "ต้องเป็นแพทย์ (ตั้งบทบาทแพทย์ที่หน้าพนักงาน)";
  if (!row.license_no || !row.license_no.trim()) return "ต้องมีเลขใบอนุญาตประกอบวิชาชีพ";
  return null;
}

/** For the owner: everyone on the clinic branch roster with their two capabilities and, for the approver, what is still missing. */
export function listClinicPeople(actor: AcActor): ClinicPerson[] {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  const rows = getDb().prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.employee_code, u.status, u.clinical_role, u.license_no, u.health_result_recorder AS rec, u.health_result_approver AS app
      FROM users u JOIN user_branches ub ON ub.user_id = u.id JOIN branches b ON b.id = ub.branch_id
     WHERE b.slug = 'at-home-clinic' AND u.status NOT IN ('disabled','resigned','terminated') ORDER BY u.display_name COLLATE NOCASE
  `).all() as Array<{ id: number; display_name: string; title_prefix: string | null; employee_code: string | null; status: string; clinical_role: string | null; license_no: string | null; rec: number; app: number }>;
  return rows.map((r) => ({ id: r.id, name: nameWithPrefix(r.title_prefix, r.display_name), employee_code: r.employee_code, status: r.status, clinical_role: r.clinical_role, has_license: !!r.license_no?.trim(), recorder: r.rec === 1, approver: r.app === 1, approver_blocker: eligibilityNote(r, true), in_clinic: true }));
}

/** People not on the clinic roster who match a search — the owner may add one deliberately. */
export function searchPeopleOutsideClinic(actor: AcActor, q: string): Array<{ id: number; name: string; employee_code: string | null; branches: string }> {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  const t = q.trim();
  if (t.length < 2) return [];
  const like = `%${t.replace(/[%_]/g, "")}%`;
  const rows = getDb().prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.employee_code,
           (SELECT GROUP_CONCAT(b.name, ', ') FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id) AS branches
      FROM users u
     WHERE u.status NOT IN ('disabled','resigned','terminated') AND u.role IN ('staff','admin')
       AND (u.display_name LIKE ? OR u.employee_code LIKE ?)
       AND NOT EXISTS (SELECT 1 FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id AND b.slug = 'at-home-clinic')
     ORDER BY u.display_name COLLATE NOCASE LIMIT 10
  `).all(like, like) as Array<{ id: number; display_name: string; title_prefix: string | null; employee_code: string | null; branches: string | null }>;
  return rows.map((r) => ({ id: r.id, name: nameWithPrefix(r.title_prefix, r.display_name), employee_code: r.employee_code, branches: r.branches ?? "—" }));
}

/** The owner puts a person on the clinic roster (a precondition for any capability). Recorded in the audit list and the activity log. */
export function addToClinic(actor: AcActor, userId: number, reason: string): void {
  const a = loadActor(actor);
  if (a.role !== "super_admin") throw new AnnualCheckupForbidden("super_admin_only");
  if (!clean(reason)) throw new AnnualCheckupInvalid("reason_required");
  const db = getDb();
  guard(() => db.transaction(() => {
    const b = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
    if (!b) throw new AnnualCheckupInvalid("subject_not_found");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND status NOT IN ('disabled','resigned','terminated')").get(userId)) throw new AnnualCheckupInvalid("subject_not_found");
    db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(userId, b.id);
    audit(a.id, "clinic.add", { user_id: userId, external_id: null }, null, null, clean(reason) ?? undefined);
  })());
  logPersonaAction(a.id, "annual_checkup.add_to_clinic", userId);
}

export type Dashboard = {
  round: { id: number; name: string };
  states: Record<"not_recorded" | "partial" | "to_send" | "awaiting_doctor" | "returned" | "to_release" | "released" | "revised", number>; total: number;
  byPayer: Array<{ payer: string; total: number; released: number; awaiting_doctor: number }>;
  byRecorder: Array<{ name: string; returned: number; sent: number }>;
  followUp: Array<{ key: string; label: string; payer: string; summary: string; released: boolean }>;
};

/** For the doctors and the clinic team: how many people are at each step, who has what waiting, and who needs follow-up. */
export function getRoundDashboard(actor: AcActor, roundId: number): Dashboard {
  const a = requireRecorder(actor);
  const ov = getRoundOverview(actor, roundId);
  const states: Dashboard["states"] = { not_recorded: 0, partial: 0, to_send: 0, awaiting_doctor: 0, returned: 0, to_release: 0, released: 0, revised: 0 };
  const payer = new Map<string, { payer: string; total: number; released: number; awaiting_doctor: number }>();
  for (const s of ov.subjects) {
    const k: keyof Dashboard["states"] = s.returned ? "returned"
      : s.conclusionReleased && s.required > 0 && s.released < s.required ? "revised"
      : s.required > 0 && s.released === s.required ? "released"
      : s.required > 0 && s.verified === s.required ? "to_release"
      : s.required > 0 && s.recorded === s.required ? (s.submitted ? "awaiting_doctor" : "to_send")
      : s.recorded === 0 ? "not_recorded" : "partial";
    states[k]++;
    const p = payer.get(s.payer) ?? { payer: s.payer, total: 0, released: 0, awaiting_doctor: 0 };
    p.total++; if (k === "released") p.released++; if (k === "awaiting_doctor") p.awaiting_doctor++;
    payer.set(s.payer, p);
  }
  const db = getDb();
  const byRecorder = db.prepare(`
    SELECT u.display_name AS name,
           (SELECT COUNT(*) FROM annual_checkup_returns rt WHERE rt.round_id = ? AND rt.resolved_at IS NULL AND rt.to_user = u.id) AS returned,
           (SELECT COUNT(*) FROM annual_checkup_submissions sb WHERE sb.round_id = ? AND sb.submitted_by = u.id) AS sent
      FROM users u WHERE u.health_result_recorder = 1 OR u.health_result_approver = 1 ORDER BY u.display_name COLLATE NOCASE
  `).all(roundId, roundId) as Dashboard["byRecorder"];
  const label = new Map(ov.subjects.map((s) => [s.key, { label: s.label, payer: s.payer }]));
  const fu = db.prepare("SELECT user_id, external_id, summary, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND summary IN ('abnormal','follow_up') ORDER BY id").all(roundId) as Array<{ user_id: number | null; external_id: number | null; summary: string; released_at: string | null }>;
  const followUp = fu.map((c) => { const key = c.user_id != null ? `u${c.user_id}` : `e${c.external_id}`; const l = label.get(key); return { key, label: l?.label ?? key, payer: l?.payer ?? "", summary: c.summary === "abnormal" ? "ผิดปกติ" : "ต้องติดตาม", released: !!c.released_at }; });
  audit(a.id, "round.dashboard", null, roundId, null);
  return { round: { id: ov.round.id, name: ov.round.name }, states, total: ov.subjects.length, byPayer: [...payer.values()], byRecorder: byRecorder.filter((r) => r.returned > 0 || r.sent > 0), followUp };
}

// ── sharing with HR (employee's own choice) ──
export type ShareScope = "followup" | "values";
export function getMyShare(actor: AcActor): Record<ShareScope, boolean> {
  const a = loadActor(actor);
  const rows = getDb().prepare("SELECT scope, granted_at, revoked_at FROM annual_checkup_share_consents WHERE user_id = ?").all(a.id) as Array<{ scope: ShareScope; granted_at: string | null; revoked_at: string | null }>;
  const on = (s: ShareScope) => { const r = rows.find((x) => x.scope === s); return !!r?.granted_at && !r.revoked_at; };
  return { followup: on("followup"), values: on("values") };
}
export function setMyShare(actor: AcActor, scope: ShareScope, on: boolean): void {
  const a = loadActor(actor);
  if (scope !== "followup" && scope !== "values") throw new AnnualCheckupInvalid("bad_value");
  const db = getDb();
  guard(() => db.transaction(() => {
    if (on) db.prepare("INSERT INTO annual_checkup_share_consents (user_id, scope, granted_at, revoked_at) VALUES (?, ?, CURRENT_TIMESTAMP, NULL) ON CONFLICT(user_id, scope) DO UPDATE SET granted_at = CURRENT_TIMESTAMP, revoked_at = NULL").run(a.id, scope);
    else db.prepare("UPDATE annual_checkup_share_consents SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND scope = ?").run(a.id, scope);
    audit(a.id, on ? "share.on" : "share.off", { user_id: a.id, external_id: null }, null, null, scope);
  })());
}
const isHrActor = (a: { role: string; is_hr_analytics: number }) => a.role === "super_admin" || a.role === "admin" || a.is_hr_analytics === 1;

/** HR / admin / owner: the follow-up names of people who agreed to share them. Name and verdict only — never a value. */
export function getFollowUpForHr(actor: AcActor, roundId: number): Array<{ user_id: number; name: string; payer: string; verdict: string }> {
  const a = loadActor(actor);
  if (!isHrActor(a)) throw new AnnualCheckupForbidden("not_allowed");
  const rows = getDb().prepare(`
    SELECT c.user_id, c.summary, u.display_name, u.title_prefix, COALESCE((SELECT p.name_th FROM annual_checkup_orders o JOIN annual_checkup_payers p ON p.id = o.payer_id WHERE o.round_id = c.round_id AND o.user_id = c.user_id LIMIT 1), 'ไม่ระบุ') AS payer
      FROM annual_checkup_conclusions c JOIN users u ON u.id = c.user_id
      JOIN annual_checkup_share_consents sc ON sc.user_id = c.user_id AND sc.scope IN ('followup','values') AND sc.granted_at IS NOT NULL AND sc.revoked_at IS NULL
     WHERE c.round_id = ? AND c.released_at IS NOT NULL AND c.summary IN ('abnormal','follow_up')
     GROUP BY c.user_id ORDER BY u.display_name COLLATE NOCASE
  `).all(roundId) as Array<{ user_id: number; summary: string; display_name: string; title_prefix: string | null; payer: string }>;
  audit(a.id, "hr.followup", null, roundId, null);
  return rows.map((r) => ({ user_id: r.user_id, name: nameWithPrefix(r.title_prefix, r.display_name), payer: r.payer, verdict: r.summary === "abnormal" ? "ผิดปกติ" : "ต้องติดตาม" }));
}

/** HR may open ONE employee's released report only if that employee agreed to share values. Audited under the employee's name. */
export function getSharedReportData(actor: AcActor, roundId: number, userId: number): ReportData | null {
  const a = loadActor(actor);
  if (!isHrActor(a)) throw new AnnualCheckupForbidden("not_allowed");
  const ok = getDb().prepare("SELECT 1 FROM annual_checkup_share_consents WHERE user_id = ? AND scope = 'values' AND granted_at IS NOT NULL AND revoked_at IS NULL").get(userId);
  if (!ok) throw new AnnualCheckupForbidden("not_allowed");
  const d = collectReportData(roundId, { userId });
  if (d) audit(a.id, "hr.view", { user_id: userId, external_id: null }, roundId, null);
  return d;
}


// ── examinees from outside companies (no account, never in PERSONA) ─────────────────────────────────────────────────────

export type ExternalInput = {
  title?: string | null; firstName: string; lastName: string; sex?: "M" | "F" | null; dob?: string | null; phone?: string | null; email?: string | null;
  idLast4?: string | null; sponsorEmployeeCode?: string | null; pdpa?: boolean;
};
const SEX_BY_TITLE: Array<[RegExp, "M" | "F"]> = [[/^(นาย|ด\.ช\.|mr\.?)$/i, "M"], [/^(นางสาว|นาง|น\.ส\.|ด\.ญ\.|mrs\.?|ms\.?|miss)$/i, "F"]];
export const sexFromTitle = (t: string | null | undefined): "M" | "F" | null => { const x = (t ?? "").trim(); for (const [re, s] of SEX_BY_TITLE) if (re.test(x)) return s; return null; };
const PERSON_TITLE = /^(นางสาว|นาย|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|miss|ms\.?)\s*/i;
/** "นางสาว สมหญิง ใจดี" → title / first / last (the last word is the surname; a single word has no surname). */
export function splitThaiName(full: string): { title: string | null; first: string; last: string } {
  const s = full.replace(/\s+/g, " ").trim();
  const m = PERSON_TITLE.exec(s);
  const title = m ? m[1] : null;
  const rest = (m ? s.slice(m[0].length) : s).trim();
  const parts = rest.split(" ").filter(Boolean);
  return { title, first: parts.length > 1 ? parts.slice(0, -1).join(" ") : rest, last: parts.length > 1 ? parts[parts.length - 1] : "" };
}
export const normPersonKey = (first: string, last: string) => `${first}${last}`.replace(/[\s.]+/g, "").toLowerCase();

/** The examination code of an outside person: <company prefix><year 2 digits>-<running number 4 digits>, e.g. TSR69-0004 (null when the company has no prefix). */
function externalExamCode(db: ReturnType<typeof getDb>, payerName: string, yearBe: number | null, sortNo: number): string | null {
  const pre = db.prepare("SELECT prefix FROM annual_checkup_payer_prefixes WHERE payer_name = ?").get(payerName) as { prefix: string } | undefined;
  if (!pre || yearBe == null) return null;
  return `${pre.prefix}${String(yearBe % 100).padStart(2, "0")}-${String(sortNo).padStart(4, "0")}`;
}

/** Internal: add (or find) a named outside person of a paying company in a round. Matching: first + last name + company, and the date of birth when both sides have one. */
export function upsertExternalPerson(roundId: number, payerId: number, d: ExternalInput, createdBy: number): { externalId: number; created: boolean; sortNo: number; examCode: string | null } {
  const db = getDb();
  const first = d.firstName.trim(), last = d.lastName.trim();
  if (!first) throw new AnnualCheckupInvalid("name_required");
  if (d.dob != null && !/^\d{4}-\d{2}-\d{2}$/.test(d.dob)) throw new AnnualCheckupInvalid("bad_value");
  if (d.idLast4 != null && d.idLast4 !== "" && !/^[A-Za-z0-9]{4}$/.test(d.idLast4)) throw new AnnualCheckupInvalid("bad_value");
  return db.transaction(() => {
    const key = normPersonKey(first, last);
    const cands = db.prepare(`
      SELECT e.id, e.sort_no, e.dob, x.first_name, x.last_name FROM annual_checkup_externals e LEFT JOIN annual_checkup_external_details x ON x.external_id = e.id
       WHERE e.round_id = ? AND e.payer_id = ? AND e.is_placeholder = 0
    `).all(roundId, payerId) as Array<{ id: number; sort_no: number | null; dob: string | null; first_name: string | null; last_name: string | null }>;
    const same = cands.filter((c) => c.first_name != null && normPersonKey(c.first_name, c.last_name ?? "") === key && (!d.dob || !c.dob || c.dob.slice(0, 10) === d.dob));
    const payer = db.prepare("SELECT name_th FROM annual_checkup_payers WHERE id = ? AND round_id = ?").get(payerId, roundId) as { name_th: string } | undefined;
    const round = db.prepare("SELECT year_be FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { year_be: number | null } | undefined;
    if (!payer || !round) throw new AnnualCheckupInvalid("subject_not_found");
    if (same.length === 1) {
      const e = same[0];
      return { externalId: e.id, created: false, sortNo: e.sort_no ?? 0, examCode: (db.prepare("SELECT exam_code FROM annual_checkup_exam_codes WHERE round_id = ? AND external_id = ?").get(roundId, e.id) as { exam_code: string } | undefined)?.exam_code ?? null };
    }
    if (same.length > 1) throw new AnnualCheckupInvalid("ambiguous");
    const sortNo = ((db.prepare("SELECT COALESCE(MAX(sort_no), 0) AS m FROM annual_checkup_externals WHERE round_id = ? AND payer_id = ?").get(roundId, payerId) as { m: number }).m) + 1;
    const title = clean(d.title, 20);
    const full = [title, first, last].filter(Boolean).join(" ");
    const sex = d.sex ?? sexFromTitle(title);
    const id = Number(db.prepare("INSERT INTO annual_checkup_externals (round_id, payer_id, full_name, is_placeholder, sex, dob, sort_no) VALUES (?,?,?,0,?,?,?)").run(roundId, payerId, full, sex, d.dob ?? null, sortNo).lastInsertRowid);
    db.prepare(`INSERT INTO annual_checkup_external_details (external_id, title, first_name, last_name, phone, email, id_last4, sponsor_employee_code, consent_pdpa_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, title, first, last, clean(d.phone, 40), clean(d.email, 120), d.idLast4 ? d.idLast4.toUpperCase() : null, clean(d.sponsorEmployeeCode, 40), d.pdpa ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, createdBy);
    // the running number starts at the person's place in the company's list and moves on if that code is already used in the round
    let examCode: string | null = null;
    for (let n = sortNo; n < sortNo + 500; n++) {
      const code = externalExamCode(db, payer.name_th, round.year_be, n);
      if (!code) break;
      if (db.prepare("SELECT 1 FROM annual_checkup_exam_codes WHERE round_id = ? AND exam_code = ?").get(roundId, code)) continue;
      db.prepare("INSERT INTO annual_checkup_exam_codes (round_id, external_id, exam_code, created_by) VALUES (?,?,?,?)").run(roundId, id, code, createdBy);
      examCode = code; break;
    }
    audit(createdBy, "external.create", { user_id: null, external_id: id }, roundId, null);
    return { externalId: id, created: true, sortNo, examCode };
  })();
}

/** For the importer: the names of the outside examinees already in a round (external id → first / last name), so the same person is found again. */
export function listExternalNamesForImport(roundId: number): Map<number, { first: string; last: string }> {
  const rows = getDb().prepare(`SELECT x.external_id, x.first_name, x.last_name FROM annual_checkup_external_details x JOIN annual_checkup_externals e ON e.id = x.external_id
    WHERE e.round_id = ? AND e.is_placeholder = 0 AND x.first_name IS NOT NULL`).all(roundId) as Array<{ external_id: number; first_name: string; last_name: string | null }>;
  return new Map(rows.map((r) => [r.external_id, { first: r.first_name, last: r.last_name ?? "" }]));
}

/** A clinic recorder adds one outside examinee by hand (people who are not in the planning file). */
export function addExternalPerson(actor: AcActor, roundId: number, payerId: number, d: ExternalInput): { externalId: number; created: boolean; examCode: string | null; ordersAdded: number } {
  const a = requireRecorder(actor);
  return guard(() => getDb().transaction(() => {
    const r = upsertExternalPerson(roundId, payerId, d, a.id);
    // the person gets the tests their company's programme gives to everyone ("เฉพาะคนที่ระบุ" tests are added by hand afterwards)
    const db = getDb();
    const tests = db.prepare(`SELECT pt.test_id FROM annual_checkup_program_tests pt JOIN annual_checkup_programs pg ON pg.id = pt.program_id
       WHERE pg.round_id = ? AND pg.payer_id = ? AND pt.scope = 'all'`).all(roundId, payerId) as Array<{ test_id: number }>;
    const ins = db.prepare("INSERT OR IGNORE INTO annual_checkup_orders (round_id, external_id, payer_id, test_id, status) VALUES (?,?,?,?, 'ordered')");
    let ordersAdded = 0;
    for (const t of tests) if (!db.prepare("SELECT 1 FROM annual_checkup_orders WHERE round_id = ? AND external_id = ? AND test_id = ?").get(roundId, r.externalId, t.test_id)) { ins.run(roundId, r.externalId, payerId, t.test_id); ordersAdded++; }
    return { externalId: r.externalId, created: r.created, examCode: r.examCode, ordersAdded };
  })());
}

export type ExternalDetails = { external_id: number; title: string | null; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_last4: string | null; sponsor_employee_code: string | null; consent_pdpa_at: string | null; consent_release_to_sponsor: boolean; sex: "M" | "F" | null; dob: string | null; payer: string };
export function getExternalDetails(actor: AcActor, externalId: number): ExternalDetails | null {
  const a = requireRecorder(actor);
  const r = getDb().prepare(`
    SELECT e.id AS external_id, e.sex, e.dob, p.name_th AS payer, x.title, x.first_name, x.last_name, x.phone, x.email, x.id_last4, x.sponsor_employee_code, x.consent_pdpa_at, COALESCE(x.consent_release_to_sponsor, 0) AS rel
      FROM annual_checkup_externals e JOIN annual_checkup_payers p ON p.id = e.payer_id LEFT JOIN annual_checkup_external_details x ON x.external_id = e.id WHERE e.id = ?
  `).get(externalId) as (Omit<ExternalDetails, "consent_release_to_sponsor"> & { rel: number }) | undefined;
  if (!r) return null;
  audit(a.id, "external.view", { user_id: null, external_id: externalId }, null, null);
  const { rel, ...rest } = r;
  return { ...rest, consent_release_to_sponsor: rel === 1 };
}

/** Record what the person agreed to: the PDPA notice, and whether the paying company may see their values. */
export function setExternalConsent(actor: AcActor, externalId: number, c: { pdpa?: boolean; releaseToSponsor?: boolean }): void {
  const a = requireRecorder(actor);
  const db = getDb();
  guard(() => db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM annual_checkup_externals WHERE id = ?").get(externalId)) throw new AnnualCheckupInvalid("subject_not_found");
    db.prepare("INSERT OR IGNORE INTO annual_checkup_external_details (external_id, created_by) VALUES (?, ?)").run(externalId, a.id);
    if (c.pdpa !== undefined) db.prepare("UPDATE annual_checkup_external_details SET consent_pdpa_at = CASE WHEN ? = 1 THEN COALESCE(consent_pdpa_at, CURRENT_TIMESTAMP) ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE external_id = ?").run(c.pdpa ? 1 : 0, externalId);
    if (c.releaseToSponsor !== undefined) db.prepare("UPDATE annual_checkup_external_details SET consent_release_to_sponsor = ?, updated_at = CURRENT_TIMESTAMP WHERE external_id = ?").run(c.releaseToSponsor ? 1 : 0, externalId);
    audit(a.id, "external.consent", { user_id: null, external_id: externalId }, null, null, JSON.stringify(c));
  })());
}


// ── summary for the paying company: counts and readiness, never a person's values unless they agreed ───────────────────

export type Readiness = "suitable" | "suitable_follow_up" | "see_doctor";
export const READINESS_TH: Record<Readiness, string> = { suitable: "เหมาะสม", suitable_follow_up: "เหมาะสมแต่ควรติดตาม", see_doctor: "ควรพบแพทย์" };
export type SponsorSummary = {
  round: { id: number; name: string }; payer: { id: number; name: string };
  counts: { total: number; resultsComplete: number; released: number; pending: number; readiness: Record<Readiness, number> };
  people: Array<{ label: string; stage: "not_started" | "in_progress" | "complete" | "released"; readiness: Readiness | null; sharedValues: Array<{ test: string; value: string }> | null }>;
};
const READINESS_OF: Record<string, Readiness> = { normal: "suitable", follow_up: "suitable_follow_up", abnormal: "see_doctor" };

/**
 * What the clinic hands the paying company (an outside company's examinees only). Status and readiness come from the doctor's released
 * conclusion; the lab values of a person appear ONLY when that person agreed (consent_release_to_sponsor) AND their results are released.
 */
export function getSponsorSummary(actor: AcActor, roundId: number, payerId: number): SponsorSummary {
  const a = requireRecorder(actor);
  const db = getDb();
  const round = db.prepare("SELECT id, name FROM annual_checkup_rounds WHERE id = ?").get(roundId) as { id: number; name: string } | undefined;
  const payer = db.prepare("SELECT id, name_th AS name, is_external FROM annual_checkup_payers WHERE id = ? AND round_id = ?").get(payerId, roundId) as { id: number; name: string; is_external: number } | undefined;
  if (!round) throw new AnnualCheckupInvalid("round_not_found");
  if (!payer || payer.is_external !== 1) throw new AnnualCheckupInvalid("subject_not_found");
  const rows = db.prepare(`
    SELECT e.id, e.full_name, e.sort_no, COALESCE(x.consent_release_to_sponsor, 0) AS consent,
           (SELECT COUNT(*) FROM annual_checkup_orders o WHERE o.external_id = e.id AND o.status <> 'waived') AS required,
           (SELECT COUNT(*) FROM annual_checkup_orders o JOIN annual_checkup_results r ON r.order_id = o.id WHERE o.external_id = e.id AND o.status <> 'waived') AS recorded,
           (SELECT COUNT(*) FROM annual_checkup_orders o JOIN annual_checkup_results r ON r.order_id = o.id WHERE o.external_id = e.id AND o.status <> 'waived' AND r.status = 'released') AS released,
           c.summary, c.released_at
      FROM annual_checkup_externals e LEFT JOIN annual_checkup_external_details x ON x.external_id = e.id
      LEFT JOIN annual_checkup_conclusions c ON c.round_id = e.round_id AND c.external_id = e.id
     WHERE e.round_id = ? AND e.payer_id = ? AND e.is_placeholder = 0 ORDER BY e.sort_no, e.id
  `).all(roundId, payerId) as Array<{ id: number; full_name: string | null; sort_no: number | null; consent: number; required: number; recorded: number; released: number; summary: string | null; released_at: string | null }>;
  const readiness: Record<Readiness, number> = { suitable: 0, suitable_follow_up: 0, see_doctor: 0 };
  let released = 0, complete = 0;
  const people = rows.map((r) => {
    const isReleased = r.required > 0 && r.released === r.required && !!r.released_at;
    const stage: SponsorSummary["people"][number]["stage"] = isReleased ? "released" : r.required > 0 && r.recorded === r.required ? "complete" : r.recorded > 0 ? "in_progress" : "not_started";
    if (isReleased) released++;
    if (stage === "released" || stage === "complete") complete++;
    const rd = isReleased && r.summary ? READINESS_OF[r.summary] ?? null : null;
    if (rd) readiness[rd]++;
    let shared: SponsorSummary["people"][number]["sharedValues"] = null;
    if (isReleased && r.consent === 1) {
      const vals = db.prepare(`
        SELECT t.name_th AS test, x.value_num, x.value_text FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
          JOIN annual_checkup_results x ON x.order_id = o.id WHERE o.external_id = ? AND o.status <> 'waived' AND x.status = 'released' AND (x.value_num IS NOT NULL OR x.value_text IS NOT NULL) ORDER BY t.sort_no
      `).all(r.id) as Array<{ test: string; value_num: number | null; value_text: string | null }>;
      shared = vals.map((v) => ({ test: v.test, value: v.value_num != null ? String(v.value_num) : (v.value_text as string) }));
    }
    return { label: r.full_name ?? `คนที่ ${r.sort_no ?? "?"}`, stage, readiness: rd, sharedValues: shared };
  });
  audit(a.id, "sponsor.view", null, roundId, null, `payer ${payerId}`);
  return { round, payer: { id: payer.id, name: payer.name }, counts: { total: rows.length, resultsComplete: complete, released, pending: rows.length - released, readiness }, people };
}
