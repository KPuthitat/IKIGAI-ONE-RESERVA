// Annual health check-up programme — schema (phase 2, docs/annual-checkup-plan.md).
//
// SQLite has no row-level security, so isolation has two layers (plan §4):
//   • the gateway src/lib/annual-checkup-db.ts decides who may READ (the only module that touches the result tables);
//   • the triggers below are the part the DATABASE itself enforces for WRITES: a result can only be recorded by a staff member
//     of the clinic branch holding the recorder flag, only be verified / released by a clinic doctor holding the approver flag,
//     is locked once verified (a revision snapshot is the only way to change it), and revisions / audit / grants are append-only.
//
// Everything is additive and idempotent (CREATE ... IF NOT EXISTS, PRAGMA-guarded ADD COLUMN). Triggers are dropped and
// recreated on every boot so their definition always matches this file. Rollback: docs/migrations/annual-checkup-phase2-rollback.sql.
import type Database from "better-sqlite3";

/** The clinic branch is identified by its slug, never by its (editable) name. */
export const CLINIC_BRANCH_SLUG = "at-home-clinic";

/**
 * SQL boolean fragments over a user-id expression (`col`, e.g. "NEW.recorded_by" or "@id"). The gateway evaluates exactly these
 * same fragments, so the app check and the trigger check cannot drift apart.
 */
const activeUser = (col: string) =>
  `EXISTS (SELECT 1 FROM users u WHERE u.id = ${col} AND u.status NOT IN ('disabled','resigned','terminated'))`;

const clinicMember = (col: string) => `EXISTS (
    SELECT 1 FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
     WHERE ub.user_id = ${col} AND b.slug = '${CLINIC_BRANCH_SLUG}'
       AND ((SELECT annual_checkup_clinic_company_id FROM system_settings WHERE id = 1) IS NULL
            OR b.company_id = (SELECT annual_checkup_clinic_company_id FROM system_settings WHERE id = 1)))`;

/** May record results: active, flagged recorder or approver, and on the clinic branch roster right now. */
export const recorderOk = (col: string) => `(${activeUser(col)}
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${col} AND (u.health_result_recorder = 1 OR u.health_result_approver = 1))
  AND ${clinicMember(col)})`;

/** May verify / release: all of the above through the approver flag, plus a clinic doctor with a licence number on file. */
export const approverOk = (col: string) => `(${activeUser(col)}
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${col} AND u.health_result_approver = 1 AND u.clinical_role = 'doctor' AND COALESCE(TRIM(u.license_no), '') <> '')
  AND ${clinicMember(col)})`;

const abort = (cond: string, msg: string) => `SELECT CASE WHEN ${cond} THEN RAISE(ABORT, '${msg}') END;`;

const VALUE_COLS = ["value_num", "value_text", "value_json", "unit", "ref_text", "interpretation", "file_path", "file_mime"];
const valuesChanged = VALUE_COLS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");

// The 20 tests of the 2026 programme (xlsx "รายการตรวจรายบุคคล", columns F–Y). Units and reference ranges are NOT seeded:
// they depend on which laboratory's ranges are used (open question Q4 in the plan) and are set later in the catalogue screen.
const TESTS: Array<[code: string, th: string, en: string, kind: "number" | "text" | "panel"]> = [
  ["PHYSICAL", "ตรวจร่างกายโดยแพทย์ วัดสัญญาณชีพ น้ำหนัก ส่วนสูง", "Physical examination (vital signs, weight, height)", "panel"],
  ["CXR", "เอกซเรย์ทรวงอก", "Chest X-ray", "text"],
  ["CBC", "ความสมบูรณ์ของเลือด", "Complete blood count (CBC)", "panel"],
  ["URINE", "ตรวจปัสสาวะ", "Urinalysis", "panel"],
  ["BUN", "การทำงานของไต (Blood Urea Nitrogen)", "Blood urea nitrogen (BUN)", "number"],
  ["CREAT", "การทำงานของไต (Creatinine)", "Creatinine", "number"],
  ["SGOT", "การทำงานของตับ (SGOT)", "SGOT (AST)", "number"],
  ["SGPT", "การทำงานของตับ (SGPT)", "SGPT (ALT)", "number"],
  ["CHOL", "ไขมัน (Cholesterol)", "Cholesterol", "number"],
  ["TG", "ไขมัน (Triglycerides)", "Triglycerides", "number"],
  ["HDL", "ไขมันชนิดดี (HDL)", "HDL cholesterol", "number"],
  ["LDL", "ไขมันชนิดไม่ดี (LDL)", "LDL cholesterol", "number"],
  ["GLUCOSE", "น้ำตาลในเลือด", "Blood glucose", "number"],
  ["URIC", "กรดยูริคในเลือด", "Uric acid", "number"],
  ["HAV", "ไวรัสตับอักเสบเอ (Anti HAV)", "Hepatitis A antibody (Anti-HAV)", "text"],
  ["SPIRO", "สมรรถภาพปอด", "Spirometry (lung function)", "text"],
  ["AUDIO", "สมรรถภาพการได้ยิน", "Audiometry (hearing)", "text"],
  ["EYE", "ตาอาชีวอนามัย", "Occupational eye examination", "text"],
  ["HBSAG", "ไวรัสตับอักเสบบี (HBsAg)", "Hepatitis B surface antigen (HBsAg)", "text"],
  ["STOOL", "อุจจาระเพาะเชื้อ", "Stool culture", "text"]
];

// First guess of the stations (owner confirms / edits in the stations screen): code, Thai name, the tests (by code) done there.
const STATIONS: Array<[code: string, th: string, tests: string[]]> = [
  ["PHYSICAL", "ตรวจร่างกายโดยแพทย์", ["PHYSICAL"]],
  ["BLOOD", "เจาะเลือด", ["CBC", "BUN", "CREAT", "SGOT", "SGPT", "CHOL", "TG", "HDL", "LDL", "GLUCOSE", "URIC", "HAV", "HBSAG"]],
  ["SPECIMEN", "ปัสสาวะและอุจจาระ", ["URINE", "STOOL"]],
  ["XRAY", "เอกซเรย์ทรวงอก", ["CXR"]],
  ["FUNCTION", "สมรรถภาพปอด การได้ยิน และสายตา", ["SPIRO", "AUDIO", "EYE"]]
];

export function ensureAnnualCheckupSchema(db: Database.Database): void {
  const hasCol = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);

  // Capability flags on users (super_admin grants; same pattern as can_view_payroll / is_hr_analytics).
  if (!hasCol("users", "health_result_recorder")) db.exec("ALTER TABLE users ADD COLUMN health_result_recorder INTEGER NOT NULL DEFAULT 0");
  if (!hasCol("users", "health_result_approver")) db.exec("ALTER TABLE users ADD COLUMN health_result_approver INTEGER NOT NULL DEFAULT 0");
  // Optional second lock on the clinic: when set, the clinic branch must also belong to this company. NULL = branch slug only.
  if (!hasCol("system_settings", "annual_checkup_clinic_company_id")) db.exec("ALTER TABLE system_settings ADD COLUMN annual_checkup_clinic_company_id INTEGER");

  db.exec(`
    CREATE TABLE IF NOT EXISTS annual_checkup_rounds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      year_be     INTEGER,
      start_date  TEXT,
      end_date    TEXT,
      location    TEXT,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Catalogue of tests, reused every year. Units / reference ranges are filled in later (see plan Q4).
    CREATE TABLE IF NOT EXISTS annual_checkup_tests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL UNIQUE,
      name_th     TEXT NOT NULL,
      name_en     TEXT,
      unit        TEXT,
      value_kind  TEXT NOT NULL DEFAULT 'text' CHECK (value_kind IN ('number','text','panel')),
      params_json TEXT,
      sort_no     INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS annual_checkup_test_refs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id   INTEGER NOT NULL REFERENCES annual_checkup_tests(id) ON DELETE CASCADE,
      sex       TEXT NOT NULL DEFAULT 'A' CHECK (sex IN ('M','F','A')),
      low       REAL,
      high      REAL,
      ref_text  TEXT,
      source    TEXT
    );

    -- Who pays, per round. A company in our own companies table, or free text for an outside company.
    CREATE TABLE IF NOT EXISTS annual_checkup_payers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER NOT NULL REFERENCES annual_checkup_rounds(id) ON DELETE CASCADE,
      company_id  INTEGER REFERENCES companies(id),
      name_th     TEXT NOT NULL,
      is_external INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS annual_checkup_programs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id  INTEGER NOT NULL REFERENCES annual_checkup_rounds(id) ON DELETE CASCADE,
      payer_id  INTEGER NOT NULL REFERENCES annual_checkup_payers(id) ON DELETE CASCADE,
      name      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annual_checkup_program_tests (
      program_id INTEGER NOT NULL REFERENCES annual_checkup_programs(id) ON DELETE CASCADE,
      test_id    INTEGER NOT NULL REFERENCES annual_checkup_tests(id),
      scope      TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','selected')),
      PRIMARY KEY (program_id, test_id)
    );

    -- People taking part who have no account (an outside company's staff). A placeholder row has no name yet.
    CREATE TABLE IF NOT EXISTS annual_checkup_externals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id       INTEGER NOT NULL REFERENCES annual_checkup_rounds(id) ON DELETE CASCADE,
      payer_id       INTEGER NOT NULL REFERENCES annual_checkup_payers(id),
      full_name      TEXT,
      is_placeholder INTEGER NOT NULL DEFAULT 0,
      sex            TEXT CHECK (sex IS NULL OR sex IN ('M','F')),
      dob            TEXT,
      sort_no        INTEGER NOT NULL DEFAULT 0
    );

    -- One row per person per test. NOTE: no reason / medical column here — HR-readable by design (plan §3).
    CREATE TABLE IF NOT EXISTS annual_checkup_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id     INTEGER REFERENCES users(id),
      external_id INTEGER REFERENCES annual_checkup_externals(id),
      payer_id    INTEGER REFERENCES annual_checkup_payers(id),
      test_id     INTEGER NOT NULL REFERENCES annual_checkup_tests(id),
      status      TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','waived','external_lab')),
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    -- NULL never equals NULL in a UNIQUE, so one partial unique index per kind of subject.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_orders_user
      ON annual_checkup_orders(round_id, user_id, test_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_orders_ext
      ON annual_checkup_orders(round_id, external_id, test_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_orders_round ON annual_checkup_orders(round_id, user_id);

    -- The medical reason for waiving a test, and the outside lab's name. Read only through the clinical gateway functions.
    CREATE TABLE IF NOT EXISTS annual_checkup_order_clinical (
      order_id          INTEGER PRIMARY KEY REFERENCES annual_checkup_orders(id),
      waive_reason      TEXT,
      external_lab_name TEXT,
      set_by            INTEGER NOT NULL REFERENCES users(id),
      set_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- The current version of each result. Revisions live in annual_checkup_result_revisions.
    CREATE TABLE IF NOT EXISTS annual_checkup_results (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id       INTEGER NOT NULL UNIQUE REFERENCES annual_checkup_orders(id),
      revision       INTEGER NOT NULL DEFAULT 1,
      status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','released')),
      value_num      REAL,
      value_text     TEXT,
      value_json     TEXT,
      unit           TEXT,
      ref_text       TEXT,
      interpretation TEXT CHECK (interpretation IS NULL OR interpretation IN ('normal','abnormal','follow_up')),
      file_path      TEXT,
      file_mime      TEXT,
      recorded_by    INTEGER NOT NULL REFERENCES users(id),
      recorded_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verified_by    INTEGER REFERENCES users(id),
      verified_at    TEXT,
      released_by    INTEGER REFERENCES users(id),
      released_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS annual_checkup_result_revisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      result_id     INTEGER NOT NULL REFERENCES annual_checkup_results(id),
      revision      INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason        TEXT NOT NULL,
      revised_by    INTEGER NOT NULL REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (result_id, revision)
    );

    -- The doctor's summary per person per round.
    CREATE TABLE IF NOT EXISTS annual_checkup_conclusions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id       INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id        INTEGER REFERENCES users(id),
      external_id    INTEGER REFERENCES annual_checkup_externals(id),
      summary        TEXT CHECK (summary IS NULL OR summary IN ('normal','abnormal','follow_up')),
      doctor_comment TEXT,
      verified_by    INTEGER NOT NULL REFERENCES users(id),
      verified_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_by    INTEGER REFERENCES users(id),
      released_at    TEXT,
      notified_at    TEXT,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_concl_user
      ON annual_checkup_conclusions(round_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_concl_ext
      ON annual_checkup_conclusions(round_id, external_id) WHERE external_id IS NOT NULL;

    -- Who did what to whose result. Append-only (triggers below).
    CREATE TABLE IF NOT EXISTS annual_checkup_audit (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id            INTEGER NOT NULL,
      action              TEXT NOT NULL,
      subject_user_id     INTEGER,
      subject_external_id INTEGER,
      round_id            INTEGER,
      order_id            INTEGER,
      detail              TEXT,
      ip                  TEXT,
      created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_audit_subject ON annual_checkup_audit(subject_user_id, created_at);

    -- Granting / revoking the two capabilities. Append-only; only a super_admin may write a row.
    CREATE TABLE IF NOT EXISTS annual_checkup_grants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      capability TEXT NOT NULL CHECK (capability IN ('recorder','approver')),
      action     TEXT NOT NULL CHECK (action IN ('grant','revoke')),
      by_user_id INTEGER NOT NULL REFERENCES users(id),
      reason     TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- PDPA consent for viewing results (text kept by super_admin; same pattern as the Mounjaro consent).
    CREATE TABLE IF NOT EXISTS annual_checkup_consent_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      version    TEXT NOT NULL,
      body       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS annual_checkup_consents (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      version   TEXT NOT NULL,
      signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip        TEXT
    );

    -- Queue number + QR check-in on the day (phase 6). Holds NO health data: a place in the line, an appointment time and when the
    -- person arrived. What they are being tested for is read from annual_checkup_orders when a screen needs it, never copied here.
    -- The token is the ONLY thing a QR code carries (128 random bits; no name, no employee code).
    CREATE TABLE IF NOT EXISTS annual_checkup_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id      INTEGER NOT NULL REFERENCES annual_checkup_rounds(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id),
      external_id   INTEGER REFERENCES annual_checkup_externals(id),
      queue_no      INTEGER NOT NULL CHECK (queue_no > 0),
      appt_time     TEXT,
      checkin_token TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
      checked_in_at TEXT,
      checked_in_by INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL)),
      CHECK ((checked_in_at IS NULL AND checked_in_by IS NULL) OR (checked_in_at IS NOT NULL AND checked_in_by IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_queue_no   ON annual_checkup_queue(round_id, queue_no);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_queue_user ON annual_checkup_queue(round_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_queue_ext  ON annual_checkup_queue(round_id, external_id) WHERE external_id IS NOT NULL;
  `);
  // Default appointment time of the day (HH:MM); a person's own appt_time overrides it. The date is the round's start_date.
  if (!hasCol("annual_checkup_rounds", "appt_time")) db.exec("ALTER TABLE annual_checkup_rounds ADD COLUMN appt_time TEXT");

  // ── Stations, sample-kit numbers, and "sent to the doctor" (phase 7) ──
  db.exec(`
    -- A station is a place on the day (blood draw, X-ray, ...). Each test belongs to one station; a person's route is the stations of the
    -- tests they are ordered (waived tests never count). The catalogue is editable by the owner / a recorder.
    CREATE TABLE IF NOT EXISTS annual_checkup_stations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      code    TEXT NOT NULL UNIQUE,
      name_th TEXT NOT NULL,
      sort_no INTEGER NOT NULL DEFAULT 0,
      active  INTEGER NOT NULL DEFAULT 1
    );
    -- "Passed this station": staff at the station scan the person's QR. Append-only; only for someone already checked in.
    CREATE TABLE IF NOT EXISTS annual_checkup_station_passes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id   INTEGER NOT NULL REFERENCES annual_checkup_queue(id),
      station_id INTEGER NOT NULL REFERENCES annual_checkup_stations(id),
      passed_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      passed_by  INTEGER NOT NULL REFERENCES users(id),
      UNIQUE (queue_id, station_id)
    );
    -- The recorder hands a person's finished drafts to the doctor. No health data here: only that, and when.
    CREATE TABLE IF NOT EXISTS annual_checkup_submissions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id     INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id      INTEGER REFERENCES users(id),
      external_id  INTEGER REFERENCES annual_checkup_externals(id),
      submitted_by INTEGER NOT NULL REFERENCES users(id),
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_sub_user ON annual_checkup_submissions(round_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_sub_ext  ON annual_checkup_submissions(round_id, external_id) WHERE external_id IS NOT NULL;
  `);
  if (!hasCol("annual_checkup_tests", "station_id")) db.exec("ALTER TABLE annual_checkup_tests ADD COLUMN station_id INTEGER REFERENCES annual_checkup_stations(id)");
  if (!hasCol("annual_checkup_queue", "kit_no")) db.exec("ALTER TABLE annual_checkup_queue ADD COLUMN kit_no TEXT");
  if (!hasCol("annual_checkup_queue", "kit_set_by")) db.exec("ALTER TABLE annual_checkup_queue ADD COLUMN kit_set_by INTEGER REFERENCES users(id)");
  if (!hasCol("annual_checkup_queue", "kit_set_at")) db.exec("ALTER TABLE annual_checkup_queue ADD COLUMN kit_set_at TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_queue_kit ON annual_checkup_queue(round_id, kit_no) WHERE kit_no IS NOT NULL");

  // ── Triggers: what the database itself refuses. Recreated each boot so the definitions always match this file. ──
  const triggers: Array<[name: string, sql: string]> = [
    ["annual_checkup_results_ins", `
      CREATE TRIGGER annual_checkup_results_ins BEFORE INSERT ON annual_checkup_results
      BEGIN
        ${abort(`NOT ${recorderOk("NEW.recorded_by")}`, "annual_checkup: recorder not eligible (clinic staff with the recorder flag only)")}
        ${abort("NEW.status <> 'draft' OR NEW.revision <> 1", "annual_checkup: a new result starts as draft revision 1")}
        ${abort("(SELECT status FROM annual_checkup_orders WHERE id = NEW.order_id) = 'waived'", "annual_checkup: a waived test cannot have a result")}
      END;`],
    ["annual_checkup_results_upd", `
      CREATE TRIGGER annual_checkup_results_upd BEFORE UPDATE ON annual_checkup_results
      BEGIN
        ${abort("NEW.order_id <> OLD.order_id", "annual_checkup: a result cannot be moved to another order")}
        -- once verified / released the values are locked; the only way through is a revision (snapshot taken, revision + 1, back to draft)
        ${abort(`OLD.status IN ('verified','released') AND (${valuesChanged})
                 AND NOT (NEW.revision = OLD.revision + 1 AND NEW.status = 'draft'
                          AND EXISTS (SELECT 1 FROM annual_checkup_result_revisions r WHERE r.result_id = OLD.id AND r.revision = OLD.revision))`,
        "annual_checkup: result is locked, make a revision")}
        ${abort(`(${valuesChanged}) AND NOT ${recorderOk("NEW.recorded_by")}`, "annual_checkup: recorder not eligible (clinic staff with the recorder flag only)")}
        ${abort("NEW.revision <> OLD.revision AND NOT (OLD.status IN ('verified','released') AND NEW.status = 'draft' AND NEW.revision = OLD.revision + 1)", "annual_checkup: the revision number only moves with a revision")}
        ${abort("NEW.status = OLD.status AND (NEW.verified_by IS NOT OLD.verified_by OR NEW.verified_at IS NOT OLD.verified_at OR NEW.released_by IS NOT OLD.released_by OR NEW.released_at IS NOT OLD.released_at)", "annual_checkup: signatures change only with the status")}
        -- status moves: draft -> verified (approver), verified -> released (approver), verified/released -> draft only as a revision
        ${abort(`NEW.status <> OLD.status AND NOT (
                   (OLD.status = 'draft' AND NEW.status = 'verified' AND NEW.verified_by IS NOT NULL AND ${approverOk("NEW.verified_by")})
                OR (OLD.status = 'verified' AND NEW.status = 'released' AND NEW.released_by IS NOT NULL AND ${approverOk("NEW.released_by")})
                OR (OLD.status IN ('verified','released') AND NEW.status = 'draft' AND NEW.revision = OLD.revision + 1))`,
        "annual_checkup: status change not allowed (approver doctor only, in order)")}
      END;`],
    ["annual_checkup_results_del", `
      CREATE TRIGGER annual_checkup_results_del BEFORE DELETE ON annual_checkup_results
      BEGIN ${abort("1", "annual_checkup: results are never deleted")} END;`],
    ["annual_checkup_revisions_ins", `
      CREATE TRIGGER annual_checkup_revisions_ins BEFORE INSERT ON annual_checkup_result_revisions
      BEGIN ${abort(`NOT ${recorderOk("NEW.revised_by")}`, "annual_checkup: recorder not eligible (clinic staff with the recorder flag only)")} END;`],
    ["annual_checkup_revisions_upd", `
      CREATE TRIGGER annual_checkup_revisions_upd BEFORE UPDATE ON annual_checkup_result_revisions
      BEGIN ${abort("1", "annual_checkup: revisions are append-only")} END;`],
    ["annual_checkup_revisions_del", `
      CREATE TRIGGER annual_checkup_revisions_del BEFORE DELETE ON annual_checkup_result_revisions
      BEGIN ${abort("1", "annual_checkup: revisions are append-only")} END;`],
    ["annual_checkup_audit_upd", `
      CREATE TRIGGER annual_checkup_audit_upd BEFORE UPDATE ON annual_checkup_audit
      BEGIN ${abort("1", "annual_checkup: audit is append-only")} END;`],
    ["annual_checkup_audit_del", `
      CREATE TRIGGER annual_checkup_audit_del BEFORE DELETE ON annual_checkup_audit
      BEGIN ${abort("1", "annual_checkup: audit is append-only")} END;`],
    ["annual_checkup_grants_ins", `
      CREATE TRIGGER annual_checkup_grants_ins BEFORE INSERT ON annual_checkup_grants
      BEGIN
        ${abort(`NOT (${activeUser("NEW.by_user_id")} AND EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.by_user_id AND u.role = 'super_admin'))`, "annual_checkup: only a super_admin may grant or revoke")}
        ${abort(`NEW.action = 'grant' AND NOT (${activeUser("NEW.user_id")} AND ${clinicMember("NEW.user_id")})`, "annual_checkup: only clinic staff can be granted")}
        ${abort(`NEW.action = 'grant' AND NEW.capability = 'approver' AND NOT EXISTS (
                   SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.clinical_role = 'doctor' AND COALESCE(TRIM(u.license_no), '') <> '')`, "annual_checkup: the approver must be a doctor with a licence number")}
      END;`],
    ["annual_checkup_grants_upd", `
      CREATE TRIGGER annual_checkup_grants_upd BEFORE UPDATE ON annual_checkup_grants
      BEGIN ${abort("1", "annual_checkup: grants are append-only")} END;`],
    ["annual_checkup_grants_del", `
      CREATE TRIGGER annual_checkup_grants_del BEFORE DELETE ON annual_checkup_grants
      BEGIN ${abort("1", "annual_checkup: grants are append-only")} END;`],
    ["annual_checkup_concl_ins", `
      CREATE TRIGGER annual_checkup_concl_ins BEFORE INSERT ON annual_checkup_conclusions
      BEGIN
        ${abort(`NOT ${approverOk("NEW.verified_by")}`, "annual_checkup: only an approver doctor writes the conclusion")}
        ${abort(`NEW.released_at IS NOT NULL AND (NEW.released_by IS NULL OR NOT ${approverOk("NEW.released_by")})`, "annual_checkup: only an approver doctor releases")}
      END;`],
    ["annual_checkup_concl_upd", `
      CREATE TRIGGER annual_checkup_concl_upd BEFORE UPDATE ON annual_checkup_conclusions
      BEGIN
        -- the cron that stamps notified_at must keep working even if the doctor has since left, so only content changes need an approver
        ${abort(`(NEW.summary IS NOT OLD.summary OR NEW.doctor_comment IS NOT OLD.doctor_comment OR NEW.verified_by IS NOT OLD.verified_by) AND NOT ${approverOk("NEW.verified_by")}`, "annual_checkup: only an approver doctor writes the conclusion")}
        ${abort(`NEW.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at AND (NEW.released_by IS NULL OR NOT ${approverOk("NEW.released_by")})`, "annual_checkup: only an approver doctor releases")}
        ${abort("OLD.released_at IS NOT NULL AND (NEW.released_at IS NULL OR NEW.summary IS NOT OLD.summary OR NEW.doctor_comment IS NOT OLD.doctor_comment)", "annual_checkup: a released conclusion is locked")}
      END;`],
    ["annual_checkup_order_clinical_ins", `
      CREATE TRIGGER annual_checkup_order_clinical_ins BEFORE INSERT ON annual_checkup_order_clinical
      BEGIN ${abort(`NOT ${recorderOk("NEW.set_by")}`, "annual_checkup: recorder not eligible (clinic staff with the recorder flag only)")} END;`],
    ["annual_checkup_order_clinical_upd", `
      CREATE TRIGGER annual_checkup_order_clinical_upd BEFORE UPDATE ON annual_checkup_order_clinical
      BEGIN ${abort(`NOT ${recorderOk("NEW.set_by")}`, "annual_checkup: recorder not eligible (clinic staff with the recorder flag only)")} END;`],
    ["annual_checkup_queue_ins", `
      CREATE TRIGGER annual_checkup_queue_ins BEFORE INSERT ON annual_checkup_queue
      BEGIN ${abort("NEW.checked_in_by IS NOT NULL", "annual_checkup: a queue row starts not checked in")} END;`],
    ["annual_checkup_queue_upd", `
      CREATE TRIGGER annual_checkup_queue_upd BEFORE UPDATE ON annual_checkup_queue
      BEGIN
        ${abort("NEW.checkin_token IS NOT OLD.checkin_token OR NEW.round_id IS NOT OLD.round_id OR NEW.user_id IS NOT OLD.user_id OR NEW.external_id IS NOT OLD.external_id", "annual_checkup: the token, round and person of a queue row never change")}
        -- checking in is the one write clinic staff make; it needs a live eligible recorder and can never be undone or re-stamped
        ${abort(`NEW.checked_in_by IS NOT NULL AND OLD.checked_in_by IS NULL AND NOT ${recorderOk("NEW.checked_in_by")}`, "annual_checkup: only clinic staff with the recorder flag may check people in")}
        ${abort("OLD.checked_in_at IS NOT NULL AND (NEW.checked_in_at IS NOT OLD.checked_in_at OR NEW.checked_in_by IS NOT OLD.checked_in_by)", "annual_checkup: a check-in cannot be changed or undone")}
        -- the sample-kit number is linked by clinic staff only (a live eligible recorder), whoever and whenever
        ${abort(`NEW.kit_no IS NOT OLD.kit_no AND (NEW.kit_set_by IS NULL OR NOT ${recorderOk("NEW.kit_set_by")})`, "annual_checkup: only clinic staff with the recorder flag may link a kit number")}
      END;`],
    ["annual_checkup_station_passes_ins", `
      CREATE TRIGGER annual_checkup_station_passes_ins BEFORE INSERT ON annual_checkup_station_passes
      BEGIN
        ${abort(`NOT ${recorderOk("NEW.passed_by")}`, "annual_checkup: only clinic staff with the recorder flag may mark a station passed")}
        ${abort("(SELECT checked_in_at FROM annual_checkup_queue WHERE id = NEW.queue_id) IS NULL", "annual_checkup: a person who has not checked in cannot pass a station")}
      END;`],
    ["annual_checkup_station_passes_upd", `
      CREATE TRIGGER annual_checkup_station_passes_upd BEFORE UPDATE ON annual_checkup_station_passes
      BEGIN ${abort("1", "annual_checkup: station passes are append-only")} END;`],
    ["annual_checkup_station_passes_del", `
      CREATE TRIGGER annual_checkup_station_passes_del BEFORE DELETE ON annual_checkup_station_passes
      BEGIN ${abort("1", "annual_checkup: station passes are append-only")} END;`],
    ["annual_checkup_submissions_ins", `
      CREATE TRIGGER annual_checkup_submissions_ins BEFORE INSERT ON annual_checkup_submissions
      BEGIN ${abort(`NOT ${recorderOk("NEW.submitted_by")}`, "annual_checkup: only clinic staff with the recorder flag may send results to the doctor")} END;`],
    ["annual_checkup_submissions_upd", `
      CREATE TRIGGER annual_checkup_submissions_upd BEFORE UPDATE ON annual_checkup_submissions
      BEGIN ${abort(`NEW.submitted_by IS NOT OLD.submitted_by AND NOT ${recorderOk("NEW.submitted_by")}`, "annual_checkup: only clinic staff with the recorder flag may send results to the doctor")} END;`],
    ["annual_checkup_submissions_del", `
      CREATE TRIGGER annual_checkup_submissions_del BEFORE DELETE ON annual_checkup_submissions
      BEGIN ${abort("1", "annual_checkup: submissions are never deleted")} END;`],
    ["annual_checkup_queue_del", `
      CREATE TRIGGER annual_checkup_queue_del BEFORE DELETE ON annual_checkup_queue
      BEGIN ${abort("OLD.checked_in_at IS NOT NULL", "annual_checkup: a checked-in queue row cannot be removed")} END;`],
    ["annual_checkup_orders_upd", `
      CREATE TRIGGER annual_checkup_orders_upd BEFORE UPDATE ON annual_checkup_orders
      BEGIN ${abort("NEW.status = 'waived' AND EXISTS (SELECT 1 FROM annual_checkup_results WHERE order_id = OLD.id)", "annual_checkup: a test that has a result cannot be waived")} END;`],
    ["annual_checkup_orders_del", `
      CREATE TRIGGER annual_checkup_orders_del BEFORE DELETE ON annual_checkup_orders
      BEGIN ${abort("EXISTS (SELECT 1 FROM annual_checkup_results WHERE order_id = OLD.id)", "annual_checkup: a test that has a result cannot be removed")} END;`]
  ];
  for (const [name, sql] of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    db.exec(sql);
  }

  // Seed the catalogue (idempotent by code; never overwrites units / ranges someone has since filled in).
  const ins = db.prepare("INSERT OR IGNORE INTO annual_checkup_tests (code, name_th, name_en, value_kind, sort_no) VALUES (?,?,?,?,?)");
  TESTS.forEach(([code, th, en, kind], i) => ins.run(code, th, en, kind, i + 1));

  // Seed the stations and a first guess of which test sits at which station (owner edits it afterwards; a mapping someone set is never overwritten).
  const insSt = db.prepare("INSERT OR IGNORE INTO annual_checkup_stations (code, name_th, sort_no) VALUES (?,?,?)");
  STATIONS.forEach(([code, th], i) => insSt.run(code, th, i + 1));
  const mapSt = db.prepare("UPDATE annual_checkup_tests SET station_id = (SELECT id FROM annual_checkup_stations WHERE code = ?) WHERE code = ? AND station_id IS NULL");
  for (const [stCode, , tests] of STATIONS) for (const t of tests) mapSt.run(stCode, t);
}
