import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import LeaveClient, { type LeaveRow } from "./LeaveClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · การลา" };

export default function StaffLeavePage() {
  const user = requireUser();
  const db = getDb();

  const requests = db.prepare(`
    SELECT id, type, date_from, date_to, days, reason, status,
           decided_by, decided_at, decision_note, created_at
    FROM leave_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(user.id) as LeaveRow[];

  return <LeaveClient requests={requests} />;
}
