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
           MAX(c.id) AS concl_id, MAX(c.released_at) AS concl_released, MAX(sb.id) AS sub_id
      FROM annual_checkup_orders o
      LEFT JOIN users u ON u.id = o.user_id LEFT JOIN annual_checkup_externals e ON e.id = o.external_id
      LEFT JOIN annual_checkup_payers p ON p.id = o.payer_id LEFT JOIN annual_checkup_payers ep ON ep.id = e.payer_id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
      LEFT JOIN annual_checkup_conclusions c ON c.round_id = o.round_id AND ((o.user_id IS NOT NULL AND c.user_id = o.user_id) OR (o.external_id IS NOT NULL AND c.external_id = o.external_id))
      LEFT JOIN annual_checkup_submissions sb ON sb.round_id = o.round_id AND ((o.user_id IS NOT NULL AND sb.user_id = o.user_id) OR (o.external_id IS NOT NULL AND sb.external_id = o.external_id))
     WHERE o.round_id = ? GROUP BY o.user_id, o.external_id
  `).all(roundId) as Array<{ user_id: number | null; external_id: number | null; display_name: string | null; title_prefix: string | null; employee_code: string | null;
    full_name: string | null; sort_no: number | null; payer: string; required: number; recorded: number; verified: number; released: number; concl_id: number | null; concl_released: string | null; sub_id: number | null }>;
  const subjects: SubjectRow[] = rows.map((r) => ({
    key: r.user_id != null ? `u${r.user_id}` : `e${r.external_id}`, kind: (r.user_id != null ? "employee" : "external") as SubjectRow["kind"],
    label: r.user_id != null ? nameWithPrefix(r.title_prefix, r.display_name ?? "") : externalLabel(r.full_name, r.sort_no, r.payer),
    code: r.employee_code, payer: r.payer, required: r.required, recorded: r.recorded, verified: r.verified, released: r.released,
    hasConclusion: r.concl_id != null, conclusionReleased: !!r.concl_released, submitted: r.sub_id != null
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
    audit(a.id, "result.submit", subjectCols(subject), roundId, null);
  })());
  const at = (db.prepare(`SELECT submitted_at FROM annual_checkup_submissions WHERE round_id = ? AND ${col} = ?`).get(roundId, id) as { submitted_at: string }).submitted_at;
  return { submitted_at: at, awaiting: countAwaitingDoctor(roundId) };
}

/** How many people the doctor still has to look at: sent by a recorder and at least one required result still a draft. A count, nothing else. */
export function countAwaitingDoctor(roundId: number): number {
  return (getDb().prepare(`
    SELECT COUNT(*) n FROM annual_checkup_submissions sb
     WHERE sb.round_id = ? AND EXISTS (
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
