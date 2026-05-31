import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Row = {
  id: number;
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
  branch_name: string | null;
};

const EMP_LABEL: Record<NonNullable<Row["employment_type"]>, string> = {
  ft: "Full-time", pt: "Part-time", contract: "Contract"
};

function fmtSalary(min: number | null, max: number | null): string {
  if (min == null && max == null) return "ตามตกลง";
  if (min != null && max != null) return `฿${min.toLocaleString("th-TH")} – ฿${max.toLocaleString("th-TH")}`;
  return `฿${(min ?? max ?? 0).toLocaleString("th-TH")}+`;
}

export async function generateMetadata(
  { params }: { params: { id: string } }
): Promise<Metadata> {
  const db = getDb();
  const row = db.prepare(
    "SELECT title FROM recruita_positions WHERE id = ? AND status = 'open'"
  ).get(Number(params.id)) as { title: string } | undefined;
  return { title: row ? `${row.title} · IKIGAI Recruit` : "ตำแหน่ง · IKIGAI Recruit" };
}

export default function PublicPositionDetailPage(
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const p = db.prepare(`
    SELECT p.id, p.code, p.title, p.department, p.employment_type,
           p.jd_summary, p.jd_full, p.requirements, p.benefits,
           p.salary_min, p.salary_max, p.vacancies,
           b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ? AND p.status = 'open'
  `).get(id) as Row | undefined;
  if (!p) notFound();

  return (
    <div className="min-h-screen bg-amber-50/40 py-6 px-4">
      <main className="max-w-2xl mx-auto space-y-4">
        <Link href="/recruita/positions"
          className="text-xs text-brand hover:underline">
          ← กลับรายการตำแหน่ง
        </Link>

        <div className="card space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {p.code && (
              <span className="text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-2 py-1 rounded">
                {p.code}
              </span>
            )}
            <h1 className="text-2xl font-bold text-slate-800">{p.title}</h1>
          </div>

          <div className="flex items-center gap-3 flex-wrap text-sm text-slate-600">
            {p.branch_name && <span>📍 {p.branch_name}</span>}
            {p.department && <span>🏷 {p.department}</span>}
            {p.employment_type && <span>⏰ {EMP_LABEL[p.employment_type]}</span>}
            <span className="text-emerald-700 font-bold">💰 {fmtSalary(p.salary_min, p.salary_max)}</span>
            <span>👥 รับ {p.vacancies} อัตรา</span>
          </div>

          {p.jd_summary && (
            <p className="text-sm text-slate-700 leading-relaxed">{p.jd_summary}</p>
          )}
        </div>

        {p.jd_full && (
          <div className="card space-y-2">
            <h2 className="font-bold text-slate-800 text-sm">รายละเอียดงาน</h2>
            <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{p.jd_full}</div>
          </div>
        )}

        {p.requirements && (
          <div className="card space-y-2">
            <h2 className="font-bold text-slate-800 text-sm">คุณสมบัติที่ต้องการ</h2>
            <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{p.requirements}</div>
          </div>
        )}

        {p.benefits && (
          <div className="card space-y-2">
            <h2 className="font-bold text-slate-800 text-sm">สิทธิประโยชน์</h2>
            <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{p.benefits}</div>
          </div>
        )}

        <div className="sticky bottom-2 z-10">
          <Link href={`/recruita/apply/${p.id}`}
            className="btn-primary w-full text-base py-3 shadow-lg block text-center">
            📝 สมัครงานตำแหน่งนี้
          </Link>
        </div>
      </main>
    </div>
  );
}
