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
