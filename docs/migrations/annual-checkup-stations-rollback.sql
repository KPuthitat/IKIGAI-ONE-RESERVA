-- Rollback for stations / sample-kit numbers / "sent to the doctor" (phase 7). Additive only. Run against a COPY of the database first.
-- Triggers drop with their tables; the queue triggers are recreated on the next boot without the kit rule once the columns are gone.
DROP INDEX IF EXISTS uq_annual_checkup_queue_kit;
DROP TABLE IF EXISTS annual_checkup_station_passes;
DROP TABLE IF EXISTS annual_checkup_submissions;
-- Needs SQLite >= 3.35 for DROP COLUMN; otherwise leave the columns (NULL, harmless without the tables).
ALTER TABLE annual_checkup_queue DROP COLUMN kit_set_at;
ALTER TABLE annual_checkup_queue DROP COLUMN kit_set_by;
ALTER TABLE annual_checkup_queue DROP COLUMN kit_no;
ALTER TABLE annual_checkup_tests DROP COLUMN station_id;
DROP TABLE IF EXISTS annual_checkup_stations;
