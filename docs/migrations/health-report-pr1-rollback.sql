-- Rollback — health check-up report, PR 1 (catalogue of report items, reference ranges, explanation texts, settings)
-- Run manually against data/reserva.db ONLY if you need to undo PR 1.
--
--   sqlite3 data/reserva.db < docs/migrations/health-report-pr1-rollback.sql
--
-- Back up data/reserva.db first. Also remove the ensureHealthReportSchema(db) call in src/lib/db.ts (and redeploy), or the
-- tables come back at the next boot. Nothing that existed before PR 1 was altered, so this removes only what PR 1 added.
DROP TABLE IF EXISTS annual_checkup_item_refs;
DROP TABLE IF EXISTS annual_checkup_items;
DROP TABLE IF EXISTS annual_checkup_explanations;
DROP TABLE IF EXISTS annual_checkup_config;
-- The extra orderable tests PR 1 added, only those nobody has ordered yet (a test with orders must stay).
DELETE FROM annual_checkup_tests
 WHERE code IN ('HBA1C','ALP','TP','ALB','TBIL','ANTIHBS','ANTIHBC','ANTIHCV','HIV','VDRL','TSH','FT3','FT4','CORTISOL','AFP','CEA','PSA','CA125','CA153','CA199','STOOLEXAM','FOB','PAP','HPV','ECG','AMPH')
   AND id NOT IN (SELECT test_id FROM annual_checkup_orders)
   AND id NOT IN (SELECT test_id FROM annual_checkup_program_tests);
