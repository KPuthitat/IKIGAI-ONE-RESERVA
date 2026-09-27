// Forward-plan forecast tests (owner 2026-09-27): holidays, closed-day handling,
// payday flag, plan shape. Run: node --import tsx scripts/test-forecast.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-forecast.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();   // init schema (salesa_daily etc.)
  const { branchForecast, holidayOn, attachWeather, attachEventNotes } = await import("../src/lib/forecast");
  const { addEventNote, listEventNotes, eventNotesByDate, eventNotesForDay, eventNotesForRange, deleteEventNote } = await import("../src/lib/event-notes");

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  ok("holidayOn: 5 ธ.ค. = วันพ่อ · วันธรรมดาไม่ใช่วันหยุด", holidayOn("2026-12-05") === "วันพ่อแห่งชาติ" && holidayOn("2026-09-16") === null);

  // No POS history → no baseline, but the plan still lays out the days, closed
  // days, holidays and payday flags.
  const fc = branchForecast(999999, "2026-12-04", 7, [1], false);  // closed Mondays
  ok("forecast: 7 แถว เริ่ม 2026-12-04", fc.rows.length === 7 && fc.rows[0].date === "2026-12-04");
  ok("forecast: ไม่มีข้อมูลย้อนหลัง → hasBaseline false · predicted null", fc.hasBaseline === false && fc.rows[0].predictedNett === null);
  ok("forecast: วันจันทร์ปิดทำการ (closed + ปิดทำการประจำ)", (() => {
    const mon = fc.rows.find((r) => r.dow === 1);
    return !!mon && mon.closed === true && mon.predictedNett === 0 && mon.suggestions.includes("ปิดทำการประจำ");
  })());
  ok("forecast: 5 ธ.ค. ติดธงวันพ่อ", (() => {
    const d = fc.rows.find((r) => r.date === "2026-12-05");
    return !!d && d.holiday === "วันพ่อแห่งชาติ";
  })());
  ok("forecast: payday flag ช่วงสิ้นเดือน (29–31, 1)", (() => {
    const p = branchForecast(999999, "2026-12-29", 5, [], false);
    return p.rows.find((r) => r.date === "2026-12-31")?.payday === true && p.rows.find((r) => r.date === "2027-01-01")?.payday === true && p.rows.find((r) => r.date === "2026-12-29")?.payday === true;
  })());

  // attachWeather folds weather + a rain/heat suggestion onto an open day.
  attachWeather(fc, { "2026-12-05": { tempMax: 36, tempMin: 26, rainChance: 70, summary: "ฝนน่าจะตก · ร้อนจัด" } });
  ok("forecast: attachWeather เติมอากาศ + คำแนะนำฝน/ร้อน", (() => {
    const d = fc.rows.find((r) => r.date === "2026-12-05");
    return !!d && d.weather?.rainChance === 70 && d.suggestions.some((s) => s.includes("ฝน")) && d.suggestions.some((s) => s.includes("ร้อน"));
  })());
  ok("forecast: days=3 → 3 แถว", branchForecast(999999, "2026-12-04", 3, [], false).rows.length === 3);

  // ── Team-tagged event notes (owner 2026-09-27) ──────────────────────────────
  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('en','NAMA')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('en2','HYPO')").run().lastInsertRowid);

  const n1 = addEventNote(branch, "2026-12-05", "  มีงานวิ่งใกล้ร้าน  ", null);
  ok("event-notes: add trims text · returns row", !!n1 && n1.note === "มีงานวิ่งใกล้ร้าน" && n1.eventDate === "2026-12-05");
  addEventNote(branch, "2026-12-05", "ถนนหน้าร้านปิด", null);   // 2nd note same day
  addEventNote(branch, "2026-12-07", "เทศกาลกินเจ", null);
  ok("event-notes: reject blank + bad date", addEventNote(branch, "2026-12-05", "   ", null) === null && addEventNote(branch, "bad-date", "x", null) === null);
  ok("event-notes: reject impossible calendar date (regex-valid but not real)", addEventNote(branch, "2026-02-30", "x", null) === null && addEventNote(branch, "2026-13-01", "x", null) === null);

  const list = listEventNotes(branch, "2026-12-01", "2026-12-31");
  ok("event-notes: list returns 3 in range, date/id order", list.length === 3 && list[0].eventDate === "2026-12-05" && list[2].eventDate === "2026-12-07");
  ok("event-notes: range excludes out-of-window", listEventNotes(branch, "2026-12-06", "2026-12-31").length === 1);
  ok("event-notes: branch-scoped (other branch sees none)", listEventNotes(other, "2026-12-01", "2026-12-31").length === 0);

  const byDate = eventNotesByDate(branch, "2026-12-01", "2026-12-31");
  ok("event-notes: byDate groups (2 on 12-05, 1 on 12-07)", byDate["2026-12-05"]?.length === 2 && byDate["2026-12-07"]?.length === 1);

  // Report-fold readers (owner 2026-09-27: notes in daily/weekly reports).
  ok("event-notes: forDay returns just that day's strings", (() => {
    const d = eventNotesForDay(branch, "2026-12-05");
    return d.length === 2 && d.includes("มีงานวิ่งใกล้ร้าน") && eventNotesForDay(branch, "2026-12-06").length === 0;
  })());
  ok("event-notes: forRange groups per day with a label, ascending", (() => {
    const rng = eventNotesForRange(branch, "2026-12-01", "2026-12-31", (iso) => `L:${iso}`);
    return rng.length === 2 && rng[0].date === "2026-12-05" && rng[0].dateLabel === "L:2026-12-05" && rng[0].notes.length === 2 && rng[1].date === "2026-12-07";
  })());

  const fcNotes = branchForecast(branch, "2026-12-04", 7, [], false);
  attachEventNotes(fcNotes, byDate);
  ok("event-notes: attachEventNotes folds onto matching days", (() => {
    const d5 = fcNotes.rows.find((r) => r.date === "2026-12-05");
    const d6 = fcNotes.rows.find((r) => r.date === "2026-12-06");
    return d5?.eventNotes.length === 2 && d5.eventNotes.includes("ถนนหน้าร้านปิด") && d6?.eventNotes.length === 0;
  })());

  ok("event-notes: delete is branch-scoped (foreign branch can't remove)", n1 != null && deleteEventNote(other, n1.id) === false && listEventNotes(branch, "2026-12-05", "2026-12-05").length === 2);
  ok("event-notes: delete own note removes it", n1 != null && deleteEventNote(branch, n1.id) === true && listEventNotes(branch, "2026-12-05", "2026-12-05").length === 1);

  // created_by ON DELETE SET NULL: when a note's author is purged (resignation
  // sweep), the note survives with a null author instead of blocking the DELETE.
  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('en_author','x','ทีมงาน','staff','active')").run().lastInsertRowid);
  const authored = addEventNote(branch, "2026-12-09", "ผู้เขียนจะลาออก", uid);
  ok("event-notes: note stores author + display name", !!authored && authored.createdBy === uid && authored.createdByName === "ทีมงาน");
  db.prepare("DELETE FROM users WHERE id = ?").run(uid);   // must NOT throw (FK sets created_by null)
  ok("event-notes: purging the author keeps the note (created_by → null)", (() => {
    const after = listEventNotes(branch, "2026-12-09", "2026-12-09");
    return after.length === 1 && after[0].createdBy === null && after[0].note === "ผู้เขียนจะลาออก";
  })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
