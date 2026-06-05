import Link from "next/link";
import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getActiveConsent } from "@/lib/mounjaro-db";
import ConsentEditorClient from "./ConsentEditorClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PDPA ข้อมูลสุขภาพ · IKIGAI OS" };

// /admin/mounjaro-consent — super_admin edits the PDPA consent text shown
// to employees before they disclose health data / join a health program.
export default function MounjaroConsentPage() {
  requireSuperAdmin();
  const active = getActiveConsent();
  const updatedTh = active?.updated_at
    ? new Date(active.updated_at.replace(" ", "T") + "Z").toLocaleDateString("th-TH", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "long", day: "numeric"
      })
    : "—";

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">PDPA ข้อมูลสุขภาพ</h1>
        <p className="text-sm text-slate-500 mt-1">
          ข้อความยินยอมเปิดเผยข้อมูลทางสุขภาพ — แสดงให้พนักงานอ่านและกดยินยอมก่อน<b>สมัครใจ</b>
          เปิดเผยข้อมูลสุขภาพ / เข้าร่วมโครงการสุขภาพ · เมื่อแก้ไขเป็น<b>เวอร์ชันใหม่</b>
          พนักงานที่อยู่ในโครงการจะถูกขอให้กดยินยอมอีกครั้ง · อัปเดตล่าสุดเมื่อวันที่ <b>{updatedTh}</b>
        </p>
      </div>
      <ConsentEditorClient initialBody={active?.body ?? ""} />
    </div>
  );
}
