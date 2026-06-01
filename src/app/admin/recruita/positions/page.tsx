import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import PositionsClient from "./PositionsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · ตำแหน่งงาน" };

// /admin/recruita/positions — list every open / draft / closed
// position. Super-admin only because recruitment criteria touch
// employment terms (salary range, JD) that aren't appropriate for
// branch-level admins to edit.

type Row = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_type: "hourly" | "daily" | "monthly";
  vacancies: number;
  status: "open" | "closed" | "draft";
  opened_at: string;
  closed_at: string | null;
  application_count: number;
  hired_count: number;
  custom_questions: string;
};

export default function RecruitaPositionsPage() {
  requireSuperAdmin();
  const lang = getLang();
  const db = getDb();
  const positions = db.prepare(`
    SELECT p.id, p.branch_id, b.name AS branch_name,
           p.code, p.title, p.department, p.employment_type,
           p.jd_summary, p.salary_min, p.salary_max, p.salary_type,
           p.vacancies,
           p.status, p.opened_at, p.closed_at, p.custom_questions,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id) AS application_count,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id AND a.stage = 'hired') AS hired_count
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    ORDER BY
      CASE p.status
        WHEN 'open' THEN 0
        WHEN 'draft' THEN 1
        WHEN 'closed' THEN 2
      END,
      p.opened_at DESC
  `).all() as Row[];

  const branches = db.prepare(
    "SELECT id, name FROM branches ORDER BY name"
  ).all() as Pick<Branch, "id" | "name">[];

  // Pull existing PERSONA roster positions so the "+ ตำแหน่งใหม่"
  // dialog can autocomplete against titles already in use elsewhere
  // in the org. De-duped by lowercase title so multiple branches with
  // the same role (e.g. "พยาบาลวิชาชีพ" at NAMA + AT-HOME) collapse to
  // one suggestion. Inactive positions still surface — admin may be
  // rehiring for a role that's currently dormant.
  const personaTitlesRaw = db.prepare(`
    SELECT title, description, branch_id
    FROM roster_positions
    ORDER BY title COLLATE NOCASE
  `).all() as Array<{ title: string; description: string | null; branch_id: number }>;
  const seen = new Set<string>();
  const personaTitles: Array<{ title: string; description: string | null }> = [];
  for (const r of personaTitlesRaw) {
    const key = r.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    personaTitles.push({ title: r.title.trim(), description: r.description });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.positions.title")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.recruita.positions.subtitle")}
        </p>
      </div>
      <PositionsClient positions={positions} branches={branches}
        personaTitles={personaTitles} />
    </div>
  );
}
