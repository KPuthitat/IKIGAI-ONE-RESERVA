-- Rollback for the annual check-up queue / QR check-in (phase 6). Additive only, so nothing else depends on it.
-- Triggers drop with the table. Run against a COPY of the database first.
DROP TABLE IF EXISTS annual_checkup_queue;
-- Needs SQLite >= 3.35 for DROP COLUMN; otherwise leave the column, it is NULL and does nothing without the table.
ALTER TABLE annual_checkup_rounds DROP COLUMN appt_time;
