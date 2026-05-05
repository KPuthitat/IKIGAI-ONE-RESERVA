import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import TimeClockClient from "./TimeClockClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลงเวลา" };

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

export default function StaffPersonaPage() {
  const user = requireUser();
  const db = getDb();

  // เอาเฉพาะ entries ของ user 7 วันล่าสุด (เก็บ <50 records ต่อคน)
  const entries = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND ts >= datetime('now', '-7 days')
    ORDER BY ts DESC LIMIT 100
  `).all(user.id) as TimeEntry[];

  // หา entry ล่าสุดวันนี้ (โซน Bangkok) เพื่อรู้ว่า currently in หรือ out
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayEntries = entries.filter((e) =>
    new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) === todayBkk
  );
  const lastTodayEntry = todayEntries[0];
  const isCurrentlyIn = lastTodayEntry?.type === "in";

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">← กลับ module</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">PERSONA — ลงเวลาทำงาน</h1>
      </div>
      <TimeClockClient
        userName={user.display_name}
        isCurrentlyIn={isCurrentlyIn}
        entries={entries}
      />
    </div>
  );
}
