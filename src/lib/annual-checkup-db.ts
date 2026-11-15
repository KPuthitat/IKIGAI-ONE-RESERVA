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

export type AcActor = { id: number };
export type AcSubject = { userId: number; externalId?: undefined } | { externalId: number; userId?: undefined };
export type Capability = "recorder" | "approver";
export type Interpretation = "normal" | "abnormal" | "follow_up";

export class AnnualCheckupForbidden extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); this.name = "AnnualCheckupForbidden"; }
}
export class AnnualCheckupInvalid extends Error {
  constructor(public code: string) { super(code); this.name = "AnnualCheckupInvalid"; }
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
    if (o.status === "external_lab" && !v.file_path) throw new AnnualCheckupInvalid("external_lab_needs_file");
    const cur = db.prepare("SELECT id, status FROM annual_checkup_results WHERE order_id = ?").get(orderId) as { id: number; status: string } | undefined;
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
               interpretation=@interpretation, file_path=@file_path, file_mime=@file_mime, recorded_by=@by, recorded_at=CURRENT_TIMESTAMP
         WHERE id=@id
      `).run({ id, ...v, by: a.id });
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
  results: Array<Record<string, unknown>>; conclusion: Record<string, unknown> | null;
} {
  const a = requireRecorder(actor);
  const db = getDb();
  const col = subject.userId != null ? "o.user_id" : "o.external_id";
  const id = subject.userId ?? subject.externalId;
  const results = db.prepare(`
    SELECT o.id AS order_id, o.status AS order_status, t.code, t.name_th, t.name_en, t.unit AS test_unit,
           oc.waive_reason, oc.external_lab_name,
           r.id AS result_id, r.revision, r.status AS result_status, r.value_num, r.value_text, r.value_json, r.unit, r.ref_text,
           r.interpretation, r.file_path, r.recorded_by, r.recorded_at, r.verified_by, r.verified_at, r.released_at
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
      LEFT JOIN annual_checkup_order_clinical oc ON oc.order_id = o.id
      LEFT JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND ${col} = ? ORDER BY t.sort_no
  `).all(roundId, id) as Array<Record<string, unknown>>;
  const ccol = subject.userId != null ? "user_id" : "external_id";
  const conclusion = (db.prepare(`SELECT summary, doctor_comment, verified_by, verified_at, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND ${ccol} = ?`)
    .get(roundId, id) as Record<string, unknown> | undefined) ?? null;
  audit(a.id, "subject.view", subjectCols(subject), roundId, null);
  return { results, conclusion };
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
  const results = db.prepare(`
    SELECT t.code, t.name_th, t.name_en, r.value_num, r.value_text, r.value_json, r.unit, r.ref_text, r.interpretation, r.file_path, r.released_at
      FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id
      JOIN annual_checkup_results r ON r.order_id = o.id
     WHERE o.round_id = ? AND o.user_id = ? AND r.status = 'released' ORDER BY t.sort_no
  `).all(roundId, a.id) as Array<Record<string, unknown>>;
  const conclusion = (db.prepare("SELECT summary, doctor_comment, released_at FROM annual_checkup_conclusions WHERE round_id = ? AND user_id = ? AND released_at IS NOT NULL")
    .get(roundId, a.id) as { summary: string | null; doctor_comment: string | null; released_at: string } | undefined) ?? null;
  audit(a.id, "self.view", { user_id: a.id, external_id: null }, roundId, null);
  return { results, conclusion };
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
