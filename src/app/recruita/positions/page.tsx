import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตำแหน่งที่เปิดรับ · IKIGAI Recruit" };

// /recruita/positions — public-facing list of every position with
// status='open'. No auth required; applicants arrive here from the
// LINE OA rich menu or a job-post link. The detail page handles the
// actual "apply" CTA.

type Row = {
  id: number;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  salary_min: number | null;
  salary_max: number | null;
  vacancies: number;
  branch_id: number | null;
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

export default function PublicPositionsPage() {
  const db = getDb();
  const positions = db.prepare(`
    SELECT p.id, p.code, p.title, p.department, p.employment_type,
           p.jd_summary, p.salary_min, p.salary_max, p.vacancies,
           p.branch_id, b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.status = 'open'
    ORDER BY p.opened_at DESC
  `).all() as Row[];

  // Group by branch for cleaner browse
  const groups = new Map<string, Row[]>();
  for (const p of positions) {
    const key = p.branch_name ?? "ทุกสาขา";
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  return (
    <div className="min-h-screen bg-amber-50/40 py-6 px-4">
      <main className="max-w-2xl mx-auto space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-slate-800">ร่วมงานกับเรา</h1>
          <p className="text-sm text-slate-500">
            กลุ่มบริษัท อิคิไก ฟอร์ออล · ตำแหน่งที่เปิดรับสมัคร {positions.length} ตำแหน่ง
          </p>
        </div>

        {positions.length === 0 && (
          <div className="card text-center text-slate-400 py-12">
            <p className="text-base">ขณะนี้ยังไม่มีตำแหน่งที่เปิดรับ</p>
            <p className="text-xs mt-1">กรุณาติดตามใหม่อีกครั้งในภายหลัง</p>
          </div>
        )}

        {[...groups.entries()].map(([branch, list]) => (
          <section key={branch} className="space-y-2">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-[2px] px-1">
              📍 {branch}
            </h2>
            {list.map((p) => (
              <Link key={p.id} href={`/recruita/positions/${p.id}`}
                className="card flex flex-col gap-1.5 hover:shadow-md transition-shadow">
                <div className="flex items-center gap-2 flex-wrap">
                  {p.code && (
                    <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                      {p.code}
                    </span>
                  )}
                  <h3 className="font-bold text-slate-800">{p.title}</h3>
                </div>
                {p.jd_summary && (
                  <p className="text-xs text-slate-600 line-clamp-2">{p.jd_summary}</p>
                )}
                <div className="flex items-center gap-3 flex-wrap text-xs text-slate-500 mt-1">
                  {p.department && <span>🏷 {p.department}</span>}
                  {p.employment_type && <span>⏰ {EMP_LABEL[p.employment_type]}</span>}
                  <span className="text-emerald-700 font-semibold">💰 {fmtSalary(p.salary_min, p.salary_max)}</span>
                  <span>👥 {p.vacancies} อัตรา</span>
                </div>
              </Link>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
