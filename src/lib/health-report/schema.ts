// Health check-up report — schema + seed (owner 2026-11-25). Additive and idempotent: new tables only, nothing existing is
// altered. The catalogue is copied into the database once (by item code); after that the database is the truth, so a
// reference range or wording the owner edits is never overwritten at the next boot. Rollback:
// docs/migrations/health-report-pr1-rollback.sql.
import type Database from "better-sqlite3";
import { EXTRA_TESTS, ITEMS, SECTIONS } from "./catalog";

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
  })();
}
