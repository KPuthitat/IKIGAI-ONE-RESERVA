import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireClinicalEligible, isClinicOpen } from "@/lib/annual-checkup-api";
import ClinicPin from "./ClinicPin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ยืนยัน PIN · ตรวจสุขภาพประจำปี (คลินิก)" };

// The gate in front of every clinic screen of the annual check-up. Nothing about other people is shown until the clinician types their own PIN.
export default function ClinicPinPage({ searchParams }: { searchParams: { next?: string } }) {
  const user = requireClinicalEligible();
  const next = searchParams.next && searchParams.next.startsWith("/staff/health/annual-checkup") && !searchParams.next.startsWith("/staff/health/annual-checkup/pin") ? searchParams.next : "/staff/health/annual-checkup";
  if (isClinicOpen(user)) redirect(next);
  return (
    <div className="space-y-4 max-w-sm mx-auto">
      <h1 className="text-xl font-bold text-slate-800">ตรวจสุขภาพประจำปี (คลินิก)</h1>
      <ClinicPin next={next} />
      <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">← กลับหน้าหลัก</Link>
    </div>
  );
}
