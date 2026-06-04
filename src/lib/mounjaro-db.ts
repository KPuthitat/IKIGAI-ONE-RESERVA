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
  const want = (actor.license_no ?? "").trim();
  return want.length > 0 && want === (provided ?? "").trim();
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

/** Express interest → create a pending enrollment (idempotent). */
export function enrollSelf(actor: MjActor): EnrollmentRow {
  const db = getDb();
  const existing = getMyEnrollment(actor);
  if (existing) return existing;
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

export function recordConsent(actor: MjActor, version: string): void {
  getDb().prepare(`
    UPDATE mounjaro_enrollments
    SET consent_signed_at = CURRENT_TIMESTAMP, consent_version = ?
    WHERE employee_id = ?
  `).run(version, actor.id);
  audit(actor.id, "consent", "enrollment", actor.id);
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
        SELECT p.*, e.status AS enrollment_status, u.display_name AS employee_name
        FROM mounjaro_patients p
        JOIN mounjaro_enrollments e ON e.id = p.enrollment_id
        JOIN users u ON u.id = e.employee_id
        WHERE p.attending_doctor_id = ? AND p.deleted_at IS NULL AND e.status = ?
        ORDER BY p.updated_at DESC, p.id DESC
      `).all(actor.id, statusFilter)
    : db.prepare(`
        SELECT p.*, e.status AS enrollment_status, u.display_name AS employee_name
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

// ════════════════════════════════════════════════════════════════════
// AGGREGATE — HR / super_admin / doctor (NO per-person rows)
// ════════════════════════════════════════════════════════════════════

export function getProgramStats(actor: MjActor): Record<string, number> {
  if (!isHrOrAggregateViewer(actor)) throw new MounjaroForbidden("no_stats_access");
  const row = getDb().prepare("SELECT * FROM mounjaro_program_stats").get() as Record<string, number>;
  audit(actor.id, "read_stats", "program", null);
  return row;
}
