import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import PositionEditClient from "./PositionEditClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · แก้ไขตำแหน่ง" };

type Row = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  jd_full: string | null;
  requirements: string | null;
  benefits: string | null;
  salary_min: number | null;
  salary_max: number | null;
  vacancies: number;
  custom_questions: string;
  status: "open" | "closed" | "draft";
  opened_at: string;
  closed_at: string | null;
  application_count: number;
};

export default function RecruitaPositionEditPage(
  { params }: { params: { id: string } }
) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const position = db.prepare(`
    SELECT p.*, b.name AS branch_name,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id) AS application_count
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(id) as Row | undefined;
  if (!position) notFound();
  const branches = db.prepare(
    "SELECT id, name FROM branches ORDER BY name"
  ).all() as Pick<Branch, "id" | "name">[];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link href="/admin/recruita/positions"
            className="text-xs text-brand hover:underline">
            ← กลับรายการตำแหน่ง
          </Link>
          <h1 className="text-2xl font-bold text-slate-800 mt-1">
            แก้ไขตำแหน่ง · {position.title}
          </h1>
          <p className="text-sm text-slate-500">
            {position.application_count > 0
              ? `มีใบสมัครแล้ว ${position.application_count} รายการ — แก้ไขคำถามจะไม่กระทบใบสมัครเดิม`
              : "ยังไม่มีใบสมัคร — แก้ไขได้อิสระ"}
          </p>
        </div>
      </div>
      <PositionEditClient position={position} branches={branches} />
    </div>
  );
}
