// ตำแหน่งงานค่าตอบแทนพิเศษ — doing the duty: evidence, review, absence, substitute (owner 2026-10-11).
//
//  • The person who does the duty (the holder, or the substitute the manager named) sends 1–5
//    photos of the finished WORK AREA — never of people — and confirms that no one is in them.
//    Photos go to disk under data/uploads/special-duty/<branchId>/ and are swept after
//    special_duty_config.evidence_retention_days.
//  • A duty is only valid when that person also came to their regular work that day (clock-in),
//    because absence from regular work counts neither toward work time nor the special position.
//  • The manager approves (→ payable) or sends it back with a note. Only APPROVED days are paid.
//  • The manager can mark the holder absent (one strike toward the limit) and name a substitute,
//    who then submits the evidence. A substitute day does not count toward their own minimum days.

import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { advanceMonth, audit, cfgNum, getMonth } from "./special-duty";
import { isGroupEligible, isOnApprovedLeave, isOnRoster } from "./special-duty-rules";

export type EvidenceErrorCode =
  | "not_found" | "forbidden" | "wrong_stage" | "too_early" | "deadline_passed" | "wrong_status" | "not_present"
  | "photos_required" | "too_many_photos" | "photo_bad_format" | "photo_too_large" | "no_people_not_confirmed"
  | "note_required" | "substitute_invalid" | "substitute_same_person" | "substitute_busy";

export class EvidenceError extends Error { constructor(public code: EvidenceErrorCode) { super(code); } }

const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MAX_BYTES = 2 * 1024 * 1024;

const photoRoot = () => process.env.SPECIAL_DUTY_PHOTO_DIR || path.join(process.cwd(), "data", "uploads", "special-duty");
const branchDir = (branchId: number) => path.join(photoRoot(), String(branchId));

function decodePhoto(dataUrl: string): { ext: string; buf: Buffer } {
  const m = /^data:image\/(jpeg|jpg|webp|png);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || "").trim());
  if (!m) throw new EvidenceError("photo_bad_format");
  const ext = m[1] === "webp" ? "webp" : m[1] === "png" ? "png" : "jpg";
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) throw new EvidenceError("photo_bad_format");
  if (buf.length > MAX_BYTES) throw new EvidenceError("photo_too_large");
  return { ext, buf };
}

function savePhoto(branchId: number, dataUrl: string): string {
  const { ext, buf } = decodePhoto(dataUrl);
  fs.mkdirSync(branchDir(branchId), { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(branchDir(branchId), filename), buf);
  return filename;
}

/** Absolute path of a stored photo, guarded against traversal. */
export function evidencePhotoPath(branchId: number, filename: string): string | null {
  if (!filename || /[\\/]|\.\./.test(filename)) return null;
  const full = path.join(branchDir(branchId), filename);
  return fs.existsSync(full) ? full : null;
}

type DayRow = { reviewed_at: string | null; id: number; position_id: number; duty_date: string; user_id: number; source: "booked" | "assigned"; status: string;
  performer_user_id: number | null; branch_id: number; year_month: string; pname: string };

function loadDay(dayId: number): DayRow {
  const r = getDb().prepare(`
    SELECT d.id, d.reviewed_at, d.position_id, d.duty_date, d.user_id, d.source, d.status, d.performer_user_id,
           p.branch_id, p.year_month, p.name AS pname
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ?
  `).get(dayId) as DayRow | undefined;
  if (!r) throw new EvidenceError("not_found");
  return r;
}

/** Came to regular work that day: a clock-in on that Bangkok date at this branch (or with no branch recorded). */
export function wasPresent(userId: number, branchId: number, date: string): boolean {
  const from = new Date(`${date}T00:00:00+07:00`).toISOString();
  const to = new Date(`${date}T23:59:59.999+07:00`).toISOString();
  return !!getDb().prepare(`SELECT 1 FROM time_entries WHERE user_id = ? AND type = 'in' AND ts >= ? AND ts <= ? AND (branch_id = ? OR branch_id IS NULL) LIMIT 1`)
    .get(userId, from, to, branchId);
}

/** Who does the duty: the substitute if one was named, otherwise the holder. */
const performerOf = (d: DayRow) => d.performer_user_id ?? d.user_id;

/** Last day evidence may be sent: the day after the duty — or, after the manager sent it back, the day after that. */
function submitDeadline(d: DayRow): string {
  const base = d.reviewed_at && d.reviewed_at.slice(0, 10) > d.duty_date ? new Date(Date.parse(d.reviewed_at) + 7 * 3600_000).toISOString().slice(0, 10) : d.duty_date;
  return addDays(base, cfgNum("evidence_deadline_days"));
}

const WORKING = ["special_published", "in_progress"];

// ── submit ────────────────────────────────────────────────────────────────

export function submitEvidence(args: { dayId: number; userId: number; photos: string[]; noPeopleConfirmed: boolean; today?: string }): void {
  const db = getDb();
  const today = args.today ?? bkkToday();
  const d = loadDay(args.dayId);
  if (performerOf(d) !== args.userId) throw new EvidenceError("forbidden");
  if (d.status === "absent") throw new EvidenceError("wrong_status");
  if (!["booked", "assigned"].includes(d.status) && !(d.status === "covered")) throw new EvidenceError("wrong_status");
  const month = getMonth(d.branch_id, d.year_month);
  if (!month.enabled || !WORKING.includes(month.status)) throw new EvidenceError("wrong_stage");
  if (today < d.duty_date) throw new EvidenceError("too_early");
  if (today > submitDeadline(d)) throw new EvidenceError("deadline_passed");
  if (!args.noPeopleConfirmed) throw new EvidenceError("no_people_not_confirmed");
  const photos = args.photos ?? [];
  if (photos.length < cfgNum("evidence_min_photos")) throw new EvidenceError("photos_required");
  if (photos.length > cfgNum("evidence_max_photos")) throw new EvidenceError("too_many_photos");
  for (const p of photos) decodePhoto(p);   // format and size first, so a bad file is reported as such
  if (!wasPresent(args.userId, d.branch_id, d.duty_date)) throw new EvidenceError("not_present");

  const saved: string[] = [];
  try {
    for (const p of photos) saved.push(savePhoto(d.branch_id, p));
    const now = new Date().toISOString();
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO special_duty_evidence (day_id, branch_id, filename, uploaded_by, uploaded_at) VALUES (?,?,?,?,?)");
      for (const f of saved) ins.run(d.id, d.branch_id, f, args.userId, now);
      db.prepare("UPDATE special_duty_days SET status = 'submitted', submitted_at = ?, review_note = NULL WHERE id = ?").run(now, d.id);
      audit({ actorId: args.userId, branchId: d.branch_id, yearMonth: d.year_month, entity: "evidence", entityId: d.id, action: "submit", after: { photos: saved.length } });
      if (month.status === "special_published") advanceMonth({ branchId: d.branch_id, yearMonth: d.year_month, to: "in_progress", actorId: args.userId });
    })();
  } catch (e) {
    for (const f of saved) { try { fs.unlinkSync(path.join(branchDir(d.branch_id), f)); } catch { /* ignore */ } }
    throw e;
  }
}

// ── review ────────────────────────────────────────────────────────────────

export function reviewEvidence(args: { dayId: number; branchId: number; managerId: number; approve: boolean; note?: string }): void {
  const db = getDb();
  const d = loadDay(args.dayId);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  if (d.status !== "submitted") throw new EvidenceError("wrong_status");
  const note = (args.note ?? "").trim();
  const now = new Date().toISOString();
  if (args.approve) {
    // Never pay a duty done by someone who was absent from regular work (clock data may have been fixed since submission).
    if (!wasPresent(performerOf(d), d.branch_id, d.duty_date)) throw new EvidenceError("not_present");
    db.prepare("UPDATE special_duty_days SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
      .run(args.managerId, now, note || null, d.id);
  } else {
    if (note.length < 3) throw new EvidenceError("note_required");
    const back = d.performer_user_id != null ? "covered" : d.source === "assigned" ? "assigned" : "booked";
    db.prepare("UPDATE special_duty_days SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
      .run(back, args.managerId, now, note, d.id);
  }
  audit({ actorId: args.managerId, branchId: d.branch_id, yearMonth: d.year_month, entity: "evidence", entityId: d.id, action: args.approve ? "approve" : "reject", after: { note } });
}

// ── absence + substitute ──────────────────────────────────────────────────

export function markAbsent(args: { dayId: number; branchId: number; managerId: number; today?: string }): void {
  const d = loadDay(args.dayId);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  const month = getMonth(d.branch_id, d.year_month);
  if (!WORKING.includes(month.status)) throw new EvidenceError("wrong_stage");
  if ((args.today ?? bkkToday()) < d.duty_date) throw new EvidenceError("too_early");
  if (!["booked", "assigned", "submitted", "covered"].includes(d.status)) throw new EvidenceError("wrong_status");
  // A substitute who then fails is not the holder's absence: only the holder's own miss is a strike.
  const holderMiss = d.performer_user_id == null ? 1 : 0;
  getDb().prepare("UPDATE special_duty_days SET status = 'absent', absent_by_holder = absent_by_holder | ?, performer_user_id = NULL, reviewed_by = ?, reviewed_at = ?, review_note = NULL WHERE id = ?")
    .run(holderMiss, args.managerId, new Date().toISOString(), d.id);
  audit({ actorId: args.managerId, branchId: d.branch_id, yearMonth: d.year_month, entity: "duty_day", entityId: d.id, action: "absent", before: { status: d.status, performer: d.performer_user_id }, after: { holderMiss } });
}

/** Why this person cannot stand in for the day (null = they can). */
function substituteProblem(d: DayRow, performerId: number): EvidenceErrorCode | null {
  const db = getDb();
  if (performerId === d.user_id) return "substitute_same_person";
  const u = db.prepare(`SELECT u.id, u.department FROM users u WHERE u.id = ? AND u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated')
      AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?)`).get(performerId, d.branch_id) as { id: number; department: string | null } | undefined;
  const pos = db.prepare("SELECT eligible_groups FROM special_duty_positions WHERE id = ?").get(d.position_id) as { eligible_groups: string | null };
  const eligible = u && isGroupEligible({ department: u.department }, { eligibleGroups: pos.eligible_groups ? JSON.parse(pos.eligible_groups) : null } as never);
  if (!u || !eligible || !isOnRoster(u.id, d.branch_id, d.duty_date) || isOnApprovedLeave(u.id, d.duty_date)) return "substitute_invalid";
  const busy = (db.prepare(`SELECT COUNT(*) n FROM special_duty_days WHERE duty_date = ? AND id != ? AND status != 'absent' AND (user_id = ? OR performer_user_id = ?)`)
    .get(d.duty_date, d.id, u.id, u.id) as { n: number }).n;
  if (busy + 1 > cfgNum("max_positions_per_person_per_day")) return "substitute_busy";
  return null;
}

/** People the manager may name as the substitute for an absent day. */
export function listSubstituteCandidates(dayId: number, branchId: number): Array<{ id: number; name: string }> {
  const d = loadDay(dayId);
  if (d.branch_id !== branchId) return [];
  const users = getDb().prepare(`SELECT u.id, u.display_name AS name FROM users u WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated')
      AND COALESCE(u.is_test_account,0) = 0 AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?) ORDER BY u.display_name`).all(branchId) as Array<{ id: number; name: string }>;
  return users.filter((u) => substituteProblem(d, u.id) === null);
}

export function assignSubstitute(args: { dayId: number; branchId: number; performerId: number; managerId: number; today?: string }): void {
  const d = loadDay(args.dayId);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  if (d.status !== "absent") throw new EvidenceError("wrong_status");
  const month = getMonth(d.branch_id, d.year_month);
  if (!WORKING.includes(month.status)) throw new EvidenceError("wrong_stage");
  const today = args.today ?? bkkToday();
  if (today > addDays(d.duty_date, cfgNum("evidence_deadline_days"))) throw new EvidenceError("deadline_passed");
  const problem = substituteProblem(d, args.performerId);
  if (problem) throw new EvidenceError(problem);
  getDb().prepare("UPDATE special_duty_days SET status = 'covered', performer_user_id = ? WHERE id = ?").run(args.performerId, d.id);
  audit({ actorId: args.managerId, branchId: d.branch_id, yearMonth: d.year_month, entity: "duty_day", entityId: d.id, action: "substitute", after: { performerId: args.performerId } });
}

// ── reading evidence ─────────────────────────────────────────────────────

export function dayBelongsToBranch(dayId: number, branchId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ? AND p.branch_id = ?").get(dayId, branchId);
}

export type EvidencePhoto = { id: number; filename: string; uploadedBy: number; uploadedAt: string; deleted: boolean };

export function listEvidence(dayId: number): EvidencePhoto[] {
  return (getDb().prepare("SELECT id, filename, uploaded_by AS ub, uploaded_at AS ua, deleted_at AS del FROM special_duty_evidence WHERE day_id = ? ORDER BY id")
    .all(dayId) as Array<{ id: number; filename: string; ub: number; ua: string; del: string | null }>)
    .map((r) => ({ id: r.id, filename: r.filename, uploadedBy: r.ub, uploadedAt: r.ua, deleted: r.del != null }));
}

/** May this person open this photo? The manager of its branch, or the person who took it. */
export function photoForViewer(photoId: number, viewer: { userId: number; manageBranchIds: number[] }): { path: string; ext: string } | null {
  const r = getDb().prepare("SELECT branch_id AS b, filename AS f, uploaded_by AS ub, deleted_at AS del FROM special_duty_evidence WHERE id = ?")
    .get(photoId) as { b: number; f: string; ub: number; del: string | null } | undefined;
  if (!r || r.del) return null;
  if (r.ub !== viewer.userId && !viewer.manageBranchIds.includes(r.b)) return null;
  const p = evidencePhotoPath(r.b, r.f);
  return p ? { path: p, ext: (r.f.split(".").pop() || "jpg").toLowerCase() } : null;
}

// ── retention ────────────────────────────────────────────────────────────

/** Delete photos older than the retention window (the row stays, marked deleted). Returns how many. */
export function sweepEvidence(today = bkkToday()): number {
  const db = getDb();
  const cutoff = new Date(Date.parse(`${addDays(today, -cfgNum("evidence_retention_days"))}T00:00:00+07:00`)).toISOString();
  const rows = db.prepare("SELECT id, branch_id AS b, filename AS f FROM special_duty_evidence WHERE deleted_at IS NULL AND uploaded_at < ?")
    .all(cutoff) as Array<{ id: number; b: number; f: string }>;
  let n = 0;
  for (const r of rows) {
    const p = evidencePhotoPath(r.b, r.f);
    if (p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
    db.prepare("UPDATE special_duty_evidence SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
    n++;
  }
  return n;
}
