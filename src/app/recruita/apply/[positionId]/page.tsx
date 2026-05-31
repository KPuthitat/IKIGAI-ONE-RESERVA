import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { parseCustomQuestions } from "@/lib/recruita";
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
        />
      </main>
    </div>
  );
}
