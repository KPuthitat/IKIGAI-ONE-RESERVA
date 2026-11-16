// Annual check-up — the stations catalogue (phase 7): which stations exist and which station each test belongs to. A first guess is seeded by
// the schema; the owner or a clinic recorder edits it here. Nothing in this file touches a result or a person.
import { getDb } from "./db";
import { isRecorderEligible } from "./annual-checkup-db";

export type StationRow = { id: number; code: string; name_th: string; sort_no: number; active: number };
export type TestStationRow = { code: string; name_th: string; station_id: number | null };

export class StationRefused extends Error {
  constructor(public code: "not_allowed" | "bad_code" | "bad_name" | "code_taken" | "not_found", message: string) { super(message); this.name = "StationRefused"; }
}

function requireEditor(userId: number): void {
  const u = getDb().prepare("SELECT role, status FROM users WHERE id = ?").get(userId) as { role: string; status: string } | undefined;
  if (!u || ["disabled", "resigned", "terminated"].includes(u.status) || !(u.role === "super_admin" || isRecorderEligible(userId))) throw new StationRefused("not_allowed", "ท่านไม่มีสิทธิ์แก้ไขสถานี");
}

export function listStationCatalogue(): { stations: StationRow[]; tests: TestStationRow[] } {
  const db = getDb();
  return {
    stations: db.prepare("SELECT id, code, name_th, sort_no, active FROM annual_checkup_stations ORDER BY sort_no, id").all() as StationRow[],
    tests: db.prepare("SELECT code, name_th, station_id FROM annual_checkup_tests WHERE active = 1 ORDER BY sort_no").all() as TestStationRow[]
  };
}

/** Add a station (no id) or change one's name / order / active flag (with id; the code never changes once made). */
export function saveStation(userId: number, d: { id?: number | null; code?: string; nameTh: string; sortNo: number; active: boolean }): number {
  requireEditor(userId);
  const db = getDb();
  const name = (d.nameTh ?? "").trim().slice(0, 100);
  if (!name) throw new StationRefused("bad_name", "กรุณาใส่ชื่อสถานี");
  const sort = Number.isInteger(d.sortNo) && d.sortNo >= 0 && d.sortNo < 1000 ? d.sortNo : 0;
  if (d.id) {
    const r = db.prepare("UPDATE annual_checkup_stations SET name_th = ?, sort_no = ?, active = ? WHERE id = ?").run(name, sort, d.active ? 1 : 0, d.id);
    if (r.changes === 0) throw new StationRefused("not_found", "ไม่พบสถานี");
    return d.id;
  }
  const code = (d.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new StationRefused("bad_code", "รหัสสถานีใช้ตัวอักษรอังกฤษใหญ่ ตัวเลข หรือ _ ความยาว 2-20 ตัว");
  if (db.prepare("SELECT 1 FROM annual_checkup_stations WHERE code = ?").get(code)) throw new StationRefused("code_taken", "รหัสสถานีนี้มีอยู่แล้ว");
  return Number(db.prepare("INSERT INTO annual_checkup_stations (code, name_th, sort_no, active) VALUES (?,?,?,?)").run(code, name, sort, d.active ? 1 : 0).lastInsertRowid);
}

/** Put a test at a station (null = at no station). */
export function assignTestStation(userId: number, testCode: string, stationId: number | null): void {
  requireEditor(userId);
  const db = getDb();
  if (stationId != null && !db.prepare("SELECT 1 FROM annual_checkup_stations WHERE id = ?").get(stationId)) throw new StationRefused("not_found", "ไม่พบสถานี");
  const r = db.prepare("UPDATE annual_checkup_tests SET station_id = ? WHERE code = ?").run(stationId, testCode);
  if (r.changes === 0) throw new StationRefused("not_found", "ไม่พบรายการตรวจ");
}
