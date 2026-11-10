// The offer a person was hired on (RECRUITA), for the admin employee profile (owner 2026-10-13):
// special terms promised at offer time are easy to forget once probation is over, so HR can read
// them next to the employee's data. Read-only; one query on recruita_applications.hired_user_id.
import { getDb } from "./db";

export type HireOffer = {
  applicationId: number;
  positionTitle: string | null;
  hiredAt: string | null;
  offerStartDate: string | null;
  offerSalary: number | null;
  offerSalaryType: "monthly" | "hourly" | null;
  /** Free text typed at offer time; null when the offer carried no special terms. */
  conditions: string | null;
  /** How the offer was tied to the person: the hire bridge (hired_user_id) or — for people who
   *  were taken on without it — a name (+ birth date) match against an offered/accepted application. */
  matchedBy: "hire" | "name";
};

const PREFIX = /^(นางสาว|นาย|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|miss|ms\.?)\s*/i;
/** Name key for matching: prefix dropped, spaces/dots removed, lower-cased. */
export function offerNameKey(s: string | null | undefined): string {
  return String(s ?? "").trim().replace(PREFIX, "").replace(/[\s.]+/g, "").toLowerCase();
}

type OfferRow = {
  id: number; position_title: string | null; hired_at: string | null; offer_start_date: string | null;
  offer_salary: number | null; offer_salary_type: string | null; offer_conditions: string | null;
};
function toOffer(r: OfferRow, matchedBy: "hire" | "name"): HireOffer {
  const conditions = (r.offer_conditions ?? "").trim();
  return {
    applicationId: r.id,
    positionTitle: r.position_title,
    hiredAt: r.hired_at,
    offerStartDate: r.offer_start_date,
    offerSalary: r.offer_salary,
    offerSalaryType: r.offer_salary_type === "monthly" || r.offer_salary_type === "hourly" ? r.offer_salary_type : null,
    conditions: conditions || null,
    matchedBy
  };
}

const OFFER_COLS = `a.id, p.title AS position_title, a.hired_at, a.offer_start_date, a.offer_salary, a.offer_salary_type, a.offer_conditions`;

/** Offered / accepted / hired applications that carry offer terms but are NOT tied to any employee. */
function untiedOffers(): Array<OfferRow & { first: string | null; last: string | null; dob: string | null }> {
  return getDb().prepare(`
    SELECT ${OFFER_COLS}, c.first_name_th AS first, c.last_name_th AS last, c.dob AS dob
      FROM recruita_applications a
      JOIN recruita_candidates c ON c.id = a.candidate_id
      LEFT JOIN recruita_positions p ON p.id = a.position_id
     WHERE a.hired_user_id IS NULL AND a.stage IN ('offered', 'accepted', 'hired')
       AND (a.offer_salary IS NOT NULL OR a.offer_start_date IS NOT NULL OR TRIM(COALESCE(a.offer_conditions, '')) <> '')
     ORDER BY COALESCE(a.updated_at, a.submitted_at) DESC, a.id DESC`).all() as Array<OfferRow & { first: string | null; last: string | null; dob: string | null }>;
}

function matchByName(user: { display_name: string | null; dob: string | null }, cands: ReturnType<typeof untiedOffers>): HireOffer | null {
  const key = offerNameKey(user.display_name);
  if (!key) return null;
  const hit = cands.find((c) => offerNameKey(`${c.first ?? ""}${c.last ?? ""}`) === key && (!user.dob || !c.dob || user.dob === c.dob));
  return hit ? toOffer(hit, "name") : null;
}

/** The offer behind this employee's hire, or null when there is none to show. People taken on through the
 *  RECRUITA hire button are tied by hired_user_id; everyone else is matched by name (+ birth date when both
 *  have one) against offered/accepted applications that no employee is tied to. */
export function hireOfferFor(userId: number): HireOffer | null {
  const db = getDb();
  const r = db.prepare(`
    SELECT ${OFFER_COLS}
      FROM recruita_applications a LEFT JOIN recruita_positions p ON p.id = a.position_id
     WHERE a.hired_user_id = ?
     ORDER BY COALESCE(a.hired_at, a.submitted_at) DESC, a.id DESC LIMIT 1`).get(userId) as OfferRow | undefined;
  if (r) return toOffer(r, "hire");
  const u = db.prepare("SELECT display_name, dob FROM users WHERE id = ?").get(userId) as { display_name: string | null; dob: string | null } | undefined;
  return u ? matchByName(u, untiedOffers()) : null;
}

/** hireOfferFor for many people at once (the employee list): one candidate scan for all of them. */
export function hireOffersFor(userIds: number[]): Map<number, HireOffer> {
  const out = new Map<number, HireOffer>();
  if (userIds.length === 0) return out;
  const db = getDb();
  const ph = userIds.map(() => "?").join(",");
  const linked = db.prepare(`
    SELECT a.hired_user_id AS uid, ${OFFER_COLS}
      FROM recruita_applications a LEFT JOIN recruita_positions p ON p.id = a.position_id
     WHERE a.hired_user_id IN (${ph})
     ORDER BY COALESCE(a.hired_at, a.submitted_at) ASC, a.id ASC`).all(...userIds) as Array<OfferRow & { uid: number }>;
  for (const r of linked) out.set(r.uid, toOffer(r, "hire"));   // ascending → the newest record overwrites
  const rest = userIds.filter((id) => !out.has(id));
  if (rest.length) {
    const cands = untiedOffers();
    const users = db.prepare(`SELECT id, display_name, dob FROM users WHERE id IN (${rest.map(() => "?").join(",")})`).all(...rest) as Array<{ id: number; display_name: string | null; dob: string | null }>;
    for (const u of users) { const m = matchByName(u, cands); if (m) out.set(u.id, m); }
  }
  return out;
}
