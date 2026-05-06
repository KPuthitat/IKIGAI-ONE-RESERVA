import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computeMinLastWorkingDay } from "@/lib/leave";
import ResignationClient, { type ResignationRow } from "./ResignationClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลาออก" };

export default function StaffResignationPage() {
  const user = requireUser();
  const db = getDb();

  const requests = db.prepare(`
    SELECT id, proposed_last_day, computed_min_last_day, reason, evidence_filename,
           is_special_request, status, decided_by, decided_at, decision_note, created_at
    FROM resignation_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(user.id) as ResignationRow[];

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const minLastDay = computeMinLastWorkingDay(todayBkk);

  const hasPending = requests.some((r) => r.status === "pending");

  return (
    <ResignationClient
      requests={requests}
      todayBkk={todayBkk}
      minLastDay={minLastDay}
      hasPending={hasPending}
    />
  );
}
