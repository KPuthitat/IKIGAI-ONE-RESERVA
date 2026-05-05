import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import BookingsClient from "../../admin/reserva/bookings/BookingsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "RESERVA · การจอง" };

type Row = Booking & { table_label: string | null };

// /staff/reserva — staff ดูการจอง + กดสถานะมาแล้ว/ไม่มา/ยกเลิก
// Layout/UX เบากว่าฝั่ง admin (ไม่มี nav module เพิ่ม)
export default function StaffReservaPage({ searchParams }: { searchParams: { date?: string } }) {
  const user = requireUser();
  if (!user.activeBranchId) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">บัญชีของคุณยังไม่ได้รับสิทธิ์เข้าสาขา</p>
        <Link href="/staff" className="btn-secondary">← กลับ</Link>
      </div>
    );
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const date = searchParams.date || todayBkk();

  const bookings = db.prepare(`
    SELECT b.*, t.label AS table_label
    FROM bookings b LEFT JOIN tables t ON b.table_id = t.id
    WHERE b.branch_id = ? AND b.booking_date = ?
    ORDER BY b.booking_time ASC, b.created_at ASC
  `).all(branch.id, date) as Row[];

  const allTables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY label"
  ).all(branch.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">← กลับ module</Link>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold">การจองของลูกค้า</h1>
          <p className="text-sm text-slate-500">{branch.name}</p>
        </div>
        <form className="ml-auto flex items-center gap-2">
          <label className="text-sm">วันที่</label>
          <input type="date" name="date" defaultValue={date} className="input w-auto" />
          <button className="btn-secondary">ดู</button>
        </form>
      </div>
      <BookingsClient
        bookings={bookings}
        tables={allTables as Array<{ id: number; label: string; capacity: number }>}
        canEdit={true}
      />
    </div>
  );
}
