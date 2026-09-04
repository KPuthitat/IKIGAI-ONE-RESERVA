// /staff/quality — พนักงานอ่านเอกสารคุณภาพ (WI/WP) ที่มีผลบังคับใช้ แล้วกดรับทราบ.
// Owner 2026-09-04: staff read + acknowledge side of the WI/WP control system.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listEffectiveForStaff } from "@/lib/quality-docs";
import StaffQualityClient from "./StaffQualityClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เอกสารคุณภาพ · PERSONA" };

export default function StaffQualityPage() {
  const user = requireUser();
  const db = getDb();
  const docs = listEffectiveForStaff(db, user.id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">เอกสารคุณภาพ (WI/WP)</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">
        วิธีปฏิบัติงานและระเบียบปฏิบัติที่มีผลบังคับใช้ — อ่านแล้วกด “รับทราบ” เพื่อยืนยันว่าได้รับทราบเนื้อหาแล้ว
      </p>
      <StaffQualityClient docs={docs} />
    </div>
  );
}
