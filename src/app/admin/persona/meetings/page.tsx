// /admin/persona/meetings — สรุปการประชุม + เชคลิสต์งานหลังประชุม (owner 2026-08-04).
// สร้างบันทึกการประชุม + มอบหมายงาน (action item) รายคน ติดตาม open/done ได้
// เพื่อให้มติที่ประชุม "มีคนทำ" จริง ไม่ใช่แค่คุยแล้วจบ.
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMeetings } from "@/lib/meetings";
import MeetingsClient, { type StaffOption } from "./MeetingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "การประชุม · PERSONA" };

export default function AdminMeetingsPage() {
  const user = requireAdmin();
  const db = getDb();

  const meetings = listMeetings(db, user.activeBranchId ?? null);

  // ผู้รับผิดชอบที่เลือกได้ — พนักงาน/แอดมินในสาขาที่ใช้งานอยู่ (mirror ot-approvals).
  const staff = (user.activeBranchId
    ? db.prepare(`
        SELECT DISTINCT u.id, u.display_name, u.title_prefix, u.nickname_th
        FROM users u
        INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
        WHERE u.role IN ('staff','admin')
          AND u.status NOT IN ('disabled','resigned','terminated')
          AND u.is_test_account = 0
        ORDER BY u.display_name COLLATE NOCASE
      `).all(user.activeBranchId)
    : []) as StaffOption[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">การประชุม</h1>
        <p className="text-sm text-slate-500 mt-1">
          บันทึกสรุปการประชุม + มอบหมายงานหลังประชุม ติดตามได้ว่าใครทำอะไร เสร็จหรือยัง
        </p>
      </div>
      <MeetingsClient meetings={meetings} staff={staff} />
    </div>
  );
}
