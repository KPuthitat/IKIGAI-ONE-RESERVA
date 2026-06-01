import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { getRecruitaChannel } from "@/lib/messaging-channels";
import LiffCapture from "./LiffCapture";

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
  salary_type: "hourly" | "daily" | "monthly";
  vacancies: number;
  branch_id: number | null;
  branch_name: string | null;
};

const EMP_LABEL: Record<NonNullable<Row["employment_type"]>, string> = {
  ft: "Full-time", pt: "Part-time", contract: "Contract"
};

const SALARY_UNIT: Record<Row["salary_type"], string> = {
  monthly: "บาท/เดือน",
  daily:   "บาท/วัน",
  hourly:  "บาท/ชม."
};

function fmtSalary(
  min: number | null,
  max: number | null,
  type: Row["salary_type"]
): string {
  const unit = SALARY_UNIT[type];
  if (min == null && max == null) return "ตามตกลง";
  if (min != null && max != null) {
    return `${min.toLocaleString("th-TH")}–${max.toLocaleString("th-TH")} ${unit}`;
  }
  return `${(min ?? max ?? 0).toLocaleString("th-TH")}+ ${unit}`;
}

export default function PublicPositionsPage() {
  // Read the apply-LIFF id so we can mount <LiffCapture> below. This
  // is the single OAuth-consuming hop after liff.line.me — see the
  // header comment in LiffCapture.tsx for why it must live here and
  // not in ApplyClient. The channel may not be configured yet on a
  // fresh DB, in which case we just render the page without LIFF.
  const channel = getRecruitaChannel();
  const liffId = channel?.liff_id ?? null;

  const db = getDb();
  const positions = db.prepare(`
    SELECT p.id, p.code, p.title, p.department, p.employment_type,
           p.jd_summary, p.salary_min, p.salary_max, p.salary_type,
           p.vacancies,
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
      <LiffCapture liffId={liffId} />
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
            <div className="px-1 pb-1 border-b-2 border-amber-300/60">
              <h2 className="text-sm font-bold text-slate-800">{branch}</h2>
              <p className="text-[10px] text-slate-500">
                {list.length} ตำแหน่ง
              </p>
            </div>
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
                <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-slate-500 mt-1">
                  {p.department && <span>{p.department}</span>}
                  {p.employment_type && <span>{EMP_LABEL[p.employment_type]}</span>}
                  <span className="text-emerald-700 font-semibold">
                    {fmtSalary(p.salary_min, p.salary_max, p.salary_type)}
                  </span>
                  <span>รับ {p.vacancies} อัตรา</span>
                </div>
              </Link>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
