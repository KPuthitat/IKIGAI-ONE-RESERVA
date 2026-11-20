import ClinicLock from "./ClinicLock";
import type { Metadata } from "next";
import Link from "next/link";
import { isApproverUser, listRoundsClinical } from "@/lib/annual-checkup-db";
import { requireClinicalUser, unlockExpiry } from "@/lib/annual-checkup-api";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import UnlockPanel from "./UnlockPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพประจำปี (คลินิก) · NOKHOOK OS PORTAL" };

// /staff/health/annual-checkup — for the clinic's result recorders and approver doctors (checked live on every request).
export default function AnnualCheckupRoundsPage() {
  const user = requireClinicalUser();
  const rounds = listRoundsClinical(user);
  const approver = isApproverUser(user.id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-800">ผลตรวจสุขภาพประจำปี</h1>
          <p className="text-sm text-slate-500">ลงผลตรวจ แนบไฟล์ผลแล็บ และ{approver ? "ตรวจสอบ/เปิดผลให้พนักงาน" : "ส่งให้แพทย์ตรวจสอบ"} · ทุกการเปิดดูและแก้ไขมีบันทึกไว้</p>
        </div>
        <Link href="/staff/health/annual-checkup/queue" className="btn-primary text-sm">เช็กอิน / คิวตรวจ</Link>
        {canImportCheckup(user) && <Link href="/admin/persona/annual-checkup" className="btn-secondary text-sm">นำเข้ารายชื่อจาก Excel</Link>}
        <ClinicLock />
      </div>
      {approver && <UnlockPanel unlockedUntil={unlockExpiry(user)} />}
      <div className="card overflow-x-auto">
        {rounds.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีรอบตรวจ — นำเข้ารายชื่อจากไฟล์ Excel เพื่อสร้างรอบ</p> : (
          <table className="w-full text-sm min-w-[560px]">
            <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-2 pr-3">รอบ</th><th className="py-2 pr-3 text-right">คน</th><th className="py-2 pr-3 text-right">ลงผลแล้ว</th><th className="py-2 pr-3 text-right">ตรวจสอบแล้ว</th><th className="py-2 pr-3 text-right">เปิดผลแล้ว</th></tr></thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3"><Link href={`/staff/health/annual-checkup/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link></td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.subjects}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.recorded}/{r.required}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.verified}/{r.required}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.released}/{r.required}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
