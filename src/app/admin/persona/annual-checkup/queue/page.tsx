import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { listQueueForAdmin } from "@/lib/annual-checkup-db";
import QueueEditor from "./QueueEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ลำดับคิวตรวจสุขภาพประจำปี · PERSONA" };

// The owner / clinic recorder fixes queue numbers and appointment times after the import (the file only sets the starting numbers).
export default function QueueAdminPage({ searchParams }: { searchParams: { round?: string } }) {
  const user = requireAdmin();
  if (!canImportCheckup(user)) redirect("/admin?error=forbidden");
  const rounds = getDb().prepare("SELECT id, name, status, appt_time FROM annual_checkup_rounds ORDER BY id DESC").all() as Array<{ id: number; name: string; status: string; appt_time: string | null }>;
  const chosen = rounds.find((r) => String(r.id) === searchParams.round) ?? rounds[0];
  const rows = chosen ? listQueueForAdmin(user, chosen.id) : [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ลำดับคิวตรวจสุขภาพประจำปี</h1>
        <p className="text-sm text-slate-500">ลำดับเริ่มต้นมาจากคอลัมน์ “ลำดับ” ในไฟล์ Excel แก้ได้ที่นี่ ลำดับต้องไม่ซ้ำกันในรอบ · <Link className="text-brand hover:underline" href="/admin/persona/annual-checkup">กลับไปหน้านำเข้า</Link></p>
      </div>
      {rounds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rounds.map((r) => <Link key={r.id} href={`/admin/persona/annual-checkup/queue?round=${r.id}`} className={chosen && r.id === chosen.id ? "btn-primary text-sm" : "btn-secondary text-sm"}>{r.name}</Link>)}
        </div>
      )}
      {!chosen ? <div className="card p-4 text-sm text-slate-600">ยังไม่มีรอบตรวจ</div> : <QueueEditor roundId={chosen.id} roundName={chosen.name} defaultTime={chosen.appt_time} rows={rows.map((r) => ({ key: r.key, label: r.label, code: r.code, payer: r.payer, queue_no: r.queue_no, appt_time: r.appt_time, arrived: !!r.checked_in_at }))} />}
    </div>
  );
}
