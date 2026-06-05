// Mounjaro Employee Wellness — clinical data access gateway.
//
// SQLite has no row-level security, so THIS MODULE is the single choke
// point for every read/write of Mounjaro clinical data. Rules (locked in
// docs/mounjaro-integration-plan.md §14):
//
//   • employee   → only their own rows (scoped by enrollment.employee_id)
//   • doctor     → only patients where attending_doctor_id = self
//                  (the license number is the unlock gate, verified in the
//                   route layer like a PIN — see verifyClinicalLicense)
//   • nurse      → NO clinical view in this phase
//   • super_admin / HR → aggregate stats only, NEVER raw clinical rows
//
// EVERY function takes the acting user as its first argument and scopes
// the query to that actor — there is no "read by arbitrary id" path for
// employees, and doctor reads are filtered by attending_doctor_id at the
// SQL level. Every clinical read/write writes an audit row.
//
// ⚠️  Do NOT query mounjaro_* tables anywhere else. All access goes here.

import { getDb } from "./db";
import { computeAlerts, type Alert } from "./mounjaro-alerts";
import { nameWithPrefix } from "./name";

function pj<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Build the safety-alert input from a patient row + their visits and run
 *  the rules. Shared by the clinical list (badge) and detail (full list). */
export function patientAlerts(
  patient: Record<string, unknown>, visits: Array<Record<string, unknown>>
): Alert[] {
  const baseline = pj<Record<string, number>>(patient.baseline_json, {});
  const contra = pj<Record<string, boolean>>(patient.contraindications_json, {});
  const meds = pj<Record<string, boolean>>(patient.medications_json, {});
  const sorted = [...visits].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = sorted[sorted.length - 1];
  if (!last) {
    // No visit yet — only the static contraindication danger applies.
    return computeAlerts({
      baselineHr: null, baselineWeight: baseline.weight ?? null, lastWeight: null,
      currentDose: null, hr: null, abdomen: 0, vomit: 0, tachy: 0, hypoCount: 0,
      adherence: null, decision: null,
      hasContraindication: !!(contra.mtc || contra.men2 || contra.preg || contra.allergy),
      onInsulinOrSu: !!(meds.insulin || meds.su), weeksAtCurrentDose: 0, visitCount: 0
    });
  }
  const se = pj<Record<string, number>>(last.side_effects_json, {});
  const curDose = (last.dose as number | null) ?? null;
  // weeks at current dose = since the start of the trailing run at this dose
  let firstAtDose = last.date as string | null;
  for (let k = sorted.length - 1; k >= 0; k--) {
    if ((sorted[k].dose as number | null) === curDose) firstAtDose = sorted[k].date as string;
    else break;
  }
  const weeks = firstAtDose
    ? Math.max(0, Math.round((Date.now() - new Date(`${firstAtDose}T00:00:00Z`).getTime()) / (7 * 86400_000)))
    : 0;
  return computeAlerts({
    baselineHr: baseline.hr ?? null, baselineWeight: baseline.weight ?? null,
    lastWeight: (last.weight as number | null) ?? null, currentDose: curDose,
    hr: (last.hr as number | null) ?? null,
    abdomen: se.abdomen ?? 0, vomit: se.vomit ?? 0, tachy: se.tachy ?? 0,
    hypoCount: (last.hypo_count as number | null) ?? 0,
    adherence: (last.adherence as AlertAdherence) ?? null,
    decision: (last.decision as AlertDecision) ?? null,
    hasContraindication: !!(contra.mtc || contra.men2 || contra.preg || contra.allergy),
    onInsulinOrSu: !!(meds.insulin || meds.su),
    weeksAtCurrentDose: weeks, visitCount: sorted.length
  });
}
type AlertAdherence = "full" | "missed1" | "missed2" | "held" | null;
type AlertDecision = "maintain" | "increase" | "decrease" | "hold" | null;

export type MjActor = {
  id: number;
  role: "super_admin" | "admin" | "staff";
  clinical_role?: "doctor" | "nurse" | null;
  license_no?: string | null;
  is_hr_analytics?: number;
};

/** Thrown when an actor tries to reach data outside their scope. Routes
 *  map this to HTTP 403. */
export class MounjaroForbidden extends Error {
  constructor(msg = "forbidden") { super(msg); this.name = "MounjaroForbidden"; }
}
export function isMounjaroForbidden(e: unknown): e is MounjaroForbidden {
  return e instanceof MounjaroForbidden;
}

const isDoctor = (a: MjActor) => a.clinical_role === "doctor";
const isHrOrAggregateViewer = (a: MjActor) =>
  a.is_hr_analytics === 1 || a.role === "super_admin" || isDoctor(a);

/** Audit every clinical access. Best-effort — never blocks the action. */
function audit(
  actorId: number, action: string, resourceType: string,
  resourceId: number | null, ip?: string | null
): void {
  try {
    getDb().prepare(`
      INSERT INTO mounjaro_audit_log (user_id, action, resource_type, resource_id, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).run(actorId, action, resourceType, resourceId ?? null, ip ?? null);
  } catch { /* audit must not break the request */ }
}

// ── Doctor unlock gate ──────────────────────────────────────────────
/** The license number the doctor types must match their account. Used by
 *  routes before serving clinical data (presence-proof like a PIN). The
 *  data scoping below is independent + always enforced. */
export function verifyClinicalLicense(actor: MjActor, provided: string): boolean {
  if (!isDoctor(actor)) return false;
  // Compare digits only — the stored value is the ว. number, but the
  // doctor may type "ว.12345", "ว. 12345" or "12345" at the unlock gate.
  const want = (actor.license_no ?? "").replace(/\D/g, "");
  return want.length > 0 && want === (provided ?? "").replace(/\D/g, "");
}

// ════════════════════════════════════════════════════════════════════
// EMPLOYEE — own data only (scoped by enrollment.employee_id = actor.id)
// ════════════════════════════════════════════════════════════════════

type EnrollmentRow = {
  id: number; employee_id: number; status: string;
  enrolled_at: string | null; completed_at: string | null;
  consent_signed_at: string | null; consent_version: string | null;
  withdrawn_reason: string | null; portal_erased_at: string | null;
};

/** The actor's OWN enrollment, or null. There is deliberately no
 *  "get enrollment by id" for employees. */
export function getMyEnrollment(actor: MjActor): EnrollmentRow | null {
  const row = getDb().prepare(
    "SELECT * FROM mounjaro_enrollments WHERE employee_id = ? AND portal_erased_at IS NULL"
  ).get(actor.id) as EnrollmentRow | undefined;
  return row ?? null;
}

/** Express interest → create a pending enrollment. Re-joining is allowed
 *  (owner 2026-06-05): if a withdrawn / completed / portal-erased
 *  enrollment exists, reopen it as 'pending' instead of failing on the
 *  UNIQUE(employee_id) constraint. An already active/pending enrollment
 *  is returned unchanged (idempotent). */
export function enrollSelf(actor: MjActor): EnrollmentRow {
  const db = getDb();
  // Look up ANY row (incl. portal-erased) — one enrollment per employee.
  const any = db.prepare(
    "SELECT * FROM mounjaro_enrollments WHERE employee_id = ?"
  ).get(actor.id) as EnrollmentRow | undefined;
  if (any) {
    if (any.status === "active" || any.status === "pending") {
      return getMyEnrollment(actor) ?? any;
    }
    // withdrawn / completed → reopen for the doctor to re-screen. Clear
    // the erase flag so a "left then changed my mind" employee comes
    // back to their own (retained) record.
    db.prepare(`
      UPDATE mounjaro_enrollments
      SET status = 'pending', withdrawn_reason = NULL,
          portal_erased_at = NULL, enrolled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(any.id);
    audit(actor.id, "enroll", "enrollment", actor.id);
    return getMyEnrollment(actor)!;
  }
  db.prepare(
    "INSERT INTO mounjaro_enrollments (employee_id, status, enrolled_at) VALUES (?, 'pending', CURRENT_TIMESTAMP)"
  ).run(actor.id);
  audit(actor.id, "enroll", "enrollment", actor.id);
  return getMyEnrollment(actor)!;
}

/** Withdraw / cancel — keeps the record visible (status='withdrawn') so the
 *  employee still sees their summary. PDPA erase (eraseMyData) is separate. */
export function withdrawSelf(actor: MjActor, reason: string | null): void {
  getDb().prepare(`
    UPDATE mounjaro_enrollments
    SET status = 'withdrawn', withdrawn_reason = ?
    WHERE employee_id = ? AND portal_erased_at IS NULL
  `).run(reason ?? null, actor.id);
  audit(actor.id, "withdraw", "enrollment", actor.id);
}

/** The current active consent text + version (super_admin maintained). */
export function getActiveConsent(): { version: string; body: string } | null {
  const row = getDb().prepare(
    "SELECT version, body FROM mounjaro_consent_versions WHERE active = 1 ORDER BY id DESC LIMIT 1"
  ).get() as { version: string; body: string } | undefined;
  return row ?? null;
}

export function recordConsent(actor: MjActor, version: string): void {
  getDb().prepare(`
    UPDATE mounjaro_enrollments
    SET consent_signed_at = CURRENT_TIMESTAMP, consent_version = ?
    WHERE employee_id = ?
  `).run(version, actor.id);
  audit(actor.id, "consent", "enrollment", actor.id);
}

/** Super_admin maintenance of the PDPA consent text.
 *  - asNewVersion=false → fix the active text in place (typo/wording),
 *    no re-consent forced.
 *  - asNewVersion=true  → publish a NEW version (vN+1) and make it active;
 *    every active enrollment whose consent_version differs is then
 *    re-prompted (see needsConsent in the self-service page).
 *  Returns the resulting version label. */
export function setMounjaroConsent(body: string, asNewVersion: boolean): { version: string } {
  const db = getDb();
  const active = db.prepare(
    "SELECT id, version FROM mounjaro_consent_versions WHERE active = 1 ORDER BY id DESC LIMIT 1"
  ).get() as { id: number; version: string } | undefined;
  if (asNewVersion || !active) {
    const n = (db.prepare(
      "SELECT COUNT(*) AS c FROM mounjaro_consent_versions"
    ).get() as { c: number }).c;
    const version = `v${n + 1}`;
    const tx = db.transaction(() => {
      db.prepare("UPDATE mounjaro_consent_versions SET active = 0 WHERE active = 1").run();
      db.prepare(
        "INSERT INTO mounjaro_consent_versions (version, body, active) VALUES (?, ?, 1)"
      ).run(version, body);
    });
    tx();
    return { version };
  }
  db.prepare("UPDATE mounjaro_consent_versions SET body = ? WHERE id = ?").run(body, active.id);
  return { version: active.version };
}

/** The actor's OWN clinical summary (patient + visits), read-only. Joins
 *  through their enrollment so another employee's row can never surface. */
export function getMyClinical(actor: MjActor): {
  patient: Record<string, unknown> | null;
  visits: Array<Record<string, unknown>>;
} {
  const db = getDb();
  const enr = getMyEnrollment(actor);
  if (!enr) return { patient: null, visits: [] };
  const patient = db.prepare(`
    SELECT * FROM mounjaro_patients
    WHERE enrollment_id = ? AND deleted_at IS NULL
  `).get(enr.id) as Record<string, unknown> | undefined;
  if (!patient) { audit(actor.id, "read_own", "patient", enr.id); return { patient: null, visits: [] }; }
  const visits = db.prepare(
    "SELECT * FROM mounjaro_visits WHERE patient_id = ? ORDER BY date DESC, id DESC"
  ).all(patient.id as number) as Array<Record<string, unknown>>;
  audit(actor.id, "read_own", "patient", patient.id as number);
  return { patient, visits };
}

export function addSelfLog(actor: MjActor, data: {
  date: string; weight: number | null; injection_done: boolean;
  side_effect_diary: unknown; notes_for_doctor: string | null;
}): void {
  const enr = getMyEnrollment(actor);
  if (!enr || enr.status !== "active") throw new MounjaroForbidden("not_active");
  getDb().prepare(`
    INSERT INTO mounjaro_self_logs
      (enrollment_id, date, weight, injection_done, side_effect_diary_json,
       notes_for_doctor, logged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    enr.id, data.date, data.weight,
    data.injection_done ? 1 : 0,
    JSON.stringify(data.side_effect_diary ?? {}),
    data.notes_for_doctor ?? null, actor.id
  );
  audit(actor.id, "self_log", "enrollment", enr.id);
}

export function getMySelfLogs(actor: MjActor): Array<Record<string, unknown>> {
  const enr = getMyEnrollment(actor);
  if (!enr) return [];
  return getDb().prepare(
    "SELECT * FROM mounjaro_self_logs WHERE enrollment_id = ? ORDER BY date DESC, id DESC"
  ).all(enr.id) as Array<Record<string, unknown>>;
}

/** PDPA right-to-access — everything we hold about the actor. */
export function exportMyData(actor: MjActor): Record<string, unknown> {
  const enr = getMyEnrollment(actor);
  const clinical = getMyClinical(actor);
  audit(actor.id, "export", "enrollment", enr?.id ?? null);
  return {
    enrollment: enr,
    patient: clinical.patient,
    visits: clinical.visits,
    self_logs: getMySelfLogs(actor),
    exported_at: new Date().toISOString()
  };
}

/** PDPA right-to-erasure (portal side). Soft-delete: withdraws + hides
 *  from the portal. The medical record (mounjaro_patients/visits) is
 *  retained under the clinic's lawful basis and only flagged. */
export function eraseMyData(actor: MjActor): void {
  const db = getDb();
  const enr = getMyEnrollment(actor);
  if (!enr) return;
  db.prepare(`
    UPDATE mounjaro_enrollments
    SET status = 'withdrawn', portal_erased_at = CURRENT_TIMESTAMP,
        withdrawn_reason = COALESCE(withdrawn_reason, 'pdpa_erasure')
    WHERE id = ?
  `).run(enr.id);
  audit(actor.id, "erase", "enrollment", enr.id);
}

/** Who has viewed the actor's own data. */
export function getMyAuditTrail(actor: MjActor): Array<Record<string, unknown>> {
  const enr = getMyEnrollment(actor);
  const patient = enr ? getDb().prepare(
    "SELECT id FROM mounjaro_patients WHERE enrollment_id = ?"
  ).get(enr.id) as { id: number } | undefined : undefined;
  return getDb().prepare(`
    SELECT a.action, a.resource_type, a.resource_id, a.created_at,
           u.display_name AS by_name
    FROM mounjaro_audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE (a.resource_type = 'enrollment' AND a.resource_id = ?)
       OR (a.resource_type = 'patient'    AND a.resource_id = ?)
    ORDER BY a.created_at DESC LIMIT 200
  `).all(enr?.id ?? -1, patient?.id ?? -1) as Array<Record<string, unknown>>;
}

// ════════════════════════════════════════════════════════════════════
// DOCTOR — only their OWN patients (attending_doctor_id = actor.id)
// ════════════════════════════════════════════════════════════════════

function requireDoctor(actor: MjActor): void {
  if (!isDoctor(actor)) throw new MounjaroForbidden("not_a_doctor");
}

/** Patients whose attending doctor is this actor. Nurses / HR / super_admin
 *  get a hard Forbidden — there is no "all patients" query here. */
export function listMyPatients(actor: MjActor, statusFilter?: string): Array<Record<string, unknown>> {
  requireDoctor(actor);
  const db = getDb();
  const rows = (statusFilter
    ? db.prepare(`
        SELECT p.*, e.status AS enrollment_status, u.display_name AS employee_name, u.title_prefix AS employee_title_prefix
        FROM mounjaro_patients p
        JOIN mounjaro_enrollments e ON e.id = p.enrollment_id
        JOIN users u ON u.id = e.employee_id
        WHERE p.attending_doctor_id = ? AND p.deleted_at IS NULL AND e.status = ?
        ORDER BY p.updated_at DESC, p.id DESC
      `).all(actor.id, statusFilter)
    : db.prepare(`
        SELECT p.*, e.status AS enrollment_status, u.display_name AS employee_name, u.title_prefix AS employee_title_prefix
        FROM mounjaro_patients p
        JOIN mounjaro_enrollments e ON e.id = p.enrollment_id
        JOIN users u ON u.id = e.employee_id
        WHERE p.attending_doctor_id = ? AND p.deleted_at IS NULL
        ORDER BY p.updated_at DESC, p.id DESC
      `).all(actor.id)) as Array<Record<string, unknown>>;
  audit(actor.id, "list_patients", "patient", null);
  return rows;
}

/** One patient — ONLY if this doctor is the attending doctor. Returns
 *  null otherwise (no leak of existence). */
export function getPatientForDoctor(actor: MjActor, patientId: number): Record<string, unknown> | null {
  requireDoctor(actor);
  const row = getDb().prepare(`
    SELECT * FROM mounjaro_patients
    WHERE id = ? AND attending_doctor_id = ? AND deleted_at IS NULL
  `).get(patientId, actor.id) as Record<string, unknown> | undefined;
  audit(actor.id, "read_patient", "patient", patientId);
  return row ?? null;
}

/** Create the clinical record for a pending enrollment + take the patient
 *  on as the attending doctor + flip the enrollment to active. */
export function createPatientRecord(actor: MjActor, enrollmentId: number, data: {
  hn: string | null; baseline: unknown; comorbidities: unknown;
  contraindications: unknown; medications: unknown;
  notes: string | null; start_date: string | null;
}): number {
  requireDoctor(actor);
  const db = getDb();
  const enr = db.prepare(
    "SELECT id, status FROM mounjaro_enrollments WHERE id = ?"
  ).get(enrollmentId) as { id: number; status: string } | undefined;
  if (!enr) throw new MounjaroForbidden("enrollment_not_found");
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO mounjaro_patients
        (enrollment_id, attending_doctor_id, hn, baseline_json, comorbidities_json,
         contraindications_json, medications_json, notes, start_date, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      enrollmentId, actor.id, data.hn ?? null,
      JSON.stringify(data.baseline ?? {}), JSON.stringify(data.comorbidities ?? {}),
      JSON.stringify(data.contraindications ?? {}), JSON.stringify(data.medications ?? {}),
      data.notes ?? null, data.start_date ?? null, actor.id
    );
    db.prepare(
      "UPDATE mounjaro_enrollments SET status = 'active' WHERE id = ?"
    ).run(enrollmentId);
    return Number(info.lastInsertRowid);
  });
  const id = tx();
  audit(actor.id, "create_patient", "patient", id);
  return id;
}

/** Edit an existing patient's baseline / demographics / flags. Scoped to
 *  the attending doctor + audited. (Powers the "แก้ไข" on the baseline tab.) */
export function updatePatientRecord(actor: MjActor, patientId: number, data: {
  hn: string | null; baseline: unknown; comorbidities: unknown;
  contraindications: unknown; medications: unknown;
  notes: string | null; start_date: string | null;
}): void {
  requireDoctor(actor);
  const p = getPatientForDoctor(actor, patientId); // attending-doctor scope
  if (!p) throw new MounjaroForbidden("not_attending");
  getDb().prepare(`
    UPDATE mounjaro_patients
       SET hn = ?, baseline_json = ?, comorbidities_json = ?,
           contraindications_json = ?, medications_json = ?, notes = ?,
           start_date = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND attending_doctor_id = ?
  `).run(
    data.hn ?? null,
    JSON.stringify(data.baseline ?? {}), JSON.stringify(data.comorbidities ?? {}),
    JSON.stringify(data.contraindications ?? {}), JSON.stringify(data.medications ?? {}),
    data.notes ?? null, data.start_date ?? null, patientId, actor.id
  );
  audit(actor.id, "update_patient", "patient", patientId);
}

/** Soft-delete a patient record (deleted_at). PDPA: the clinical record is
 *  retained under lawful basis — it's hidden from the doctor's list but not
 *  destroyed. Scoped to the attending doctor + audited. */
export function softDeletePatient(actor: MjActor, patientId: number): void {
  requireDoctor(actor);
  const p = getPatientForDoctor(actor, patientId);
  if (!p) throw new MounjaroForbidden("not_attending");
  getDb().prepare(
    "UPDATE mounjaro_patients SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND attending_doctor_id = ?"
  ).run(patientId, actor.id);
  audit(actor.id, "delete_patient", "patient", patientId);
}

/** Delete a single visit row — only on the doctor's own patient + audited. */
export function deleteVisit(actor: MjActor, visitId: number): void {
  requireDoctor(actor);
  const owns = getDb().prepare(`
    SELECT v.id FROM mounjaro_visits v
    JOIN mounjaro_patients p ON p.id = v.patient_id
    WHERE v.id = ? AND p.attending_doctor_id = ? AND p.deleted_at IS NULL
  `).get(visitId, actor.id);
  if (!owns) throw new MounjaroForbidden("not_your_patient");
  getDb().prepare("DELETE FROM mounjaro_visits WHERE id = ?").run(visitId);
  audit(actor.id, "delete_visit", "visit", visitId);
}

export function addVisit(actor: MjActor, patientId: number, data: Record<string, unknown>): number {
  requireDoctor(actor);
  // attending-doctor scope: the patient must be theirs
  const p = getPatientForDoctor(actor, patientId);
  if (!p) throw new MounjaroForbidden("not_attending");
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO mounjaro_visits
      (patient_id, date, dose, weight, bp, hr, hba1c, fbs, waist,
       side_effects_json, hypo_count, adherence, decision, next_visit, notes, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    patientId, data.date ?? null, data.dose ?? null, data.weight ?? null,
    data.bp ?? null, data.hr ?? null, data.hba1c ?? null, data.fbs ?? null, data.waist ?? null,
    JSON.stringify(data.side_effects ?? {}), data.hypo_count ?? null,
    data.adherence ?? null, data.decision ?? null, data.next_visit ?? null,
    data.notes ?? null, actor.id
  );
  audit(actor.id, "add_visit", "visit", Number(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}

/** Doctor's patient list enriched for the dashboard — one audited call.
 *  Computes alert level, latest weight, % loss, week #, next visit. */
export function listMyPatientsEnriched(actor: MjActor): Array<{
  id: number; employee_name: string; hn: string | null; enrollment_status: string;
  dose: number | null; latestWeight: number | null; lossPct: number | null;
  weekNo: number; nextVisit: string | null; alertLevel: "danger" | "warning" | null;
  newSelfLog: boolean;
}> {
  const patients = listMyPatients(actor); // requires doctor + audits once
  const db = getDb();
  return patients.map((p) => {
    const pid = p.id as number;
    const visits = db.prepare(
      "SELECT * FROM mounjaro_visits WHERE patient_id = ? ORDER BY date ASC, id ASC"
    ).all(pid) as Array<Record<string, unknown>>;
    const alerts = patientAlerts(p, visits);
    const baseline = pj<Record<string, number>>(p.baseline_json, {});
    const last = visits[visits.length - 1];
    const latestWeight = (last?.weight as number | null) ?? null;
    const lossPct = (baseline.weight && latestWeight)
      ? ((baseline.weight - latestWeight) / baseline.weight) * 100 : null;
    const newSelfLog = !!(db.prepare(
      "SELECT 1 FROM mounjaro_self_logs WHERE enrollment_id = ? AND doctor_reply IS NULL LIMIT 1"
    ).get(p.enrollment_id as number));
    // Weeks since the drug start date (matches the tracker's "สัปดาห์ที่").
    const startStr = p.start_date as string | null;
    const weekNo = startStr
      ? Math.max(0, Math.floor((Date.now() - new Date(startStr).getTime()) / (7 * 86_400_000)))
      : 0;
    return {
      id: pid,
      employee_name: nameWithPrefix(
        (p.employee_title_prefix as string | null) ?? null, p.employee_name as string
      ),
      hn: (p.hn as string | null) ?? null,
      enrollment_status: (p.enrollment_status as string) ?? "active",
      dose: (last?.dose as number | null) ?? null, latestWeight, lossPct,
      weekNo, nextVisit: (last?.next_visit as string | null) ?? null,
      alertLevel: alerts.some((a) => a.level === "danger") ? "danger"
        : alerts.some((a) => a.level === "warning") ? "warning" : null,
      newSelfLog
    };
  });
}

/** Pending enrollments awaiting intake — name + date only, NO clinical
 *  data (there is none yet). Any doctor may pick one up via baseline. */
export function listPendingIntake(actor: MjActor): Array<{
  enrollment_id: number; employee_name: string; enrolled_at: string | null;
  // Prefill (2026-06-04): pull what we already know about the employee so
  // the doctor's intake form starts filled in; doctor adds the rest.
  gender: string | null; dob: string | null; phone: string | null;
  height_cm: number | null; weight_kg: number | null;
}> {
  requireDoctor(actor);
  const rows = getDb().prepare(`
    SELECT e.id AS enrollment_id, u.display_name AS employee_name, e.enrolled_at,
           u.gender, u.dob, u.mobile_phone AS phone, u.height_cm, u.weight_kg
    FROM mounjaro_enrollments e JOIN users u ON u.id = e.employee_id
    WHERE e.status = 'pending' AND e.portal_erased_at IS NULL
    ORDER BY e.enrolled_at ASC
  `).all() as Array<{
    enrollment_id: number; employee_name: string; enrolled_at: string | null;
    gender: string | null; dob: string | null; phone: string | null;
    height_cm: number | null; weight_kg: number | null;
  }>;
  audit(actor.id, "list_intake", "enrollment", null);
  return rows;
}

/** Full bundle for ONE of the doctor's own patients (patient + visits +
 *  self-logs). null when the doctor is not the attending doctor. */
export function getPatientBundle(actor: MjActor, patientId: number): {
  patient: Record<string, unknown>; employeeName: string; enrollmentId: number;
  visits: Array<Record<string, unknown>>; selfLogs: Array<Record<string, unknown>>;
} | null {
  requireDoctor(actor);
  const patient = getDb().prepare(`
    SELECT p.*, u.display_name AS employee_name, u.title_prefix AS employee_title_prefix, e.id AS enrollment_id
    FROM mounjaro_patients p
    JOIN mounjaro_enrollments e ON e.id = p.enrollment_id
    JOIN users u ON u.id = e.employee_id
    WHERE p.id = ? AND p.attending_doctor_id = ? AND p.deleted_at IS NULL
  `).get(patientId, actor.id) as Record<string, unknown> | undefined;
  audit(actor.id, "read_patient", "patient", patientId);
  if (!patient) return null;
  const enrollmentId = patient.enrollment_id as number;
  const visits = getDb().prepare(
    "SELECT * FROM mounjaro_visits WHERE patient_id = ? ORDER BY date ASC, id ASC"
  ).all(patientId) as Array<Record<string, unknown>>;
  const selfLogs = getDb().prepare(
    "SELECT * FROM mounjaro_self_logs WHERE enrollment_id = ? ORDER BY date DESC, id DESC"
  ).all(enrollmentId) as Array<Record<string, unknown>>;
  return {
    patient,
    employeeName: nameWithPrefix(
      (patient.employee_title_prefix as string | null) ?? null, patient.employee_name as string
    ),
    enrollmentId, visits, selfLogs
  };
}

/** Doctor replies to a self-log — only on their own patient's log. */
export function replySelfLog(actor: MjActor, selfLogId: number, reply: string): void {
  requireDoctor(actor);
  const owns = getDb().prepare(`
    SELECT sl.id FROM mounjaro_self_logs sl
    JOIN mounjaro_patients p ON p.enrollment_id = sl.enrollment_id
    WHERE sl.id = ? AND p.attending_doctor_id = ?
  `).get(selfLogId, actor.id);
  if (!owns) throw new MounjaroForbidden("not_your_patient");
  getDb().prepare(`
    UPDATE mounjaro_self_logs
    SET doctor_reply = ?, replied_by = ?, replied_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reply, actor.id, selfLogId);
  audit(actor.id, "reply_selflog", "self_log", selfLogId);
}

// ════════════════════════════════════════════════════════════════════
// AGGREGATE — HR / super_admin / doctor (NO per-person rows)
// ════════════════════════════════════════════════════════════════════

export function getProgramStats(actor: MjActor): Record<string, number> {
  if (!isHrOrAggregateViewer(actor)) throw new MounjaroForbidden("no_stats_access");
  const row = getDb().prepare("SELECT * FROM mounjaro_program_stats").get() as Record<string, number>;
  audit(actor.id, "read_stats", "program", null);
  return row;
}
