import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { checkupStatus, statusLabel, overallLabel, type HealthOverall } from "@/lib/health-checkup";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพของฉัน · IKIGAI OS PORTAL" };

// /staff/health/exams — the employee's OWN occupational-health exam
// results (food-handler cert / periodic / pre-placement / return-to-work),
// recorded by admin/doctor on /admin/persona/health. Read-only; the
// employee can open the attached PDF/image of each result. Scoped to
// user_id = self by the query, so no one sees another person's results.

const EXAM_TYPE_TH: Record<string, string> = {
  periodic: "ตรวจประจำปี",
  pre_placement: "ก่อนเริ่มงาน (ปัจจัยเสี่ยง)",
  return_to_work: "กลับเข้าทำงาน (หลังพัก)"
};

const STATUS_STYLE: Record<string, string> = {
  none: "bg-slate-100 text-slate-500",
  valid: "bg-emerald-100 text-emerald-700",
  expiring: "bg-amber-100 text-amber-700",
  expired: "bg-rose-100 text-rose-700"
};

type Row = {
  id: number;
  exam_type: string | null;
  checkup_date: string | null;
  expiry_date: string | null;
  clinic_name: string | null;
  doctor_name: string | null;
  cert_no: string | null;
  overall_result: HealthOverall | null;
  notes: string | null;
  attachment_url: string | null;
  file_path: string | null;
};

export default function MyExamsPage() {
  const user = requireUser();
  const rows = getDb().prepare(`
    SELECT id, exam_type, checkup_date, expiry_date, clinic_name, doctor_name,
           cert_no, overall_result, notes, attachment_url, file_path
    FROM health_checkups
    WHERE user_id = ?
    ORDER BY checkup_date DESC, id DESC
  `).all(user.id) as Row[];

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-slate-800">ผลตรวจสุขภาพของฉัน</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          ผลการตรวจสุขภาพที่บันทึกโดยฝ่ายบุคคล / แพทย์ — รวมใบรับรองผู้สัมผัสอาหาร (ส.ณ.11)
          ตรวจประจำปี และก่อนเริ่มงาน · เห็นเฉพาะผลของคุณเท่านั้น
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card text-sm text-slate-400 text-center py-8">
          ยังไม่มีผลตรวจสุขภาพในระบบ — เมื่อฝ่ายบุคคลหรือแพทย์บันทึกผลแล้ว จะปรากฏที่นี่
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const st = checkupStatus(r.expiry_date);
            return (
              <div key={r.id} className="card space-y-1.5">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="font-bold text-slate-800">
                      {EXAM_TYPE_TH[r.exam_type ?? "periodic"] ?? "ตรวจสุขภาพ"}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      วันที่ตรวจ {r.checkup_date ?? "—"}
                      {r.expiry_date && <> · หมดอายุ {r.expiry_date}</>}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${STATUS_STYLE[st]}`}>
                    {statusLabel(st)}
                  </span>
                </div>
                <div className="text-xs text-slate-600">
                  {r.clinic_name && <>สถานพยาบาล: {r.clinic_name} · </>}
                  {r.doctor_name && <>แพทย์: {r.doctor_name} · </>}
                  ผล: {r.overall_result ? overallLabel(r.overall_result) : "—"}
                </div>
                {r.notes && <div className="text-xs text-slate-500">หมายเหตุ: {r.notes}</div>}
                {(r.file_path || r.attachment_url) && (
                  <div className="pt-1">
                    <a
                      href={r.file_path ? apiUrl(`/api/health/exam-file/${r.id}`) : (r.attachment_url ?? "#")}
                      target="_blank" rel="noopener noreferrer"
                      className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 inline-block">
                      ดูไฟล์ผลตรวจ
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
