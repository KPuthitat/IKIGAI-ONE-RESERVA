// /staff/persona/tasks — งานที่ได้รับมอบหมายจากการประชุม (owner 2026-08-04).
// พนักงานเห็นงานที่ถูกมอบหมายให้ตัวเอง + กดปิดงานเมื่อทำเสร็จ.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMyActionItems } from "@/lib/meetings";
import MyTasksClient from "./MyTasksClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "งานที่ได้รับมอบหมาย · PERSONA" };

export default function StaffTasksPage() {
  const user = requireUser();
  const db = getDb();
  const items = listMyActionItems(db, user.id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">งานที่ได้รับมอบหมาย</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">งานจากที่ประชุมที่มอบหมายให้คุณ — ทำเสร็จแล้วกดเครื่องหมายถูก</p>
      <MyTasksClient items={items} />
    </div>
  );
}
