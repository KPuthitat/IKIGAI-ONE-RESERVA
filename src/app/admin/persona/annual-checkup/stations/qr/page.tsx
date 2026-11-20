import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { listStationCatalogue } from "@/lib/annual-checkup-stations";
import { makeStationToken, REGISTER_CODE } from "@/lib/annual-checkup-session";
import QrCode from "@/app/components/QrCode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QR ประจำสถานีตรวจสุขภาพ · PERSONA" };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

// One printable QR per active station (owner 2026-11-20). Stick it at the station; an employee who has checked in scans it with their
// phone to record "ผ่านการตรวจแล้ว" for that station. The QR carries only a signed station code (no personal data).
export default function StationQrPage() {
  const user = requireAdmin();
  if (!canImportCheckup(user)) redirect("/admin?error=forbidden");
  const stations = listStationCatalogue().stations.filter((s) => s.active === 1);
  return (
    <div className="space-y-4">
      <div className="print:hidden">
        <h1 className="text-2xl font-bold text-slate-800">QR ประจำสถานีตรวจสุขภาพ</h1>
        <p className="text-sm text-slate-500">กดปุ่มสั่งพิมพ์ด้านล่างเพื่อพิมพ์ป้าย QR ขนาด A4 สำหรับติดที่แต่ละสถานี พนักงานที่ลงทะเบียนแล้วสแกนด้วยโทรศัพท์มือถือเพื่อบันทึกว่าผ่านสถานีนั้น (ด้านล่างเป็นภาพตัวอย่างบนหน้าจอ) · <Link className="text-brand hover:underline" href="/admin/persona/annual-checkup/stations">กลับไปหน้าสถานี</Link></p>
        <a href="/print/annual-checkup-stations" target="_blank" rel="noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-base font-bold text-white shadow-md"
          style={{ background: "linear-gradient(100deg,#1CC4B1,#0FA596)" }}>🖨️ สั่งพิมพ์ป้าย QR ประจำสถานี (กระดาษ A4)</a>
      </div>
            <section className="card p-6 text-center space-y-3 break-after-page">
        <div className="text-sm text-slate-500">ตรวจสุขภาพประจำปี</div>
        <div className="text-3xl font-extrabold text-slate-900">ลงทะเบียน</div>
        <div className="inline-block bg-white p-3 rounded-xl border border-slate-200"><QrCode value={`${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(REGISTER_CODE))}`} size={300} /></div>
        <p className="text-base text-slate-700">กรุณาสแกน QR นี้ด้วยโทรศัพท์มือถือเพื่อดูหมายเลขคิวและ QR ประจำตัวของท่าน แล้วแสดงต่อเจ้าหน้าที่เพื่อเช็กอิน</p>
      </section>
      {stations.map((s) => (
        <section key={s.code} className="card p-6 text-center space-y-3 break-after-page">
          <div className="text-sm text-slate-500">สถานีตรวจสุขภาพประจำปี</div>
          <div className="text-3xl font-extrabold text-slate-900">{s.name_th}</div>
          <div className="inline-block bg-white p-3 rounded-xl border border-slate-200"><QrCode value={`${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(s.code))}`} size={300} /></div>
          <p className="text-base text-slate-700">เมื่อตรวจเสร็จที่สถานีนี้ กรุณาสแกน QR นี้ด้วยโทรศัพท์มือถือ</p>
        </section>
      ))}
    </div>
  );
}
