import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb, getSystemSettings } from "@/lib/db";
import { parseCustomQuestions } from "@/lib/recruita";
import { getRecruitaChannel } from "@/lib/messaging-channels";
import ApplyClient from "./ApplyClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สมัครงาน · IKIGAI Recruit" };

type Row = {
  id: number;
  title: string;
  code: string | null;
  branch_name: string | null;
  department: string | null;
  custom_questions: string;
};

export default function ApplyPage({ params }: { params: { positionId: string } }) {
  const id = Number(params.positionId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const p = db.prepare(`
    SELECT p.id, p.title, p.code, p.department, p.custom_questions,
           b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ? AND p.status = 'open'
  `).get(id) as Row | undefined;
  if (!p) notFound();
  const customQuestions = parseCustomQuestions(p.custom_questions);

  // Pass through the RECRUITA OA's LIFF ID so the client can boot
  // the LIFF SDK + auto-capture the applicant's LINE userId when
  // they open this page via the Rich Menu / chat link. Web-form
  // applicants (no LIFF id, or LIFF init fails) get null and the
  // form works the same — just without the auto-bind.
  const liffId = getRecruitaChannel()?.liff_id ?? null;
  // Global privacy-policy URL (single source of truth — see
  // /admin/system-settings). Passed into the PDPA consent section so
  // the applicant can review the actual policy text before ticking
  // consent. NULL/empty = no "ดูนโยบาย" button rendered.
  const privacyPolicyUrl = getSystemSettings().privacy_policy_url ?? null;

  return (
    <div className="min-h-screen bg-amber-50/40 py-6 px-4">
      <main className="max-w-2xl mx-auto">
        <ApplyClient
          positionId={p.id}
          positionTitle={p.title}
          positionCode={p.code}
          branchName={p.branch_name}
          department={p.department}
          customQuestions={customQuestions}
          liffId={liffId}
          privacyPolicyUrl={privacyPolicyUrl}
        />
      </main>
    </div>
  );
}
