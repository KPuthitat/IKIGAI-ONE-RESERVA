import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getRoundOverview, isAnnualCheckupInvalid } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "นำเข้าผลจากไฟล์แล็บ · NOKHOOK OS PORTAL" };

export default function LabImportPage({ params }: { params: { roundId: string } }) {
  const user = requireClinicalUser();
  const roundId = Number(params.roundId);
  if (!Number.isInteger(roundId) || roundId <= 0) notFound();
  let data: ReturnType<typeof getRoundOverview>;
  try { data = getRoundOverview(user, roundId); } catch (e) { if (isAnnualCheckupInvalid(e)) notFound(); throw e; }
  const coded = (getDb().prepare("SELECT COUNT(*) n FROM annual_checkup_exam_codes WHERE round_id = ?").get(roundId) as { n: number }).n;
  return (
    <div className="space-y-4">
      <Link href={`/staff/health/annual-checkup/${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อ</Link>
      <h1 className="text-xl font-bold text-slate-800">นำเข้าผลจากไฟล์แล็บ · {data.round.name}</h1>
      <ImportClient roundId={roundId} people={data.subjects.length} coded={coded} />
    </div>
  );
}
