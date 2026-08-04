// /admin/persona/meetings/[id] — รายละเอียดการประชุม + เชคลิสต์งาน (owner 2026-08-04).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getMeeting, listActionItems } from "@/lib/meetings";
import MeetingDetailClient, { type StaffOption } from "./MeetingDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายละเอียดการประชุม · PERSONA" };

export default function MeetingDetailPage({ params }: { params: { id: string } }) {
  const user = requireAdmin();
  const db = getDb();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const meeting = getMeeting(db, id);
  if (!meeting) notFound();
  const items = listActionItems(db, id);

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
      <Link href="/admin/persona/meetings" className="text-sm text-brand hover:underline">← กลับรายการประชุม</Link>
      <MeetingDetailClient meeting={meeting} items={items} staff={staff} />
    </div>
  );
}
