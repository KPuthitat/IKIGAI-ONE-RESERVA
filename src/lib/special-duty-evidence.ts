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

import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { advanceMonth, audit, cfgNum, getMonth } from "./special-duty";
import { isGroupEligible, isOnApprovedLeave, isOnRoster } from "./special-duty-rules";
import { sqlNameWithPrefix } from "./name";

export type EvidenceErrorCode =
  | "not_found" | "forbidden" | "wrong_stage" | "too_early" | "deadline_passed" | "wrong_status" | "not_present"
  | "photos_required" | "too_many_photos" | "photo_bad_format" | "photo_too_large" | "no_people_not_confirmed"
  | "days_must_match" | "note_required" | "substitute_invalid" | "substitute_same_person" | "substitute_busy" | "reason_required" | "change_pending";

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
  return addDays(base, cfgNum("evidence_deadline_days", d.branch_id));
}

const WORKING = ["special_published", "in_progress"];

// ── submit ────────────────────────────────────────────────────────────────

/** One set of photos for the jobs a person did on the same day (owner 2026-10-29: ทำสองงานในวันเดียว แนบรูปเดียว).
 *  Every listed day must be this person's, in the same branch and on the same date; the photos are stored once and
 *  each day gets its own evidence rows pointing at them, so each job is reviewed (and paid) on its own. */
export type PhotoMeta = { phash?: string | null; takenAt?: string | null };
export function submitEvidence(args: { dayId?: number; dayIds?: number[]; userId: number; photos: string[]; photoMeta?: PhotoMeta[]; noPeopleConfirmed: boolean; today?: string }): void {
  const db = getDb();
  const today = args.today ?? bkkToday();
  const ids = [...new Set(args.dayIds && args.dayIds.length > 0 ? args.dayIds : args.dayId != null ? [args.dayId] : [])];
  if (ids.length === 0) throw new EvidenceError("not_found");
  const days = ids.map(loadDay);
  const d = days[0];
  if (days.some((x) => x.branch_id !== d.branch_id || x.duty_date !== d.duty_date)) throw new EvidenceError("days_must_match");
  for (const x of days) {
    if (performerOf(x) !== args.userId) throw new EvidenceError("forbidden");
    if (x.status === "absent") throw new EvidenceError("wrong_status");
    if (!["booked", "assigned", "covered"].includes(x.status)) throw new EvidenceError("wrong_status");
    const m = getMonth(x.branch_id, x.year_month);
    if (!m.enabled || !WORKING.includes(m.status)) throw new EvidenceError("wrong_stage");
    if (today < x.duty_date) throw new EvidenceError("too_early");
    if (today > submitDeadline(x)) throw new EvidenceError("deadline_passed");
  }
  if (!args.noPeopleConfirmed) throw new EvidenceError("no_people_not_confirmed");
  const photos = args.photos ?? [];
  if (photos.length < cfgNum("evidence_min_photos", d.branch_id)) throw new EvidenceError("photos_required");
  if (photos.length > cfgNum("evidence_max_photos", d.branch_id)) throw new EvidenceError("too_many_photos");
  const shas = photos.map((p) => crypto.createHash("sha256").update(decodePhoto(p).buf).digest("hex"));   // format and size first, so a bad file is reported as such
  if (!wasPresent(args.userId, d.branch_id, d.duty_date)) throw new EvidenceError("not_present");

  const saved: string[] = [];
  try {
    for (const p of photos) saved.push(savePhoto(d.branch_id, p));
    const now = new Date().toISOString();
    const metaOf = (i: number) => {
      const m = args.photoMeta?.[i];
      const phash = m?.phash && /^[0-9a-f]{16}$/.test(m.phash) ? m.phash : null;
      const t = m?.takenAt ? Date.parse(m.takenAt) : NaN;
      return { phash, takenAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
    };
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO special_duty_evidence (day_id, branch_id, filename, uploaded_by, uploaded_at, sha256, phash, taken_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const x of days) {
        saved.forEach((f, i) => { const m = metaOf(i); ins.run(x.id, x.branch_id, f, args.userId, now, shas[i], m.phash, m.takenAt); });
        db.prepare("UPDATE special_duty_days SET status = 'submitted', submitted_at = ?, review_note = NULL WHERE id = ?").run(now, x.id);
        audit({ actorId: args.userId, branchId: x.branch_id, yearMonth: x.year_month, entity: "evidence", entityId: x.id, action: "submit", after: { photos: saved.length, sharedWith: days.length - 1 } });
        const m = getMonth(x.branch_id, x.year_month);
        if (m.status === "special_published") advanceMonth({ branchId: x.branch_id, yearMonth: x.year_month, to: "in_progress", actorId: args.userId });
      }
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
  if (busy + 1 > cfgNum("max_positions_per_person_per_day", d.branch_id)) return "substitute_busy";
  return null;
}

/** People the manager may name as the substitute for an absent day. */
export function listSubstituteCandidates(dayId: number, branchId: number): Array<{ id: number; name: string }> {
  const d = loadDay(dayId);
  if (d.branch_id !== branchId) return [];
  const users = getDb().prepare(`SELECT u.id, ${sqlNameWithPrefix("u")} AS name FROM users u WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated')
      AND COALESCE(u.is_test_account,0) = 0 AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?) ORDER BY u.display_name`).all(branchId) as Array<{ id: number; name: string }>;
  const current = performerOf(d);
  return users.filter((u) => u.id !== current && substituteProblem(d, u.id) === null);
}

// ── change the person doing a day (owner 2026-11-01) ──────────────────────
// For sick leave or any other reason the manager may hand a day to someone else BEFORE it is done — also in advance, and
// without the holder taking an absence strike. The reason is mandatory and kept with who was changed to whom.
export const REPLACE_REASONS = ["sick", "personal", "emergency", "other"] as const;
export type ReplaceReason = (typeof REPLACE_REASONS)[number];
export const REPLACE_REASON_TH: Record<ReplaceReason, string> = { sick: "ลาป่วย", personal: "ธุระส่วนตัว", emergency: "เหตุฉุกเฉิน", other: "อื่นๆ" };

export function replaceDutyWorker(args: { dayId: number; branchId: number; toUserId: number; reasonType: ReplaceReason; note?: string | null; managerId: number; today?: string }):
  { fromUserId: number; toUserId: number; holderId: number; positionName: string; date: string; reasonText: string; afterWork: boolean } {
  const d = loadDay(args.dayId);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  if (!REPLACE_REASONS.includes(args.reasonType)) throw new EvidenceError("reason_required");
  const note = (args.note ?? "").trim();
  if (args.reasonType === "other" && note.length < 3) throw new EvidenceError("reason_required");
  const month = getMonth(d.branch_id, d.year_month);
  if (!WORKING.includes(month.status)) throw new EvidenceError("wrong_stage");
  // Before the work is done, or after the evidence was sent (the person who REALLY did it is the one who is paid — the
  // reviewer fixes the name before approving; the status then stays "submitted").
  if (!["booked", "assigned", "covered", "submitted"].includes(d.status)) throw new EvidenceError("wrong_status");
  const today = args.today ?? bkkToday();
  if (d.status !== "submitted" && today > addDays(d.duty_date, cfgNum("evidence_deadline_days", d.branch_id))) throw new EvidenceError("deadline_passed");
  const afterWork = d.status === "submitted";
  const from = performerOf(d);
  if (args.toUserId === from) throw new EvidenceError("substitute_same_person");
  const db = getDb();
  if (args.toUserId === d.user_id) {
    // handing it back to the original holder
    db.prepare("UPDATE special_duty_days SET status = ?, performer_user_id = NULL WHERE id = ?").run(afterWork ? "submitted" : d.source, d.id);
  } else {
    const problem = substituteProblem(d, args.toUserId);
    if (problem) throw new EvidenceError(problem);
    db.prepare("UPDATE special_duty_days SET status = ?, performer_user_id = ? WHERE id = ?").run(afterWork ? "submitted" : "covered", args.toUserId, d.id);
  }
  // an employee's pending request for this day is settled by this change, whoever made it
  db.prepare("UPDATE special_duty_change_requests SET status = 'approved', decided_by = ?, decided_at = ?, final_user_id = ? WHERE day_id = ? AND status = 'pending'")
    .run(args.managerId, new Date().toISOString(), args.toUserId, d.id);
  db.prepare("INSERT INTO special_duty_replacements (day_id, from_user_id, to_user_id, reason_type, reason_note, by_user_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(d.id, from, args.toUserId, args.reasonType, note || null, args.managerId);
  audit({ actorId: args.managerId, branchId: d.branch_id, yearMonth: d.year_month, entity: "duty_day", entityId: d.id, action: "replace",
    before: { performer: from }, after: { performer: args.toUserId, reason: args.reasonType, note: note || null } });
  const pos = db.prepare("SELECT name FROM special_duty_positions WHERE id = ?").get(d.position_id) as { name: string };
  return { fromUserId: from, toUserId: args.toUserId, holderId: d.user_id, positionName: pos.name, date: d.duty_date,
    reasonText: `${REPLACE_REASON_TH[args.reasonType]}${note ? ` · ${note}` : ""}`, afterWork };
}

/** The latest change on a day, for the manager's detail panel. */
export type DayReplacement = { fromName: string; toName: string; reasonText: string; at: string };
export function latestReplacements(dayIds: number[]): Map<number, DayReplacement> {
  const out = new Map<number, DayReplacement>();
  if (dayIds.length === 0) return out;
  const rows = getDb().prepare(`
    SELECT r.day_id AS id, ${sqlNameWithPrefix("f")} AS fromName, ${sqlNameWithPrefix("t")} AS toName, r.reason_type AS type, r.reason_note AS note, r.created_at AS at
      FROM special_duty_replacements r JOIN users f ON f.id = r.from_user_id JOIN users t ON t.id = r.to_user_id
     WHERE r.day_id IN (${dayIds.map(() => "?").join(",")}) ORDER BY r.id`).all(...dayIds) as Array<{ id: number; fromName: string; toName: string; type: ReplaceReason; note: string | null; at: string }>;
  for (const r of rows) out.set(r.id, { fromName: r.fromName, toName: r.toName, reasonText: `${REPLACE_REASON_TH[r.type] ?? r.type}${r.note ? ` · ${r.note}` : ""}`, at: r.at });
  return out;
}

export function assignSubstitute(args: { dayId: number; branchId: number; performerId: number; managerId: number; today?: string }): void {
  const d = loadDay(args.dayId);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  if (d.status !== "absent") throw new EvidenceError("wrong_status");
  const month = getMonth(d.branch_id, d.year_month);
  if (!WORKING.includes(month.status)) throw new EvidenceError("wrong_stage");
  const today = args.today ?? bkkToday();
  if (today > addDays(d.duty_date, cfgNum("evidence_deadline_days", d.branch_id))) throw new EvidenceError("deadline_passed");
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

// ── duplicate-photo signals (owner 2026-10-29) ──────────────────────────
// Warnings for the manager, never a verdict: the same area is legitimately photographed every day, so only a
// byte-identical file or a near-identical picture (a resize / re-save of the same shot) is called a duplicate.

export const NEAR_DUPLICATE_BITS = 4;   // of the 64-bit difference hash; a fresh handheld shot of the same spot is usually > 10
export type EvidenceFlag = {
  kind: "identical" | "similar" | "older_photo"; photoId: number; takenAt?: string;
  other?: { dayId: number; date: string; positionName: string; performerName: string; status: string; branchName: string };
};

function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export function evidenceFlags(dayId: number): EvidenceFlag[] {
  const db = getDb();
  const d = loadDay(dayId);
  const mine = db.prepare("SELECT id, filename, sha256, phash, taken_at FROM special_duty_evidence WHERE day_id = ? ORDER BY id").all(dayId) as
    Array<{ id: number; filename: string; sha256: string | null; phash: string | null; taken_at: string | null }>;
  if (mine.length === 0) return [];
  const names = mine.map((m) => m.filename);
  // pictures sent for OTHER days (a photo shared by several jobs of one submission has the same filename — not a duplicate)
  const others = db.prepare(`
    SELECT e.id, e.day_id, e.sha256, e.phash, dd.duty_date AS date, pp.name AS pname, dd.status, b.name AS bname,
           ${sqlNameWithPrefix("u")} AS performer
      FROM special_duty_evidence e JOIN special_duty_days dd ON dd.id = e.day_id JOIN special_duty_positions pp ON pp.id = dd.position_id
      JOIN branches b ON b.id = pp.branch_id JOIN users u ON u.id = COALESCE(dd.performer_user_id, dd.user_id)
     WHERE e.day_id != ? AND e.filename NOT IN (${names.map(() => "?").join(",")}) AND (e.sha256 IS NOT NULL OR e.phash IS NOT NULL)
     ORDER BY e.id DESC LIMIT 4000`).all(dayId, ...names) as Array<{ id: number; day_id: number; sha256: string | null; phash: string | null; date: string; pname: string; status: string; bname: string; performer: string }>;
  const flags: EvidenceFlag[] = [];
  const who = (o: (typeof others)[number]) => ({ dayId: o.day_id, date: o.date, positionName: o.pname, performerName: o.performer, status: o.status, branchName: o.bname });
  for (const m of mine) {
    const same = m.sha256 ? others.find((o) => o.sha256 === m.sha256) : undefined;
    if (same) flags.push({ kind: "identical", photoId: m.id, other: who(same) });
    else if (m.phash) {
      let best: (typeof others)[number] | undefined, bestBits = 99;
      for (const o of others) { if (!o.phash) continue; const h = hamming(m.phash, o.phash); if (h < bestBits) { bestBits = h; best = o; } }
      if (best && bestBits <= NEAR_DUPLICATE_BITS) flags.push({ kind: "similar", photoId: m.id, other: who(best) });
    }
    if (m.taken_at) {
      const takenDay = new Date(Date.parse(m.taken_at) + 7 * 3600_000).toISOString().slice(0, 10);
      if (takenDay < d.duty_date) flags.push({ kind: "older_photo", photoId: m.id, takenAt: takenDay });
    }
  }
  return flags;
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
  // each branch keeps photos for its own number of days
  let n = 0;
  for (const { b: branch } of db.prepare("SELECT DISTINCT branch_id AS b FROM special_duty_evidence WHERE deleted_at IS NULL").all() as Array<{ b: number }>) {
    const cutoff = new Date(Date.parse(`${addDays(today, -cfgNum("evidence_retention_days", branch))}T00:00:00+07:00`)).toISOString();
    const rows = db.prepare("SELECT id, branch_id AS b, filename AS f FROM special_duty_evidence WHERE deleted_at IS NULL AND branch_id = ? AND uploaded_at < ?")
      .all(branch, cutoff) as Array<{ id: number; b: number; f: string }>;
    for (const r of rows) {
      const p = evidencePhotoPath(r.b, r.f);
      if (p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
      db.prepare("UPDATE special_duty_evidence SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
      n++;
    }
  }
  return n;
}

// ── an employee asks to change (owner 2026-11-01) ─────────────────────────
export type ChangeRequestView = {
  id: number; dayId: number; date: string; positionName: string; status: string;
  requesterId: number; requesterName: string; proposedId: number | null; proposedName: string | null;
  reasonText: string; reasonType: ReplaceReason; reasonNote: string | null; decisionNote: string | null; finalName: string | null; createdAt: string;
};
type ChangeRow = { id: number; day_id: number; requested_by: number; proposed_user_id: number | null; reason_type: ReplaceReason; reason_note: string | null; status: string; decision_note: string | null; final_user_id: number | null; created_at: string };

function changeView(r: ChangeRow): ChangeRequestView {
  const db = getDb();
  const name = (id: number | null) => id == null ? null : (db.prepare(`SELECT ${sqlNameWithPrefix("u")} AS n FROM users u WHERE u.id = ?`).get(id) as { n: string } | undefined)?.n ?? "";
  const d = db.prepare("SELECT d.duty_date AS date, p.name AS pname FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ?").get(r.day_id) as { date: string; pname: string };
  return {
    id: r.id, dayId: r.day_id, date: d.date, positionName: d.pname, status: r.status,
    requesterId: r.requested_by, requesterName: name(r.requested_by) ?? "", proposedId: r.proposed_user_id, proposedName: name(r.proposed_user_id),
    reasonText: `${REPLACE_REASON_TH[r.reason_type] ?? r.reason_type}${r.reason_note ? ` · ${r.reason_note}` : ""}`, reasonType: r.reason_type, reasonNote: r.reason_note,
    decisionNote: r.decision_note, finalName: name(r.final_user_id), createdAt: r.created_at
  };
}

/** Days this person could still ask to hand over, and who could take each — only their own days (they hold or perform them). */
export function candidatesForRequester(dayId: number, userId: number): Array<{ id: number; name: string }> {
  const d = loadDay(dayId);
  if (performerOf(d) !== userId) throw new EvidenceError("forbidden");
  return listSubstituteCandidates(dayId, d.branch_id);
}

export function requestDutyChange(args: { dayId: number; userId: number; proposedUserId?: number | null; reasonType: ReplaceReason; note?: string | null; today?: string }): number {
  const d = loadDay(args.dayId);
  if (performerOf(d) !== args.userId) throw new EvidenceError("forbidden");
  if (!REPLACE_REASONS.includes(args.reasonType)) throw new EvidenceError("reason_required");
  const note = (args.note ?? "").trim();
  if (args.reasonType === "other" && note.length < 3) throw new EvidenceError("reason_required");
  if (!WORKING.includes(getMonth(d.branch_id, d.year_month).status)) throw new EvidenceError("wrong_stage");
  if (!["booked", "assigned", "covered"].includes(d.status)) throw new EvidenceError("wrong_status");
  if ((args.today ?? bkkToday()) > addDays(d.duty_date, cfgNum("evidence_deadline_days", d.branch_id))) throw new EvidenceError("deadline_passed");
  const db = getDb();
  if (db.prepare("SELECT 1 FROM special_duty_change_requests WHERE day_id = ? AND status = 'pending'").get(d.id)) throw new EvidenceError("change_pending");
  const proposed = args.proposedUserId ?? null;
  if (proposed != null) {
    if (proposed === args.userId) throw new EvidenceError("substitute_same_person");
    const problem = proposed === d.user_id ? null : substituteProblem(d, proposed);
    if (problem) throw new EvidenceError(problem);
  }
  const id = Number(db.prepare("INSERT INTO special_duty_change_requests (day_id, requested_by, proposed_user_id, reason_type, reason_note) VALUES (?, ?, ?, ?, ?)")
    .run(d.id, args.userId, proposed, args.reasonType, note || null).lastInsertRowid);
  audit({ actorId: args.userId, branchId: d.branch_id, yearMonth: d.year_month, entity: "duty_day", entityId: d.id, action: "change_request", after: { proposed, reason: args.reasonType } });
  return id;
}

export function cancelDutyChange(args: { requestId: number; userId: number }): void {
  const r = getDb().prepare("SELECT * FROM special_duty_change_requests WHERE id = ?").get(args.requestId) as ChangeRow | undefined;
  if (!r) throw new EvidenceError("not_found");
  if (r.requested_by !== args.userId) throw new EvidenceError("forbidden");
  if (r.status !== "pending") throw new EvidenceError("wrong_status");
  getDb().prepare("UPDATE special_duty_change_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
}

/** The manager answers. Approving performs the replacement (to the proposed person unless the manager picks another). */
export function decideDutyChange(args: { requestId: number; branchId: number; managerId: number; approve: boolean; toUserId?: number | null; note?: string | null; today?: string }):
  { requesterId: number; requesterName: string; approved: boolean; replacement: ReturnType<typeof replaceDutyWorker> | null; positionName: string; date: string; decisionNote: string | null } {
  const db = getDb();
  const r = db.prepare("SELECT * FROM special_duty_change_requests WHERE id = ?").get(args.requestId) as ChangeRow | undefined;
  if (!r) throw new EvidenceError("not_found");
  const d = loadDay(r.day_id);
  if (d.branch_id !== args.branchId) throw new EvidenceError("not_found");
  if (r.status !== "pending") throw new EvidenceError("wrong_status");
  const note = (args.note ?? "").trim();
  const v = changeView(r);
  if (!args.approve) {
    if (note.length < 3) throw new EvidenceError("note_required");
    db.prepare("UPDATE special_duty_change_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(args.managerId, new Date().toISOString(), note, r.id);
    audit({ actorId: args.managerId, branchId: d.branch_id, yearMonth: d.year_month, entity: "duty_day", entityId: d.id, action: "change_reject", after: { note } });
    return { requesterId: r.requested_by, requesterName: v.requesterName, approved: false, replacement: null, positionName: v.positionName, date: v.date, decisionNote: note };
  }
  const to = args.toUserId ?? r.proposed_user_id;
  if (to == null) throw new EvidenceError("substitute_invalid");
  const rep = replaceDutyWorker({ dayId: d.id, branchId: args.branchId, toUserId: to, reasonType: r.reason_type, note: r.reason_note, managerId: args.managerId, today: args.today });
  if (note) db.prepare("UPDATE special_duty_change_requests SET decision_note = ? WHERE id = ?").run(note, r.id);
  return { requesterId: r.requested_by, requesterName: v.requesterName, approved: true, replacement: rep, positionName: v.positionName, date: v.date, decisionNote: note || null };
}

export function listPendingChanges(branchId: number, yearMonth: string): ChangeRequestView[] {
  return (getDb().prepare(`SELECT c.* FROM special_duty_change_requests c JOIN special_duty_days d ON d.id = c.day_id JOIN special_duty_positions p ON p.id = d.position_id
      WHERE p.branch_id = ? AND p.year_month = ? AND c.status = 'pending' ORDER BY d.duty_date, c.id`).all(branchId, yearMonth) as ChangeRow[]).map(changeView);
}

export function listMyChanges(userId: number, yearMonth: string): ChangeRequestView[] {
  return (getDb().prepare(`SELECT c.* FROM special_duty_change_requests c JOIN special_duty_days d ON d.id = c.day_id JOIN special_duty_positions p ON p.id = d.position_id
      WHERE c.requested_by = ? AND p.year_month = ? ORDER BY c.id DESC`).all(userId, yearMonth) as ChangeRow[]).map(changeView);
}
