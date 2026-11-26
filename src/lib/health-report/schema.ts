// Health check-up report — schema + seed (owner 2026-11-25). Additive and idempotent: new tables only, nothing existing is
// altered. The catalogue is copied into the database once (by item code); after that the database is the truth, so a
// reference range or wording the owner edits is never overwritten at the next boot. Rollback:
// docs/migrations/health-report-pr1-rollback.sql.
import type Database from "better-sqlite3";
import { EXTRA_TESTS, ITEMS, SECTIONS } from "./catalog";
import { approverOk, CLINIC_BRANCH_SLUG } from "../annual-checkup-schema";
import { EDU, ITEM_EXPLAIN, SECTION_INTRO } from "./explanations";

export function ensureHealthReportSchema(db: Database.Database): void {
  db.exec(`
    -- One reportable value of the booklet (WBC, Neutrophil, 500 Hz right ear …). The orderable test it belongs to is test_code.
    CREATE TABLE IF NOT EXISTS annual_checkup_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      test_code     TEXT NOT NULL,
      section       TEXT NOT NULL,
      name_en       TEXT NOT NULL,
      desc_th       TEXT NOT NULL,
      unit          TEXT,
      kind          TEXT NOT NULL CHECK (kind IN ('number','choice','text','file')),
      choices_json  TEXT,
      normal_json   TEXT,                 -- JSON array of the normal choices, or the string "any" (informative only)
      ref_text      TEXT,                 -- the reference text as printed in the booklet
      plausible_min REAL,
      plausible_max REAL,
      decimals      INTEGER,
      computed      TEXT CHECK (computed IS NULL OR computed IN ('bmi','globulin','indirect_bili')),
      hidden        INTEGER NOT NULL DEFAULT 0,   -- never printed in the booklet (HIV)
      restricted    INTEGER NOT NULL DEFAULT 0,   -- doctor and the person only (drug screen, HIV)
      needs_check   INTEGER NOT NULL DEFAULT 0,   -- value or wording to be confirmed by the doctor
      sort_no       INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_items_section ON annual_checkup_items(section, sort_no);

    -- Reference ranges by sex and age band. The row that fits the person best is used (a sex-specific, age-banded row first).
    CREATE TABLE IF NOT EXISTS annual_checkup_item_refs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id   INTEGER NOT NULL REFERENCES annual_checkup_items(id) ON DELETE CASCADE,
      sex       TEXT NOT NULL DEFAULT 'A' CHECK (sex IN ('M','F','A')),
      age_min   INTEGER,
      age_max   INTEGER,
      low       REAL,
      high      REAL,
      low_incl  INTEGER NOT NULL DEFAULT 1,
      high_incl INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_item_refs_item ON annual_checkup_item_refs(item_id);

    -- Editable explanation texts ("what is this test?") — changed in the settings screen, not in code.
    CREATE TABLE IF NOT EXISTS annual_checkup_explanations (
      key        TEXT PRIMARY KEY,         -- an item code, a section key, or a named block
      title_th   TEXT,
      title_en   TEXT,
      body_th    TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- The code a laboratory gives a person in a round (AHC69-0001, TSR69-0004). It identifies a row in the laboratory's Excel;
    -- it carries no health data. One code → one person in the round, and a person has one code.
    CREATE TABLE IF NOT EXISTS annual_checkup_exam_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER NOT NULL REFERENCES annual_checkup_rounds(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id),
      external_id INTEGER REFERENCES annual_checkup_externals(id),
      exam_code   TEXT NOT NULL,           -- upper case, no spaces, no tube suffix
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_exam_code ON annual_checkup_exam_codes(round_id, exam_code);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_exam_user ON annual_checkup_exam_codes(round_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_exam_ext  ON annual_checkup_exam_codes(round_id, external_id) WHERE external_id IS NOT NULL;

    -- The doctor's wording per section of the booklet ("overall" = the closing summary and recommendation). Clinical text: read and
    -- written only through the gateway; only a clinic approver doctor may write (trigger below).
    CREATE TABLE IF NOT EXISTS annual_checkup_section_notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id            INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id             INTEGER REFERENCES users(id),
      external_id         INTEGER REFERENCES annual_checkup_externals(id),
      section             TEXT NOT NULL,
      summary_text        TEXT,
      recommendation_text TEXT,
      written_by          INTEGER NOT NULL REFERENCES users(id),
      written_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_note_user ON annual_checkup_section_notes(round_id, user_id, section) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_annual_checkup_note_ext  ON annual_checkup_section_notes(round_id, external_id, section) WHERE external_id IS NOT NULL;

    -- The doctor sends a person's results back to the recorder with a note saying what to fix. Open until the recorder sends them again.
    CREATE TABLE IF NOT EXISTS annual_checkup_returns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id     INTEGER REFERENCES users(id),
      external_id INTEGER REFERENCES annual_checkup_externals(id),
      note        TEXT NOT NULL,
      returned_by INTEGER NOT NULL REFERENCES users(id),
      to_user     INTEGER REFERENCES users(id),          -- the recorder who had sent it to the doctor
      returned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      CHECK ((user_id IS NOT NULL AND external_id IS NULL) OR (user_id IS NULL AND external_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_returns_open ON annual_checkup_returns(round_id, resolved_at);

    -- A person whose released results were changed and approved again is told once. Holds no result and no value.
    CREATE TABLE IF NOT EXISTS annual_checkup_revision_notices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id   INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at    TEXT
    );

    -- Ready-made wording the doctor can pick and edit (editable in settings; nothing here is a diagnosis).
    CREATE TABLE IF NOT EXISTS annual_checkup_note_templates (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,                  -- a section key, or "overall"
      kind    TEXT NOT NULL CHECK (kind IN ('summary','recommendation')),
      text    TEXT NOT NULL,
      sort_no INTEGER NOT NULL DEFAULT 0,
      active  INTEGER NOT NULL DEFAULT 1
    );

    -- A link for a person who has no account (an outside company's staff): random, expiring, opened only with the date of birth,
    -- locked for a while after too many wrong tries. Only the hash of the token is kept, so a copy of the database cannot open anyone's results.
    CREATE TABLE IF NOT EXISTS annual_checkup_access_links (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id       INTEGER NOT NULL REFERENCES annual_checkup_rounds(id),
      external_id    INTEGER NOT NULL REFERENCES annual_checkup_externals(id),
      token_hash     TEXT NOT NULL UNIQUE,
      expires_at     TEXT NOT NULL,
      failed_count   INTEGER NOT NULL DEFAULT 0,
      locked_until   TEXT,
      open_count     INTEGER NOT NULL DEFAULT 0,
      last_opened_at TEXT,
      revoked_at     TEXT,
      created_by     INTEGER NOT NULL REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_annual_checkup_links_ext ON annual_checkup_access_links(round_id, external_id);

    -- What an employee agrees to share with HR (PDPA): 'followup' = HR may see that they are on the follow-up list (name + overall verdict, no values);
    -- 'values' = HR may open their released report. Off by default, the employee changes it any time. Gateway-only.
    CREATE TABLE IF NOT EXISTS annual_checkup_share_consents (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      scope      TEXT NOT NULL CHECK (scope IN ('followup','values')),
      granted_at TEXT,
      revoked_at TEXT,
      PRIMARY KEY (user_id, scope)
    );

    -- Identity and contact details of a person from an outside company (health report, external examinees). One row per annual_checkup_externals
    -- row; kept apart from it because it is personal data: read and written only through the gateway (check:risks). Never the full ID number:
    -- only the last 4 characters, enough to confirm who is opening a link. consent_release_to_sponsor is off until the person agrees.
    CREATE TABLE IF NOT EXISTS annual_checkup_external_details (
      external_id                 INTEGER PRIMARY KEY REFERENCES annual_checkup_externals(id) ON DELETE CASCADE,
      title                       TEXT,
      first_name                  TEXT,
      last_name                   TEXT,
      phone                       TEXT,
      email                       TEXT,
      id_last4                    TEXT CHECK (id_last4 IS NULL OR length(id_last4) = 4),
      sponsor_employee_code       TEXT,
      consent_pdpa_at             TEXT,
      consent_release_to_sponsor  INTEGER NOT NULL DEFAULT 0 CHECK (consent_release_to_sponsor IN (0,1)),
      created_by                  INTEGER REFERENCES users(id),
      created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at                  TEXT
    );

    -- The short code a paying company has in examination codes (TSR69-0004 = Transistor Rich, 2569, person 4). Editable; used to make the code of an outside examinee.
    CREATE TABLE IF NOT EXISTS annual_checkup_payer_prefixes (
      payer_name TEXT PRIMARY KEY,
      prefix     TEXT NOT NULL CHECK (prefix GLOB '[A-Z][A-Z][A-Z]*' AND length(prefix) BETWEEN 2 AND 6)
    );

    -- Small settings: critical-value thresholds, the consultation link behind the SCAN ME code, …
    CREATE TABLE IF NOT EXISTS annual_checkup_config (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Orderable tests the report needs that the 2026 programme catalogue does not have (existing tests are left untouched).
  const maxSort = (db.prepare("SELECT COALESCE(MAX(sort_no), 0) AS m FROM annual_checkup_tests").get() as { m: number }).m;
  const addTest = db.prepare("INSERT OR IGNORE INTO annual_checkup_tests (code, name_th, name_en, value_kind, sort_no) VALUES (?, ?, ?, ?, ?)");
  EXTRA_TESTS.forEach(([code, th, en, kind], i) => addTest.run(code, th, en, kind, maxSort + (i + 1) * 10));

  const has = db.prepare("SELECT id FROM annual_checkup_items WHERE code = ?");
  const addItem = db.prepare(`INSERT INTO annual_checkup_items
    (code, test_code, section, name_en, desc_th, unit, kind, choices_json, normal_json, ref_text, plausible_min, plausible_max, decimals, computed, hidden, restricted, needs_check, sort_no)
    VALUES (@code, @test, @section, @en, @th, @unit, @kind, @choices, @normal, @refText, @pmin, @pmax, @decimals, @computed, @hidden, @restricted, @check, @sort)`);
  const addRef = db.prepare("INSERT INTO annual_checkup_item_refs (item_id, sex, age_min, age_max, low, high, low_incl, high_incl) VALUES (?,?,?,?,?,?,?,?)");
  const sectionSort = new Map(SECTIONS.map((s) => [s.key, s.sort]));
  db.transaction(() => {
    ITEMS.forEach((it, i) => {
      if (has.get(it.code)) return;
      const id = Number(addItem.run({
        code: it.code, test: it.test, section: it.section, en: it.en, th: it.th, unit: it.unit ?? null, kind: it.kind,
        choices: it.choices ? JSON.stringify(it.choices) : null, normal: it.normal == null ? null : JSON.stringify(it.normal), refText: it.refText ?? null,
        pmin: it.plausible?.[0] ?? null, pmax: it.plausible?.[1] ?? null, decimals: it.decimals ?? null, computed: it.computed ?? null,
        hidden: it.hidden ? 1 : 0, restricted: it.restricted ? 1 : 0, check: it.check ? 1 : 0, sort: (sectionSort.get(it.section) ?? 0) * 1000 + i
      }).lastInsertRowid);
      for (const r of it.refs ?? []) addRef.run(id, r.sex, r.ageMin ?? null, r.ageMax ?? null, r.low ?? null, r.high ?? null, r.lowIncl === false ? 0 : 1, r.highIncl === false ? 0 : 1);
    });
    db.prepare("INSERT OR IGNORE INTO annual_checkup_config (key, value) VALUES ('critical_enzyme_multiple', '5')").run();
    db.prepare("INSERT OR IGNORE INTO annual_checkup_config (key, value) VALUES ('ldl_calc_mode', '0')").run();
    // Owner 2026-11-25: every reference value follows the sample booklet. Items that were waiting for a doctor's confirmation are confirmed once.
    if (!db.prepare("SELECT 1 FROM annual_checkup_config WHERE key = 'refs_follow_booklet'").get()) {
      db.prepare("UPDATE annual_checkup_items SET needs_check = 0 WHERE needs_check = 1").run();
      db.prepare("INSERT INTO annual_checkup_config (key, value) VALUES ('refs_follow_booklet', '1')").run();
    }
    const pp = db.prepare("INSERT OR IGNORE INTO annual_checkup_payer_prefixes (payer_name, prefix) VALUES (?, ?)");
    pp.run('บริษัท ทรานซิสเตอร์ ริช จำกัด', 'TSR'); pp.run('บริษัท ไพร์ม วัน อาร์คิเทคท์ จำกัด', 'POA');
  })();

  // The booklet's "what is this test?" texts. By key and only when the key is missing, so an edit is never overwritten.
  const ex = db.prepare("INSERT OR IGNORE INTO annual_checkup_explanations (key, title_th, body_th) VALUES (?,?,?)");
  db.transaction(() => {
    for (const [k, v] of Object.entries(SECTION_INTRO)) ex.run(k, v.title, v.body);
    for (const [k, body] of Object.entries(ITEM_EXPLAIN)) ex.run(k, null, body);
    for (const [k, v] of Object.entries(EDU)) ex.run(k, v.title, v.body);
  })();

  // Seed the ready-made wording once (an empty table only), so a later edit or deletion is never undone.
  if ((db.prepare("SELECT COUNT(*) n FROM annual_checkup_note_templates").get() as { n: number }).n === 0) {
    const t = db.prepare("INSERT INTO annual_checkup_note_templates (section, kind, text, sort_no) VALUES (?,?,?,?)");
    db.transaction(() => {
      NOTE_TEMPLATES.forEach(([section, kind, text], i) => t.run(section, kind, text, i));
    })();
  }

  // The database refuses these writes from anyone but a clinic approver doctor, whatever code ran them (same idea as the result triggers).
  const abort = (cond: string, msg: string) => `SELECT CASE WHEN ${cond} THEN RAISE(ABORT, '${msg}') END;`;
  db.exec(`
    DROP TRIGGER IF EXISTS health_report_notes_ins;  DROP TRIGGER IF EXISTS health_report_notes_upd;  DROP TRIGGER IF EXISTS health_report_returns_ins;
    CREATE TRIGGER health_report_notes_ins BEFORE INSERT ON annual_checkup_section_notes BEGIN ${abort(`NOT ${approverOk("NEW.written_by")}`, "health_report: only a clinic approver doctor may write the summary")} END;
    CREATE TRIGGER health_report_notes_upd BEFORE UPDATE ON annual_checkup_section_notes BEGIN ${abort(`NOT ${approverOk("NEW.written_by")}`, "health_report: only a clinic approver doctor may write the summary")} END;
    CREATE TRIGGER health_report_returns_ins BEFORE INSERT ON annual_checkup_returns BEGIN ${abort(`NOT ${approverOk("NEW.returned_by")}`, "health_report: only a clinic approver doctor may send results back")} END;
  `);
  void CLINIC_BRANCH_SLUG;
}

/** Starting wording for the doctor to pick from and edit. Neutral statements only; the doctor decides what applies. */
const NOTE_TEMPLATES: Array<[section: string, kind: "summary" | "recommendation", text: string]> = [
  ["general", "summary", "ตรวจร่างกายอยู่ในเกณฑ์ปกติ"], ["general", "summary", "ดัชนีมวลกายอยู่ในเกณฑ์ปกติ"], ["general", "summary", "น้ำหนักเกินเกณฑ์ ควรควบคุมอาหารและออกกำลังกาย"],
  ["cbc", "summary", "ผลตรวจความสมบูรณ์ของเม็ดเลือดอยู่ในเกณฑ์ปกติ"], ["cbc", "recommendation", "ควรตรวจซ้ำและติดตามผลตามคำแนะนำของแพทย์"],
  ["ua", "summary", "ผลตรวจปัสสาวะอยู่ในเกณฑ์ปกติ"], ["ua", "recommendation", "ดื่มน้ำให้เพียงพอ และตรวจซ้ำหากมีอาการผิดปกติ"],
  ["chem", "summary", "ผลตรวจทางชีวเคมีในเลือดอยู่ในเกณฑ์ปกติ"], ["chem", "recommendation", "ควบคุมอาหาร ออกกำลังกายสม่ำเสมอ และตรวจติดตามประจำปี"],
  ["audio", "summary", "การได้ยินอยู่ในเกณฑ์ปกติ"], ["audio", "recommendation", "หลีกเลี่ยงเสียงดังและใช้อุปกรณ์ป้องกันเสียงเมื่อทำงานในที่เสียงดัง"],
  ["vision", "summary", "สายตาอาชีวอนามัยอยู่ในเกณฑ์ปกติ"], ["vision", "recommendation", "ควรพบจักษุแพทย์เพื่อประเมินเพิ่มเติม"],
  ["pft", "summary", "สมรรถภาพปอดอยู่ในเกณฑ์ปกติ"], ["pft", "recommendation", "งดสูบบุหรี่ และตรวจติดตามสมรรถภาพปอดประจำปี"],
  ["cxr", "summary", "เอกซเรย์ทรวงอกปกติ ไม่พบพยาธิสภาพในปอด"], ["ecg", "summary", "ผลคลื่นไฟฟ้าหัวใจปกติ"],
  ["other", "summary", "ผลตรวจทางห้องปฏิบัติการอื่นๆ อยู่ในเกณฑ์ปกติ"], ["stool", "summary", "ผลตรวจอุจจาระปกติ"],
  ["overall", "summary", "ผลการตรวจสุขภาพโดยรวมอยู่ในเกณฑ์ปกติ"], ["overall", "recommendation", "ดูแลสุขภาพอย่างสม่ำเสมอ และตรวจสุขภาพประจำปีทุกปี"],
  ["overall", "recommendation", "ควรพบแพทย์เพื่อติดตามผลรายการที่ผิดปกติ"]
];
