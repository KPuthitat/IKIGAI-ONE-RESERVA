// Health-consulting facility config (owner 2026-06-05).
//
// Replaces the hardcoded "AT HOME CLINIC" string scattered across the
// health module. Admin maintains the facility's name / license / address
// (and an optional logo); everything user-facing — the self-portal
// header, the consent card, the clinical HN hint — pulls the DEFAULT
// facility from here instead of a literal.
//
// For IKIGAI ONE this is แอทโฮมคลินิกเวชกรรม สาขาบ่อวิน (ใบอนุญาต
// 20101005164), seeded in db.ts. Multiple facilities are supported; the
// one flagged is_default=1 is what the UI uses.

import { getDb } from "./db";

/** Fallback logo bundled in /public — used for every health program when
 *  a facility hasn't set its own logo_path. */
export const DEFAULT_HEALTH_LOGO = "/ahc-logo.png";

export type HealthFacility = {
  id: number;
  name: string;
  license_no: string | null;
  address: string | null;
  logo_path: string | null;
  is_default: number;
  created_at: string;
  updated_at: string | null;
};

/** The facility the UI should use. Prefers is_default=1, else the oldest
 *  row, else null when none configured. */
export function getDefaultHealthFacility(): HealthFacility | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM health_facilities
    ORDER BY is_default DESC, id ASC
    LIMIT 1
  `).get() as HealthFacility | undefined;
  return row ?? null;
}

/** Display helpers — safe defaults so callers never render "null". */
export function facilityName(f: HealthFacility | null): string {
  return f?.name?.trim() || "คลินิกที่ปรึกษาสุขภาพของบริษัท";
}
export function facilityLogo(f: HealthFacility | null): string {
  return f?.logo_path?.trim() || DEFAULT_HEALTH_LOGO;
}

export function listHealthFacilities(): HealthFacility[] {
  return getDb().prepare(
    "SELECT * FROM health_facilities ORDER BY is_default DESC, name ASC"
  ).all() as HealthFacility[];
}

export function getHealthFacility(id: number): HealthFacility | null {
  return (getDb().prepare("SELECT * FROM health_facilities WHERE id = ?")
    .get(id) as HealthFacility | undefined) ?? null;
}

export function createHealthFacility(data: {
  name: string; license_no: string | null; address: string | null;
  logo_path: string | null; makeDefault: boolean;
}): number {
  const db = getDb();
  const tx = db.transaction(() => {
    if (data.makeDefault) {
      db.prepare("UPDATE health_facilities SET is_default = 0").run();
    }
    const info = db.prepare(`
      INSERT INTO health_facilities (name, license_no, address, logo_path, is_default)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.name.trim(),
      data.license_no?.trim() || null,
      data.address?.trim() || null,
      data.logo_path?.trim() || null,
      data.makeDefault ? 1 : 0
    );
    return Number(info.lastInsertRowid);
  });
  return tx();
}

export function updateHealthFacility(id: number, data: {
  name: string; license_no: string | null; address: string | null;
  logo_path: string | null; makeDefault: boolean;
}): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM health_facilities WHERE id = ?").get(id);
  if (!exists) return false;
  const tx = db.transaction(() => {
    if (data.makeDefault) {
      db.prepare("UPDATE health_facilities SET is_default = 0").run();
    }
    db.prepare(`
      UPDATE health_facilities
      SET name = ?, license_no = ?, address = ?, logo_path = ?,
          is_default = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.name.trim(),
      data.license_no?.trim() || null,
      data.address?.trim() || null,
      data.logo_path?.trim() || null,
      data.makeDefault ? 1 : 0,
      id
    );
    return true;
  });
  return tx();
}

/** Delete a facility. Refuses to delete the last remaining row so the UI
 *  always has a default to fall back on. */
export function deleteHealthFacility(id: number): { ok: boolean; reason?: string } {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS c FROM health_facilities").get() as { c: number }).c;
  if (count <= 1) return { ok: false, reason: "last_facility" };
  const wasDefault = db.prepare("SELECT is_default FROM health_facilities WHERE id = ?")
    .get(id) as { is_default: number } | undefined;
  if (!wasDefault) return { ok: false, reason: "not_found" };
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM health_facilities WHERE id = ?").run(id);
    // If we removed the default, promote the oldest remaining row.
    if (wasDefault.is_default === 1) {
      const next = db.prepare("SELECT id FROM health_facilities ORDER BY id ASC LIMIT 1")
        .get() as { id: number } | undefined;
      if (next) db.prepare("UPDATE health_facilities SET is_default = 1 WHERE id = ?").run(next.id);
    }
  });
  tx();
  return { ok: true };
}
