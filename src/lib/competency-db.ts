// Competency assessment — server data layer (owner 2026-06-23). Individual
// radar-chart skill assessment under ASCENDA. 1–5 scale; reviewer score below
// the dimension target = a weak point feeding development planning.

import { getDb } from "./db";

export const COMPETENCY_SCALE = 5;
export const GROUP_LABEL: Record<string, string> = {
  professional: "ทักษะวิชาชีพ", soft: "Soft skill", managing: "Managing skill"
};
export const TRACK_LABEL: Record<string, string> = {
  restaurant: "ร้านอาหาร", clinic: "คลินิก", admin: "แอดมิน/หลังบ้าน"
};

export type Dimension = { id: number; grp: string; name: string; description: string | null; default_target: number; sort_order: number };
export type CatalogItem = { id: number; track: string; grp: string; name: string };
export type AssessUser = { id: number; display_name: string; employment_type: string | null };
export type ScoreRow = {
  dimension_id: number; name: string; grp: string; description: string | null;
  self_score: number | null; reviewer_score: number | null; target_score: number; note: string | null;
};
export type Assessment = {
  id: number; user_id: number; period_key: string; track: string | null;
  reviewer_id: number | null; status: "draft" | "final"; note: string | null;
  user_name: string; reviewer_name: string | null;
};

export function listDimensions(): Dimension[] {
  return getDb().prepare(
    "SELECT id, grp, name, description, default_target, sort_order FROM competency_dimensions WHERE active = 1 ORDER BY sort_order, id"
  ).all() as Dimension[];
}

export function listCatalog(track?: string): CatalogItem[] {
  if (track) {
    return getDb().prepare(
      "SELECT id, track, grp, name FROM competency_items WHERE active = 1 AND track = ? ORDER BY grp, sort_order"
    ).all(track) as CatalogItem[];
  }
  return getDb().prepare(
    "SELECT id, track, grp, name FROM competency_items WHERE active = 1 ORDER BY track, grp, sort_order"
  ).all() as CatalogItem[];
}

/** Staff + admins who can be assessed (real accounts with an employment type). */
export function listAssessableUsers(): AssessUser[] {
  return getDb().prepare(`
    SELECT id, display_name, employment_type FROM users
    WHERE role IN ('staff','admin') AND employment_type IS NOT NULL AND is_test_account = 0
      AND status NOT IN ('disabled','resigned','terminated')
    ORDER BY display_name COLLATE NOCASE
  `).all() as AssessUser[];
}

function shapeAssessment(r: any): Assessment {
  return {
    id: r.id, user_id: r.user_id, period_key: r.period_key, track: r.track,
    reviewer_id: r.reviewer_id, status: r.status, note: r.note,
    user_name: r.user_name, reviewer_name: r.reviewer_name
  };
}

export function getAssessment(userId: number, periodKey: string): Assessment | null {
  const r = getDb().prepare(`
    SELECT a.*, u.display_name AS user_name, rv.display_name AS reviewer_name
    FROM competency_assessments a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users rv ON rv.id = a.reviewer_id
    WHERE a.user_id = ? AND a.period_key = ?
  `).get(userId, periodKey) as any;
  return r ? shapeAssessment(r) : null;
}

/** Get the assessment for (user, period), creating a draft + a score row per
 *  dimension (target = the dimension default) the first time it's opened. */
export function ensureAssessment(userId: number, periodKey: string, reviewerId: number, createdBy: number): Assessment {
  const db = getDb();
  const existing = getAssessment(userId, periodKey);
  if (existing) return existing;
  const tx = db.transaction(() => {
    const id = Number(db.prepare(
      "INSERT INTO competency_assessments (user_id, period_key, reviewer_id, created_by) VALUES (?, ?, ?, ?)"
    ).run(userId, periodKey, reviewerId, createdBy).lastInsertRowid);
    const ins = db.prepare("INSERT INTO competency_scores (assessment_id, dimension_id, target_score) VALUES (?, ?, ?)");
    for (const d of listDimensions()) ins.run(id, d.id, d.default_target);
    return id;
  });
  tx();
  return getAssessment(userId, periodKey)!;
}

/** Score rows for the form — one per active dimension (left-joined to saved
 *  scores so a newly-added dimension still appears, defaulting its target). */
export function getScores(assessmentId: number): ScoreRow[] {
  const db = getDb();
  const saved = new Map<number, any>();
  for (const s of db.prepare("SELECT * FROM competency_scores WHERE assessment_id = ?").all(assessmentId) as any[]) {
    saved.set(s.dimension_id, s);
  }
  return listDimensions().map((d) => {
    const s = saved.get(d.id);
    return {
      dimension_id: d.id, name: d.name, grp: d.grp, description: d.description,
      self_score: s?.self_score ?? null, reviewer_score: s?.reviewer_score ?? null,
      target_score: s?.target_score ?? d.default_target, note: s?.note ?? null
    };
  });
}

export type ScoreInput = { dimension_id: number; self_score?: number | null; reviewer_score?: number | null; target_score?: number | null; note?: string | null };

export function saveScores(assessmentId: number, rows: ScoreInput[]): void {
  const db = getDb();
  const up = db.prepare(`
    INSERT INTO competency_scores (assessment_id, dimension_id, self_score, reviewer_score, target_score, note)
    VALUES (@a, @d, @s, @r, @t, @n)
    ON CONFLICT (assessment_id, dimension_id) DO UPDATE SET
      self_score = @s, reviewer_score = @r, target_score = @t, note = @n
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      up.run({ a: assessmentId, d: r.dimension_id, s: r.self_score ?? null, r: r.reviewer_score ?? null, t: r.target_score ?? null, n: r.note ?? null });
    }
    db.prepare("UPDATE competency_assessments SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(assessmentId);
  });
  tx();
}

export function updateAssessment(assessmentId: number, d: { track?: string | null; status?: "draft" | "final"; note?: string | null; reviewer_id?: number | null }): void {
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  if (d.track !== undefined) { sets.push("track = ?"); vals.push(d.track); }
  if (d.status !== undefined) { sets.push("status = ?"); vals.push(d.status); }
  if (d.note !== undefined) { sets.push("note = ?"); vals.push(d.note); }
  if (d.reviewer_id !== undefined) { sets.push("reviewer_id = ?"); vals.push(d.reviewer_id); }
  if (!sets.length) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(assessmentId);
  getDb().prepare(`UPDATE competency_assessments SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Weak points = reviewer scored below the dimension target. */
export function weakPoints(scores: ScoreRow[]): Array<{ name: string; grp: string; reviewer: number; target: number }> {
  return scores
    .filter((s) => s.reviewer_score != null && s.reviewer_score < s.target_score)
    .map((s) => ({ name: s.name, grp: s.grp, reviewer: s.reviewer_score as number, target: s.target_score }));
}
