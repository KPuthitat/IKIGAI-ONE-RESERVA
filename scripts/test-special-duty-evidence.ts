// ตำแหน่งงานค่าตอบแทนพิเศษ — evidence, review, absence, substitute, retention.
// Run: node --import tsx scripts/test-special-duty-evidence.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-evidence.db");
const PHOTOS = fs.mkdtempSync(path.join(os.tmpdir(), "sd-photos-"));
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } try { fs.rmSync(PHOTOS, { recursive: true, force: true }); } catch { /* ignore */ } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP; process.env.SPECIAL_DUTY_PHOTO_DIR = PHOTOS;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const R = await import("../src/lib/special-duty-rules");
  const H = await import("../src/lib/special-duty-roster");
  const F = await import("../src/lib/special-duty-fill");
  const E = await import("../src/lib/special-duty-evidence");
  const roster = await import("../src/lib/roster");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof E.EvidenceError ? e.code : `other:${(e as Error).message}`; } };
  const NOW = "2026-11-05", YM = "2026-12";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;
  const PIX = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(nama, "M", "M", "09:00", "17:00").lastInsertRowid);
  const rps = [1, 2, 3, 4].map((i) => Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(nama, `P${i}`).lastInsertRowid));
  const mk = (u: string, dept = "service") => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,'staff','active',?)").run(u, "x", u, dept).lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, nama); return id; };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const holder = mk("holder"), sub = mk("sub"), other = mk("other"), cook = mk("cook", "kitchen");
  const up = (uid: number, d: number, pos: number) => roster.upsertAssignment({ branchId: nama, date: date(d), positionId: pos, userId: uid, shiftCodeId: shift, actingUserId: owner });
  for (let d = 1; d <= 31; d++) { up(holder, d, rps[0]); up(sub, d, rps[1]); up(other, d, rps[2]); }
  for (let d = 1; d <= 31; d++) up(cook, d, rps[3]);
  const clockIn = (uid: number, d: number, branch: number | null = nama) => db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?, 'in', ?, ?)").run(uid, new Date(`${date(d)}T09:00:00+07:00`).toISOString(), branch);

  const toilet = D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างห้องน้ำ", actorId: owner, asOf: NOW });
  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "ล้างจาน", eligibleGroups: ["kitchen"], actorId: owner, asOf: NOW });
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  H.openBookingOnPublish({ branchId: nama, yearMonth: YM, actorId: owner, nowIso: "2026-11-20T03:00:00.000Z" });
  R.setUserBookings({ userId: holder, branchId: nama, yearMonth: YM, positionId: toilet.id, dates: [1, 2, 3, 4, 5, 6].map(date), asOf: "2026-11-21" });
  F.closeBooking({ branchId: nama, yearMonth: YM, actorId: owner });
  F.managerAssign({ branchId: nama, yearMonth: YM, positionId: toilet.id, date: date(7), userId: other, managerId: owner, asOf: "2026-11-28" });
  const dayId = (d: number) => (db.prepare("SELECT id FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(toilet.id, date(d)) as { id: number }).id;
  const status = (d: number) => (db.prepare("SELECT status FROM special_duty_days WHERE id = ?").get(dayId(d)) as { status: string }).status;
  const sub1 = { dayId: dayId(1), userId: holder, photos: [PIX], noPeopleConfirmed: true, today: date(1) };

  ok("before the schedule is published no evidence can be sent", code(() => E.submitEvidence(sub1)) === "wrong_stage");
  F.publishSchedule({ branchId: nama, yearMonth: YM, actorId: owner, allowUnfilled: true, asOf: "2026-11-28" });

  ok("not before the day itself", code(() => E.submitEvidence({ ...sub1, today: "2026-11-30" })) === "too_early");
  ok("only the holder may send it", code(() => E.submitEvidence({ ...sub1, userId: sub })) === "forbidden");
  ok("the 'no people in the photos' confirmation is required", code(() => E.submitEvidence({ ...sub1, noPeopleConfirmed: false })) === "no_people_not_confirmed");
  ok("at least one photo is required", code(() => E.submitEvidence({ ...sub1, photos: [] })) === "photos_required");
  ok("no more than the configured number of photos", code(() => E.submitEvidence({ ...sub1, photos: Array(6).fill(PIX) })) === "too_many_photos");
  ok("only image data is accepted", code(() => E.submitEvidence({ ...sub1, photos: ["data:text/html;base64,AAAA"] })) === "photo_bad_format");
  ok("a holder who did not come to regular work cannot claim the duty", code(() => E.submitEvidence(sub1)) === "not_present");
  clockIn(holder, 1, hypo);
  ok("a clock-in at another branch does not count", code(() => E.submitEvidence(sub1)) === "not_present");
  clockIn(holder, 1);
  ok("rejected attempts leave no photo files behind", !fs.existsSync(path.join(PHOTOS, String(nama))) || fs.readdirSync(path.join(PHOTOS, String(nama))).length === 0);

  E.submitEvidence(sub1);
  ok("holder submits: status submitted, photo stored under the branch folder", status(1) === "submitted" && fs.readdirSync(path.join(PHOTOS, String(nama))).length === 1);
  ok("the first submission moves the month to in progress", D.getMonth(nama, YM).status === "in_progress");
  ok("a submitted day cannot be submitted twice", code(() => E.submitEvidence(sub1)) === "wrong_status");

  // photo access
  const ph = E.listEvidence(dayId(1))[0];
  ok("the holder can open their own photo", E.photoForViewer(ph.id, { userId: holder, manageBranchIds: [] }) != null);
  ok("a manager of the branch can open it", E.photoForViewer(ph.id, { userId: owner, manageBranchIds: [nama] }) != null);
  ok("another employee cannot", E.photoForViewer(ph.id, { userId: other, manageBranchIds: [] }) == null);
  ok("a manager of another branch cannot", E.photoForViewer(ph.id, { userId: owner, manageBranchIds: [hypo] }) == null);
  ok("path traversal in a filename is refused", E.evidencePhotoPath(nama, "../x.jpg") == null);

  // review
  ok("rejecting needs a note", code(() => E.reviewEvidence({ dayId: dayId(1), branchId: nama, managerId: owner, approve: false })) === "note_required");
  ok("another branch's manager cannot review it", code(() => E.reviewEvidence({ dayId: dayId(1), branchId: hypo, managerId: owner, approve: true })) === "not_found");
  E.reviewEvidence({ dayId: dayId(1), branchId: nama, managerId: owner, approve: false, note: "ภาพไม่เห็นพื้นที่ทั้งหมด" });
  ok("rejected: back to booked with the note, resubmission allowed", status(1) === "booked" && (db.prepare("SELECT review_note n FROM special_duty_days WHERE id=?").get(dayId(1)) as { n: string }).n.includes("ภาพไม่เห็น"));
  E.submitEvidence({ ...sub1, today: date(2) });
  ok("a resubmission after a rejection is allowed even after the normal deadline", status(1) === "submitted");
  E.reviewEvidence({ dayId: dayId(1), branchId: nama, managerId: owner, approve: true });
  ok("approved", status(1) === "approved");
  ok("an approved day cannot be changed by another review", code(() => E.reviewEvidence({ dayId: dayId(1), branchId: nama, managerId: owner, approve: true })) === "wrong_status");

  // deadline
  clockIn(holder, 2);
  ok("evidence is refused after the deadline (day + 1)", code(() => E.submitEvidence({ dayId: dayId(2), userId: holder, photos: [PIX], noPeopleConfirmed: true, today: date(4) })) === "deadline_passed");
  ok("…but fine on the next day", code(() => E.submitEvidence({ dayId: dayId(2), userId: holder, photos: [PIX], noPeopleConfirmed: true, today: date(3) })) === "none");
  // approve requires presence at that moment
  db.prepare("DELETE FROM time_entries WHERE user_id = ? AND ts LIKE ?").run(holder, `%${new Date(`${date(2)}T09:00:00+07:00`).toISOString().slice(0, 10)}%`);
  ok("approval is refused if the clock-in is no longer there", code(() => E.reviewEvidence({ dayId: dayId(2), branchId: nama, managerId: owner, approve: true })) === "not_present");

  // absence + substitute
  ok("absence cannot be recorded before the day", code(() => E.markAbsent({ dayId: dayId(5), branchId: nama, managerId: owner, today: date(4) })) === "too_early");
  E.markAbsent({ dayId: dayId(5), branchId: nama, managerId: owner, today: date(5) });
  const row5 = db.prepare("SELECT status, absent_by_holder a FROM special_duty_days WHERE id=?").get(dayId(5)) as { status: string; a: number };
  ok("absent: no pay, one strike for the holder", row5.status === "absent" && row5.a === 1 && R.absenceStrikes(holder, nama, YM) === 1);
  ok("the absent holder can no longer submit", code(() => E.submitEvidence({ dayId: dayId(5), userId: holder, photos: [PIX], noPeopleConfirmed: true, today: date(5) })) === "wrong_status");
  ok("substitute must differ from the holder", code(() => E.assignSubstitute({ dayId: dayId(5), branchId: nama, performerId: holder, managerId: owner, today: date(5) })) === "substitute_same_person");
  ok("a substitute who is not a member of the branch is refused", code(() => E.assignSubstitute({ dayId: dayId(5), branchId: nama, performerId: owner, managerId: owner, today: date(5) })) === "substitute_invalid");
  db.prepare("INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status) VALUES (?, 'sick', ?, ?, 1, 'approved')").run(sub, date(5), date(5));
  ok("a substitute on approved leave is refused", code(() => E.assignSubstitute({ dayId: dayId(5), branchId: nama, performerId: sub, managerId: owner, today: date(5) })) === "substitute_invalid");
  db.prepare("DELETE FROM leave_requests").run();
  E.assignSubstitute({ dayId: dayId(5), branchId: nama, performerId: sub, managerId: owner, today: date(5) });
  ok("substitute named: status covered", status(5) === "covered");
  ok("the original holder cannot submit for a covered day", code(() => E.submitEvidence({ dayId: dayId(5), userId: holder, photos: [PIX], noPeopleConfirmed: true, today: date(5) })) === "forbidden");
  ok("the substitute must also have come to regular work", code(() => E.submitEvidence({ dayId: dayId(5), userId: sub, photos: [PIX], noPeopleConfirmed: true, today: date(5) })) === "not_present");
  clockIn(sub, 5);
  E.submitEvidence({ dayId: dayId(5), userId: sub, photos: [PIX], noPeopleConfirmed: true, today: date(5) });
  E.reviewEvidence({ dayId: dayId(5), branchId: nama, managerId: owner, approve: true });
  const r5 = db.prepare("SELECT status, user_id u, performer_user_id p FROM special_duty_days WHERE id=?").get(dayId(5)) as { status: string; u: number; p: number };
  ok("substitute's day approved: performer is the substitute, holder unchanged (still carries the strike)", r5.status === "approved" && r5.p === sub && r5.u === holder && R.absenceStrikes(holder, nama, YM) === 1);
  ok("the substitute day is not counted as the substitute's own booking", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE user_id = ?").get(sub) as { n: number }).n === 0);
  ok("a second absence on a covered day by the substitute is not a holder strike", (() => { E.markAbsent({ dayId: dayId(3), branchId: nama, managerId: owner, today: date(3) }); E.assignSubstitute({ dayId: dayId(3), branchId: nama, performerId: sub, managerId: owner, today: date(3) }); E.markAbsent({ dayId: dayId(3), branchId: nama, managerId: owner, today: date(3) }); return R.absenceStrikes(holder, nama, YM) === 2; })());

  // assigned day by manager: other, day 7
  clockIn(other, 7);
  E.submitEvidence({ dayId: dayId(7), userId: other, photos: [PIX, PIX], noPeopleConfirmed: true, today: date(7) });
  ok("a manager-assigned day follows the same path", status(7) === "submitted" && E.listEvidence(dayId(7)).length === 2);

  // retention
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  db.prepare("UPDATE special_duty_evidence SET uploaded_at = ? WHERE day_id = ?").run(old, dayId(7));
  const files = () => fs.readdirSync(path.join(PHOTOS, String(nama))).length;
  const before = files();
  const swept = E.sweepEvidence();
  ok("photos older than the retention period (90 days) are deleted from disk", swept === 2 && files() === before - 2);
  ok("their rows stay, marked deleted, and cannot be opened", E.listEvidence(dayId(7)).every((p) => p.deleted) && E.photoForViewer(E.listEvidence(dayId(7))[0].id, { userId: other, manageBranchIds: [] }) == null);
  ok("recent photos are untouched", E.listEvidence(dayId(1)).every((p) => !p.deleted));
  ok("sweeping again does nothing", E.sweepEvidence() === 0);

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  // two jobs on the same day, one set of photos (owner 2026-10-29)
  const dish = D.listPositions(nama, YM).find((x) => x.name === "ล้างจาน")!;
  // the month is already in progress, so insert the two assigned days directly
  for (const pos of [toilet.id, dish.id]) db.prepare("INSERT INTO special_duty_days (position_id, duty_date, user_id, source, status) VALUES (?, ?, ?, 'assigned', 'assigned')").run(pos, date(8), cook);
  const dayOf = (pos: number, d: number) => (db.prepare("SELECT id FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(pos, date(d)) as { id: number }).id;
  const [t8, d8] = [dayOf(toilet.id, 8), dayOf(dish.id, 8)];
  clockIn(cook, 8);
  const filesBefore = fs.readdirSync(path.join(PHOTOS, String(nama))).length;
  ok("jobs of different dates cannot share one submission", code(() => E.submitEvidence({ dayIds: [t8, dayId(2)], userId: cook, photos: [PIX], noPeopleConfirmed: true, today: date(8) })) === "days_must_match" || code(() => E.submitEvidence({ dayIds: [t8, dayId(2)], userId: cook, photos: [PIX], noPeopleConfirmed: true, today: date(8) })) === "forbidden");
  ok("someone else's job cannot be added to the submission", code(() => E.submitEvidence({ dayIds: [t8, dayId(7)], userId: cook, photos: [PIX], noPeopleConfirmed: true, today: date(8) })) !== "none");
  E.submitEvidence({ dayIds: [t8, d8], userId: cook, photos: [PIX], noPeopleConfirmed: true, today: date(8) });
  ok("both jobs become submitted from one submission", (db.prepare("SELECT COUNT(*) n FROM special_duty_days WHERE id IN (?, ?) AND status = 'submitted'").get(t8, d8) as { n: number }).n === 2);
  ok("the photo is stored once but each job has it to review", fs.readdirSync(path.join(PHOTOS, String(nama))).length === filesBefore + 1 && E.listEvidence(t8).length === 1 && E.listEvidence(d8).length === 1 && E.listEvidence(t8)[0].filename === E.listEvidence(d8)[0].filename);
  E.reviewEvidence({ dayId: t8, branchId: nama, managerId: owner, approve: true });
  ok("each job is reviewed on its own", status(8) === "approved" && (db.prepare("SELECT status FROM special_duty_days WHERE id = ?").get(d8) as { status: string }).status === "submitted");
  // duplicate-photo signals (owner 2026-10-29)
  const fl = (id: number) => E.evidenceFlags(id);
  ok("the same bytes sent for another day are flagged identical (not against the job it was shared with)", (() => { const f = fl(t8); return f.some((x) => x.kind === "identical" && x.other && x.other.dayId !== d8) && !f.some((x) => x.other?.dayId === d8); })());
  const PIX2 = (n: number) => "data:image/jpeg;base64," + Buffer.from(`other-bytes-${n}`).toString("base64");
  const mkDay = (d: number) => { db.prepare("INSERT INTO special_duty_days (position_id, duty_date, user_id, source, status) VALUES (?, ?, ?, 'assigned', 'assigned')").run(toilet.id, date(d), cook); clockIn(cook, d); return dayOf(toilet.id, d); };
  const d10 = mkDay(10), d11 = mkDay(11), d12 = mkDay(12), d13 = mkDay(13);
  const send = (id: number, d: number, n: number, meta: { phash?: string; takenAt?: string }) => E.submitEvidence({ dayIds: [id], userId: cook, photos: [PIX2(n)], photoMeta: [meta], noPeopleConfirmed: true, today: date(d) });
  send(d10, 10, 10, { phash: "0f0f0f0f0f0f0f0f", takenAt: `${date(10)}T05:00:00Z` });
  ok("a first picture with a fingerprint is not flagged", fl(d10).length === 0);
  send(d11, 11, 11, { phash: "0f0f0f0f0f0f0f0e", takenAt: `${date(11)}T05:00:00Z` });   // 1 bit away, different bytes: a re-saved copy
  ok("a near-identical picture (re-saved copy) is flagged similar and names the earlier day", fl(d11).some((x) => x.kind === "similar" && x.other?.dayId === d10));
  send(d12, 12, 12, { phash: "f0f0f0f0f0f0f0f0", takenAt: `${date(12)}T05:00:00Z` });   // 32 bits away: a new shot of the same spot
  ok("a different shot of the same spot is not flagged", fl(d12).length === 0);
  send(d13, 13, 13, { phash: "123456789abcdef0", takenAt: `${date(9)}T05:00:00Z` });
  ok("a picture dated before the duty day is flagged", fl(d13).some((x) => x.kind === "older_photo" && x.takenAt === date(9)));
  ok("a malformed fingerprint is ignored, not stored", (() => { const dd = mkDay(14); send(dd, 14, 14, { phash: "zz" }); return (db.prepare("SELECT phash FROM special_duty_evidence WHERE day_id = ?").get(dd) as { phash: string | null }).phash === null; })());
  // ── changing who does a day, with a reason (owner 2026-11-01) ──
  const rd = (() => { const id = Number(db.prepare("INSERT INTO special_duty_days (position_id,duty_date,user_id,source,status) VALUES (?,?,?,'booked','booked')").run(toilet.id, date(20), holder).lastInsertRowid); return id; })();
  const strikesBefore = R.absenceStrikes(holder, nama, YM);
  const rep = (over: Record<string, unknown> = {}) => E.replaceDutyWorker({ dayId: rd, branchId: nama, toUserId: sub, reasonType: "sick", note: null, managerId: owner, today: date(18), ...over } as never);
  ok("a reason is mandatory; 'other' needs words", code(() => rep({ reasonType: undefined })) === "reason_required" && code(() => rep({ reasonType: "other", note: "" })) === "reason_required");
  ok("a person who cannot take it is refused (outside the group)", code(() => rep({ toUserId: owner })) === "substitute_invalid");
  const r1 = rep({ note: "ไข้หวัดใหญ่" });
  ok("a day can be handed over in advance for sick leave; it becomes covered by the new person", status(20) === "covered" && (db.prepare("SELECT performer_user_id p FROM special_duty_days WHERE id = ?").get(rd) as { p: number }).p === sub && r1.reasonText.includes("ลาป่วย") && r1.reasonText.includes("ไข้หวัดใหญ่"));
  ok("the person already doing the day cannot be 'changed' to themselves", code(() => rep({ toUserId: sub })) === "substitute_same_person");
  ok("the holder takes no absence strike", R.absenceStrikes(holder, nama, YM) === strikesBefore);
  ok("who → whom and why is kept", (() => { const x = E.latestReplacements([rd]).get(rd); return !!x && x.fromName === "holder" && x.toName === "sub" && x.reasonText === "ลาป่วย · ไข้หวัดใหญ่"; })());
  ok("the current performer is not offered again as a candidate", !E.listSubstituteCandidates(rd, nama).some((u) => u.id === sub));
  ok("it can be changed again to a third person, the log keeps both", (() => { rep({ toUserId: other, reasonType: "personal", note: null }); return (db.prepare("SELECT COUNT(*) n FROM special_duty_replacements WHERE day_id = ?").get(rd) as { n: number }).n === 2 && E.latestReplacements([rd]).get(rd)!.toName === "other"; })());
  ok("and handed back to the original holder", (() => { rep({ toUserId: holder, reasonType: "other", note: "หายแล้ว" }); const d = db.prepare("SELECT status, performer_user_id p FROM special_duty_days WHERE id = ?").get(rd) as { status: string; p: number | null }; return d.status === "booked" && d.p === null; })());
  ok("a day whose evidence is already sent cannot be changed", code(() => E.replaceDutyWorker({ dayId: dayId(7), branchId: nama, toUserId: sub, reasonType: "sick", managerId: owner, today: date(8) })) === "wrong_status");
  ok("another branch cannot change it", code(() => E.replaceDutyWorker({ dayId: rd, branchId: hypo, toUserId: sub, reasonType: "sick", managerId: owner, today: date(18) })) === "not_found");
  ok("too late after the evidence deadline", code(() => rep({ today: "2026-12-30" })) === "deadline_passed");

  cleanup(); process.exit(failed ? 1 : 0);
})();
