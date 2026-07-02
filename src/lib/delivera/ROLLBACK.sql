-- DELIVERA rollback (owner 2026-07-02)
--
-- This repo has no down-migration runner — schema lives as additive CREATE
-- TABLE IF NOT EXISTS blocks in src/lib/db.ts. To fully remove DELIVERA, run
-- this against data/reserva.db (sqlite3) AFTER stopping the app, then delete
-- the DELIVERA migration block from db.ts. Order respects FKs (children first).
--
-- WARNING: destroys all delivery orders/payments/riders. Take a backup first:
--   npm run db:backup

DROP TABLE IF EXISTS delivery_payments;
DROP TABLE IF EXISTS delivery_order_items;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS delivery_orders;
DROP TABLE IF EXISTS delivery_zones;
DROP TABLE IF EXISTS delivera_menu_items;
DROP TABLE IF EXISTS riders;
DROP TABLE IF EXISTS delivera_branch_settings;

-- SQLite < 3.35 cannot DROP COLUMN. On a modern build:
--   ALTER TABLE branches DROP COLUMN delivera_enabled;
-- Otherwise leave the (harmless, default-0) column in place.
