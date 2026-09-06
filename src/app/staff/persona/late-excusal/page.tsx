// /staff/persona/late-excusal — พนักงานขออนุโลมการมาสาย (owner 2026-09-05).
// กรอกวันที่มาสาย + เหตุผล → หัวหน้า/แอดมินอนุมัติ. วันที่อนุมัติจะไม่ถูกนับในเกณฑ์ 20%
// ที่ริบเซอร์วิสชาร์จ แต่ยังเก็บสถิติไว้.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMyExcusals } from "@/lib/late-excusals";
import LateExcusalClient from "./LateExcusalClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ขออนุโลมการมาสาย · PERSONA" };

export default function StaffLateExcusalPage({ searchParams }: { searchParams: { date?: string } }) {
  const user = requireUser();
  const db = getDb();
  const rows = listMyExcusals(db, user.id);
  const prefillDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? "") ? searchParams.date! : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">ขออนุโลมการมาสาย</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">
        หากมาสายโดยมีเหตุผลอันสมควร (เช่น ติดเรียน เลิกเรียนช้า มีประชุมด่วน) กรอกคำขอที่นี่เพื่อให้หัวหน้าพิจารณาอนุโลม
        เมื่ออนุมัติแล้ว วันนั้นจะไม่ถูกนับรวมในเกณฑ์การมาสายที่มีผลต่อเซอร์วิสชาร์จ
      </p>
      <LateExcusalClient rows={rows} prefillDate={prefillDate} />
    </div>
  );
}
