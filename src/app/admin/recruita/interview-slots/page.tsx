import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listSlotsForAdmin } from "@/lib/recruita-interview-slots";
import { todayBkk } from "@/lib/time";
import InterviewSlotsClient from "./InterviewSlotsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · นัดสัมภาษณ์" };

export default function InterviewSlotsPage() {
  requireAdmin();
  const lang = getLang();
  const slots = listSlotsForAdmin();
  const today = todayBkk();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.nav.interviewSlots")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          กำหนดช่วงเวลาสัมภาษณ์ให้ผู้สมัครเลือกเองผ่านหน้า &quot;ตรวจสอบสถานะใบสมัคร&quot; — ช่วงละ 1 ชั่วโมง เลือกแล้วช่วงนั้นจะถูกล็อกไม่ให้ซ้ำ
        </p>
      </div>
      <InterviewSlotsClient slots={slots} today={today} />
    </div>
  );
}
