import type { Metadata } from "next";
import { requireAdmin, getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { hasAdminPin } from "@/lib/admin-pin";
import {
  getActivePendingRequestsForApplications, toPendingTag
} from "@/lib/recruita-stage-request";
import { STAGE_META, type ApplicationStage, type PendingStageTag } from "@/lib/recruita";
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
  /** 1 when the candidate has a LINE userId bound (can receive push), 0 when
   *  not — surfaced as a badge so admins can spot who needs manual linking
   *  (owner 2026-06-13). Only the boolean is sent, never the userId itself. */
  line_linked: number;
  /** Progress signals surfaced as tags next to the name (owner 2026-06-14):
   *  1 = the candidate has booked an interview slot / uploaded a medical
   *  certificate. health_check_status drives the pass/fail tag. */
  has_interview: number;
  has_health_cert: number;
  health_check_status: "pending" | "passed" | "failed" | null;
  /** Active dual-approval request awaiting a second admin, or null.
   *  Drives the "รออนุมัติเปลี่ยนสถานะ" tag + approve/cancel on the card. */
  pending: PendingStageTag | null;
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
           a.submitted_at, a.updated_at, a.expected_salary, a.health_check_status,
           c.title_prefix, c.first_name_th, c.last_name_th, c.nickname_th, c.mobile_phone,
           (c.line_user_id IS NOT NULL) AS line_linked,
           (EXISTS (SELECT 1 FROM recruita_interview_slots s WHERE s.booked_application_id = a.id)) AS has_interview,
           (EXISTS (SELECT 1 FROM recruita_documents d WHERE d.candidate_id = c.id AND d.kind = 'health_cert')) AS has_health_cert,
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
        WHEN 'health_check' THEN 3
        WHEN 'offered' THEN 4
        WHEN 'accepted' THEN 5
        WHEN 'hired' THEN 6
        WHEN 'rejected' THEN 7
        WHEN 'withdrawn' THEN 8
      END,
      a.submitted_at DESC
    LIMIT 500
  `).all() as PipelineCard[];

  // Attach any active dual-approval request to its card so the board
  // shows the "รออนุมัติเปลี่ยนสถานะ" tag + approve/cancel inline.
  const pendingMap = getActivePendingRequestsForApplications(cards.map((c) => c.id));
  for (const c of cards) {
    const p = pendingMap.get(c.id);
    c.pending = p ? toPendingTag(p) : null;
  }

  const positions = db.prepare(`
    SELECT p.id, p.title, p.code,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id) AS application_count
    FROM recruita_positions p
    WHERE p.status != 'draft'
    ORDER BY p.opened_at DESC
  `).all() as PositionOpt[];

  // Viewer's PIN status + id — the board gates request/approve actions
  // on having a PIN, and enforces "approver ≠ requester" client-side
  // (server enforces it too).
  const sessionUser = getSessionUser();
  const viewerHasPin = sessionUser ? hasAdminPin(sessionUser.id) : false;
  const viewerUserId = sessionUser?.id ?? 0;

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
      <PipelineClient cards={cards} positions={positions} stageMeta={STAGE_META}
        viewerHasPin={viewerHasPin} viewerUserId={viewerUserId} />
    </div>
  );
}
