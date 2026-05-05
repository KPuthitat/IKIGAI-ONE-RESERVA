"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Booking } from "@/lib/db";
import { apiUrl } from "@/lib/url";

type Row = Booking & { table_label: string | null };

const STATUS_LABEL: Record<Row["status"], string> = {
  confirmed: "รอลูกค้า",
  seated: "นั่งแล้ว",
  no_show: "ไม่มา",
  cancelled: "ยกเลิก",
  completed: "เสร็จสิ้น"
};

function originLabel(o: string): string {
  return ({
    sriracha: "ศรีราชา",
    chonburi: "ชลบุรี",
    other_province: "ต่างจังหวัด"
  } as Record<string, string>)[o] ?? o;
}

function formatSource(s: string | null): string {
  if (!s) return "";
  if (s.startsWith("[")) {
    try { return (JSON.parse(s) as string[]).join(", "); } catch { return s; }
  }
  return s;
}

export default function BookingsClient({
  bookings,
  tables,
  canEdit
}: {
  bookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function setStatus(id: number, status: Row["status"]) {
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    setBusyId(null);
    if (!res.ok) alert("เกิดข้อผิดพลาด");
    router.refresh();
  }

  async function assignTable(id: number, tableId: number | null) {
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/table`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table_id: tableId })
    });
    setBusyId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || "เกิดข้อผิดพลาด");
    }
    router.refresh();
  }

  if (bookings.length === 0) {
    return <div className="card text-slate-500 text-center py-10">ยังไม่มีการจองในวันนี้</div>;
  }

  return (
    <div className="space-y-3">
      {bookings.map((b) => (
        <div key={b.id} className={`card ${b.status === "cancelled" ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="text-2xl font-bold w-20">{b.booking_time}</div>
            <div className="flex-1 min-w-[200px]">
              <div className="font-medium flex items-center gap-2 flex-wrap">
                {b.customer_name}
                <span className="text-slate-500 font-normal">· {b.party_size} ที่นั่ง</span>
                {b.is_member === 1 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">สมาชิก</span>
                )}
                {b.is_member === 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">ยังไม่ใช่สมาชิก</span>
                )}
              </div>
              <div className="text-sm text-slate-500 flex flex-wrap gap-x-2">
                <a href={`tel:${b.customer_phone}`} className="text-brand">{b.customer_phone}</a>
                {b.source && <span>· รู้จักจาก {formatSource(b.source)}</span>}
                {b.customer_origin && <span>· มาจาก {originLabel(b.customer_origin)}</span>}
              </div>
              {b.notes && <div className="text-sm text-slate-600 mt-1">📝 {b.notes}</div>}
            </div>
            <div className="text-sm">
              <span className={`px-2 py-1 rounded text-xs status-${b.status}`}>
                {STATUS_LABEL[b.status]}
              </span>
              <div className="mt-1 text-slate-600">
                โต๊ะ:{" "}
                {canEdit ? (
                  <select
                    className="text-sm border rounded px-1"
                    value={b.table_id ?? ""}
                    onChange={(e) => assignTable(b.id, e.target.value ? Number(e.target.value) : null)}
                    disabled={busyId === b.id || b.status === "cancelled"}
                  >
                    <option value="">— ไม่กำหนด —</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>{t.label} ({t.capacity})</option>
                    ))}
                  </select>
                ) : (b.table_label ?? "—")}
              </div>
            </div>
          </div>

          {canEdit && b.status !== "cancelled" && b.status !== "completed" && (
            <div className="flex flex-wrap gap-2 mt-3 border-t border-slate-100 pt-3">
              {b.status === "confirmed" && (
                <button
                  onClick={() => setStatus(b.id, "seated")}
                  disabled={busyId === b.id}
                  className="btn-success"
                >✓ ลูกค้ามาแล้ว · ให้นั่ง</button>
              )}
              {b.status === "seated" && (
                <button
                  onClick={() => setStatus(b.id, "completed")}
                  disabled={busyId === b.id}
                  className="btn-secondary"
                >ปิดบิล / ลูกค้าออก</button>
              )}
              {b.status === "confirmed" && (
                <>
                  <button
                    onClick={() => setStatus(b.id, "no_show")}
                    disabled={busyId === b.id}
                    className="btn-secondary text-amber-700"
                  >ลูกค้าไม่มา</button>
                  <button
                    onClick={() => {
                      if (confirm("ยืนยันการยกเลิก? โต๊ะจะถูกปล่อยให้รับจองอื่นได้")) {
                        setStatus(b.id, "cancelled");
                      }
                    }}
                    disabled={busyId === b.id}
                    className="btn-danger"
                  >ยกเลิก</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
