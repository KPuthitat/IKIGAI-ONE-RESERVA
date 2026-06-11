import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getSystemSettings } from "@/lib/db";
import { listSlotsForAdmin, bookedSlotMinutes, listInterviewStageApplicants } from "@/lib/recruita-interview-slots";
import { todayBkk, timeToMinutes } from "@/lib/time";
import InterviewSlotsClient from "./InterviewSlotsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · นัดสัมภาษณ์" };

export default function InterviewSlotsPage() {
  requireAdmin();
  const lang = getLang();
  const slots = listSlotsForAdmin();
  const today = todayBkk();
  // Slot length is locked once a booking exists (owner 2026-06-11). The
  // current length (for defaulting the picker) is any slot's end − start.
  const lockedMinutes = bookedSlotMinutes();
  const currentMinutes = slots.length > 0
    ? timeToMinutes(slots[0].end_time) - timeToMinutes(slots[0].start_time)
    : null;
  // Interview-stage applicants an admin can book a slot for (owner 2026-06-11).
  const applicants = listInterviewStageApplicants();
  // Venue map/navigation link (shared with the invite-card button).
  const mapUrl = getSystemSettings().recruita_interview_map_url ?? "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.nav.interviewSlots")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          กำหนดช่วงเวลาสัมภาษณ์ให้ผู้สมัครเลือกเองผ่านหน้า &quot;ตรวจสอบสถานะใบสมัคร&quot; — ตั้งความยาวช่วงได้ เลือกแล้วช่วงนั้นจะถูกล็อกไม่ให้ซ้ำ
        </p>
      </div>
      <InterviewSlotsClient
        slots={slots}
        today={today}
        lockedMinutes={lockedMinutes}
        currentMinutes={currentMinutes}
        applicants={applicants}
        mapUrl={mapUrl} />
    </div>
  );
}
