import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { listQueue } from "@/lib/annual-checkup-db";
import { requireClinicalUser } from "@/lib/annual-checkup-api";
import QueueClient from "./QueueClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เช็กอินตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

// Clinic staff: scan an employee's QR, confirm the check-in, and watch the whole round's queue. Clinic recorders only (gateway).
export default function QueuePage({ searchParams }: { searchParams: { round?: string } }) {
  const user = requireClinicalUser();
  const rounds = getDb().prepare("SELECT id, name, status FROM annual_checkup_rounds ORDER BY (status = 'open') DESC, id DESC").all() as Array<{ id: number; name: string; status: string }>;
  const chosen = rounds.find((r) => String(r.id) === searchParams.round) ?? rounds[0];
  const roster = chosen ? listQueue(user, chosen.id) : [];
  const stations = getDb().prepare("SELECT code, name_th FROM annual_checkup_stations WHERE active = 1 ORDER BY sort_no, id").all() as Array<{ code: string; name_th: string }>;
  return (
    <div className="space-y-4">
      <Link href="/staff/health/annual-checkup" className="text-sm text-slate-500 hover:text-brand">← รอบตรวจทั้งหมด</Link>
      <h1 className="text-xl font-bold text-slate-800">เช็กอินตรวจสุขภาพประจำปี</h1>
      {rounds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rounds.map((r) => <Link key={r.id} href={`/staff/health/annual-checkup/queue?round=${r.id}`} className={chosen && r.id === chosen.id ? "btn-primary text-sm" : "btn-secondary text-sm"}>{r.name}</Link>)}
        </div>
      )}
      {!chosen ? <div className="card p-4 text-sm text-slate-600">ยังไม่มีรอบตรวจ</div> : <QueueClient roundName={chosen.name} roster={roster} stations={stations} />}
    </div>
  );
}
