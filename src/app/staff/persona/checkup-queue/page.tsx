import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getMyQueue } from "@/lib/annual-checkup-db";
import QrCode from "@/app/components/QrCode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ลำดับตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

// The employee's own place in line for the annual check-up, with a QR the clinic scans on the day. The QR carries ONLY a random token
// (no name, no employee code — PDPA); the clinic looks the person up from it. Only the employee's own row is ever read (gateway).
const day = (iso: string) => new Date(`${iso}T00:00:00+07:00`).toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" });
const time = (hhmm: string) => `${hhmm} น.`;

export default function CheckupQueuePage() {
  const user = requireUser();
  const queues = getMyQueue(user);
  return (
    <div className="space-y-4 max-w-md mx-auto">
      <div>
        <h1 className="text-xl font-bold text-slate-800">ลำดับตรวจสุขภาพประจำปี</h1>
        <p className="text-sm text-slate-500">แสดง QR นี้ให้เจ้าหน้าที่คลินิกสแกนเมื่อมาถึง</p>
      </div>
      {queues.length === 0 && <div className="card p-5 text-sm text-slate-600">ยังไม่มีลำดับตรวจของท่านในรอบที่เปิดอยู่</div>}
      {queues.map((q) => (
        <section key={q.round_id} className="card p-5 space-y-4 text-center">
          <div className="text-sm font-semibold text-slate-700">{q.round_name}</div>
          <div>
            <div className="text-xs text-slate-500">ลำดับของท่าน</div>
            <div className="text-7xl font-extrabold leading-none text-brand tabular-nums" aria-label={`ลำดับที่ ${q.queue_no}`}>{q.queue_no}</div>
          </div>
          {q.checked_in_at ? (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">เช็กอินแล้ว กรุณารอเจ้าหน้าที่เรียกตามลำดับ</div>
          ) : (
            <div className="bg-white rounded-xl p-3 inline-block border border-slate-200">
              <QrCode value={q.checkin_token} size={220} />
            </div>
          )}
          <dl className="text-sm text-left space-y-1.5">
            <div className="flex justify-between gap-3"><dt className="text-slate-500">วันนัด</dt><dd className="text-slate-800 text-right">{q.date ? day(q.date) : "รอประกาศ"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-slate-500">เวลานัด</dt><dd className="text-slate-800 text-right">{q.appt_time ? time(q.appt_time) : "รอประกาศ"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-slate-500">สถานที่</dt><dd className="text-slate-800 text-right">{q.location ?? "รอประกาศ"}</dd></div>
          </dl>
          {q.checked_in_at ? (
            <div className="text-left space-y-2">
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 flex items-baseline justify-between gap-3">
                <span className="text-sm text-slate-600">หมายเลขชุดเก็บตัวอย่างของท่าน</span>
                <span className="text-xl font-bold tabular-nums text-slate-900">{q.kit_no ?? "รอเจ้าหน้าที่ระบุ"}</span>
              </div>
              <div className="text-sm font-semibold text-slate-700">สถานีที่ต้องไป ({q.stations.filter((x) => x.passed).length}/{q.stations.length})</div>
              {q.stations.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีสถานีสำหรับรายการตรวจของท่าน สอบถามเจ้าหน้าที่</p> : (
                <ol className="space-y-1.5">
                  {q.stations.map((st, i) => (
                    <li key={st.code} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${st.passed ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-slate-200 text-slate-800"}`}>
                      <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold ${st.passed ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"}`}>{st.passed ? "✓" : i + 1}</span>
                      <span className="grow">{st.name_th}</span>
                      <span className="text-xs">{st.passed ? "ผ่านแล้ว" : "ยังไม่ได้ตรวจ"}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">เมื่อเจ้าหน้าที่สแกนเช็กอินแล้ว ระบบจะแสดงสถานีที่ท่านต้องไปและหมายเลขชุดเก็บตัวอย่างที่นี่</p>
          )}
          <div className="text-left">
            <div className="text-sm font-semibold text-slate-700 mb-1">รายการตรวจของท่าน</div>
            {q.tests.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีรายการ</p> : (
              <ul className="text-sm text-slate-800 list-disc pl-5 space-y-0.5">{q.tests.map((t) => <li key={t.code}>{t.name_th}</li>)}</ul>
            )}
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 text-left">
            <b>คำแนะนำ:</b> งดน้ำและงดอาหาร 8 ชั่วโมงก่อนเข้ารับการตรวจ
          </div>
        </section>
      ))}
    </div>
  );
}
