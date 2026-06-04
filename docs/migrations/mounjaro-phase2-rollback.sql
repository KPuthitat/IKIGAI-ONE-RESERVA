-- Rollback — Mounjaro Wellness phase 2 (clinical schema + access flags)
-- Run manually against data/reserva.db ONLY if you need to undo phase 2.
-- Order matters (children → parents). Tables use ON DELETE CASCADE, but we
-- drop explicitly so nothing is left dangling.
--
--   sqlite3 data/reserva.db < docs/migrations/mounjaro-phase2-rollback.sql
--
-- ⚠️ This destroys all Mounjaro clinical data. Back up data/reserva.db first.

DROP VIEW  IF EXISTS mounjaro_program_stats;
DROP TABLE IF EXISTS mounjaro_audit_log;
DROP TABLE IF EXISTS mounjaro_self_logs;
DROP TABLE IF EXISTS mounjaro_visits;
DROP TABLE IF EXISTS mounjaro_patients;
DROP TABLE IF EXISTS mounjaro_consent_versions;
DROP TABLE IF EXISTS mounjaro_enrollments;

-- users access flags. Needs SQLite ≥ 3.35 for DROP COLUMN (better-sqlite3 11
-- bundles a newer SQLite, so this works). If your build rejects it, leave the
-- columns — they are nullable / default 0 and harmless when unused.
ALTER TABLE users DROP COLUMN clinical_role;
ALTER TABLE users DROP COLUMN license_no;
ALTER TABLE users DROP COLUMN is_hr_analytics;
