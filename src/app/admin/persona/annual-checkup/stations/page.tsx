import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { listStationCatalogue } from "@/lib/annual-checkup-stations";
import StationsEditor from "./StationsEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สถานีตรวจสุขภาพประจำปี · PERSONA" };

// The owner / a clinic recorder confirms which stations exist on the day and which station each test belongs to. A person's route is the
// stations of the tests they are ordered (waived tests never create a station).
export default function StationsPage() {
  const user = requireAdmin();
  if (!canImportCheckup(user)) redirect("/admin?error=forbidden");
  const cat = listStationCatalogue();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สถานีตรวจสุขภาพประจำปี</h1>
        <p className="text-sm text-slate-500">กำหนดว่ามีสถานีอะไรบ้างและรายการตรวจแต่ละอย่างอยู่สถานีไหน พนักงานจะเห็นสถานีที่ต้องไปหลังเจ้าหน้าที่สแกนเช็กอิน · <Link className="text-brand hover:underline" href="/admin/persona/annual-checkup">กลับไปหน้านำเข้า</Link> · <Link className="text-brand hover:underline" href="/admin/persona/annual-checkup/stations/qr">พิมพ์ QR ประจำสถานี</Link></p>
      </div>
      <StationsEditor stations={cat.stations} tests={cat.tests} />
    </div>
  );
}
