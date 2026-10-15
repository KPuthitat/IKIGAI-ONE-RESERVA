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
};

/** The offer behind this employee's hire, or null for people who were not hired through RECRUITA. */
export function hireOfferFor(userId: number): HireOffer | null {
  const r = getDb().prepare(`
    SELECT a.id, p.title AS position_title, a.hired_at, a.offer_start_date, a.offer_salary, a.offer_salary_type, a.offer_conditions
      FROM recruita_applications a LEFT JOIN recruita_positions p ON p.id = a.position_id
     WHERE a.hired_user_id = ?
     ORDER BY COALESCE(a.hired_at, a.submitted_at) DESC, a.id DESC LIMIT 1`).get(userId) as {
    id: number; position_title: string | null; hired_at: string | null; offer_start_date: string | null;
    offer_salary: number | null; offer_salary_type: string | null; offer_conditions: string | null;
  } | undefined;
  if (!r) return null;
  const conditions = (r.offer_conditions ?? "").trim();
  return {
    applicationId: r.id,
    positionTitle: r.position_title,
    hiredAt: r.hired_at,
    offerStartDate: r.offer_start_date,
    offerSalary: r.offer_salary,
    offerSalaryType: r.offer_salary_type === "monthly" || r.offer_salary_type === "hourly" ? r.offer_salary_type : null,
    conditions: conditions || null
  };
}
