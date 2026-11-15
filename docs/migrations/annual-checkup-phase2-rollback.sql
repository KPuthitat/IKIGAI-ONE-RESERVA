-- Rollback — annual health check-up programme, phase 2 (schema + triggers + catalogue)
-- Run manually against data/reserva.db ONLY if you need to undo phase 2.
--
--   sqlite3 data/reserva.db < docs/migrations/annual-checkup-phase2-rollback.sql
--
-- ⚠️ This destroys every check-up round, order, result, revision, audit row and grant. Back up data/reserva.db first.
-- ⚠️ Also remove the ensureAnnualCheckupSchema(db) call in src/lib/db.ts (and redeploy) or the tables come back at the next boot.
-- Order matters: triggers first (they forbid deleting results / revisions / audit / grants), then children → parents.

DROP TRIGGER IF EXISTS annual_checkup_results_ins;
DROP TRIGGER IF EXISTS annual_checkup_results_upd;
DROP TRIGGER IF EXISTS annual_checkup_results_del;
DROP TRIGGER IF EXISTS annual_checkup_revisions_ins;
DROP TRIGGER IF EXISTS annual_checkup_revisions_upd;
DROP TRIGGER IF EXISTS annual_checkup_revisions_del;
DROP TRIGGER IF EXISTS annual_checkup_audit_upd;
DROP TRIGGER IF EXISTS annual_checkup_audit_del;
DROP TRIGGER IF EXISTS annual_checkup_grants_ins;
DROP TRIGGER IF EXISTS annual_checkup_grants_upd;
DROP TRIGGER IF EXISTS annual_checkup_grants_del;
DROP TRIGGER IF EXISTS annual_checkup_concl_ins;
DROP TRIGGER IF EXISTS annual_checkup_concl_upd;
DROP TRIGGER IF EXISTS annual_checkup_order_clinical_ins;
DROP TRIGGER IF EXISTS annual_checkup_order_clinical_upd;
DROP TRIGGER IF EXISTS annual_checkup_orders_upd;
DROP TRIGGER IF EXISTS annual_checkup_orders_del;

DROP TABLE IF EXISTS annual_checkup_consents;
DROP TABLE IF EXISTS annual_checkup_consent_versions;
DROP TABLE IF EXISTS annual_checkup_grants;
DROP TABLE IF EXISTS annual_checkup_audit;
DROP TABLE IF EXISTS annual_checkup_conclusions;
DROP TABLE IF EXISTS annual_checkup_result_revisions;
DROP TABLE IF EXISTS annual_checkup_results;
DROP TABLE IF EXISTS annual_checkup_order_clinical;
DROP TABLE IF EXISTS annual_checkup_orders;
DROP TABLE IF EXISTS annual_checkup_externals;
DROP TABLE IF EXISTS annual_checkup_program_tests;
DROP TABLE IF EXISTS annual_checkup_programs;
DROP TABLE IF EXISTS annual_checkup_payers;
DROP TABLE IF EXISTS annual_checkup_test_refs;
DROP TABLE IF EXISTS annual_checkup_tests;
DROP TABLE IF EXISTS annual_checkup_rounds;

-- users / system_settings columns. Needs SQLite >= 3.35 for DROP COLUMN (better-sqlite3 11 bundles a newer SQLite). If your
-- build rejects it, leave the columns: they default to 0 / NULL and do nothing without the tables.
ALTER TABLE users DROP COLUMN health_result_recorder;
ALTER TABLE users DROP COLUMN health_result_approver;
ALTER TABLE system_settings DROP COLUMN annual_checkup_clinic_company_id;
