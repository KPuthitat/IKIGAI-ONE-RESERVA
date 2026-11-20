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
        <p className="text-sm text-slate-500">พิมพ์แล้วติดที่แต่ละสถานี พนักงานที่เช็กอินแล้วสแกนด้วยมือถือเพื่อบันทึกว่าผ่านสถานีนั้น · <Link className="text-brand hover:underline" href="/admin/persona/annual-checkup/stations">กลับไปหน้าสถานี</Link></p>
        <p className="mt-1 text-xs text-slate-500">กดพิมพ์ด้วยเบราว์เซอร์ (Ctrl/Cmd + P) หนึ่งสถานีต่อหนึ่งหน้า</p>
      </div>
            <section className="card p-6 text-center space-y-3 break-after-page">
        <div className="text-sm text-slate-500">ตรวจสุขภาพประจำปี</div>
        <div className="text-3xl font-extrabold text-slate-900">ลงทะเบียน</div>
        <div className="inline-block bg-white p-3 rounded-xl border border-slate-200"><QrCode value={`${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(REGISTER_CODE))}`} size={300} /></div>
        <p className="text-base text-slate-700">สแกน QR นี้ด้วยมือถือเพื่อดูหมายเลขคิวและ QR ประจำตัวของท่าน แล้วแสดง QR ประจำตัวให้เจ้าหน้าที่สแกนเช็กอิน</p>
      </section>
      {stations.map((s) => (
        <section key={s.code} className="card p-6 text-center space-y-3 break-after-page">
          <div className="text-sm text-slate-500">สถานีตรวจสุขภาพประจำปี</div>
          <div className="text-3xl font-extrabold text-slate-900">{s.name_th}</div>
          <div className="inline-block bg-white p-3 rounded-xl border border-slate-200"><QrCode value={`${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(s.code))}`} size={300} /></div>
          <p className="text-base text-slate-700">เช็กอินแล้ว สแกน QR นี้ด้วยมือถือเมื่อตรวจเสร็จที่สถานีนี้</p>
        </section>
      ))}
    </div>
  );
}
