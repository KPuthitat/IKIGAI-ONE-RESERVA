import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";
import PipelineClient from "./PipelineClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · Pipeline" };

export type PipelineCard = {
  id: number;
  candidate_id: number;
  position_id: number;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  stage: ApplicationStage;
  submitted_at: string;
  updated_at: string | null;
  title_prefix: string | null;
  first_name_th: string | null;
  last_name_th: string | null;
  nickname_th: string | null;
  mobile_phone: string | null;
  expected_salary: number | null;
};

type PositionOpt = {
  id: number; title: string; code: string | null; application_count: number;
};

export default function PipelinePage() {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const cards = db.prepare(`
    SELECT a.id, a.candidate_id, a.position_id, a.stage,
           a.submitted_at, a.updated_at, a.expected_salary,
           c.title_prefix, c.first_name_th, c.last_name_th, c.nickname_th, c.mobile_phone,
           p.title AS position_title, p.code AS position_code,
           b.name AS branch_name
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions p  ON p.id = a.position_id
    LEFT JOIN branches b ON b.id = p.branch_id
    ORDER BY
      CASE a.stage
        WHEN 'applied' THEN 0
        WHEN 'screening' THEN 1
        WHEN 'interview' THEN 2
        WHEN 'offered' THEN 3
        WHEN 'accepted' THEN 4
        WHEN 'hired' THEN 5
        WHEN 'rejected' THEN 6
        WHEN 'withdrawn' THEN 7
      END,
      a.submitted_at DESC
    LIMIT 500
  `).all() as PipelineCard[];

  const positions = db.prepare(`
    SELECT p.id, p.title, p.code,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id) AS application_count
    FROM recruita_positions p
    WHERE p.status != 'draft'
    ORDER BY p.opened_at DESC
  `).all() as PositionOpt[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.pipeline.title")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.recruita.pipeline.subtitle")}
        </p>
      </div>
      <PipelineClient cards={cards} positions={positions} stageMeta={STAGE_META} />
    </div>
  );
}
