"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { thaiDate, type SalesBase } from "@/lib/revshare";

type Partner = {
  id: number; name: string; venue: string | null; start_date: string;
  sales_base: SalesBase; pos_categories: string[]; active: boolean;
};

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export default function RevshareHomeClient({ initialPartners }: { initialPartners: Partner[] }) {
  const router = useRouter();
  const [partners, setPartners] = useState<Partner[]>(initialPartners);
  const [adding, setAdding] = useState(initialPartners.length === 0);
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [startDate, setStartDate] = useState(todayBkk());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/revshare/partners"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), venue: venue.trim() || undefined, start_date: startDate })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "สร้างคู่ค้าไม่สำเร็จ")); return; }
      setPartners(j.partners);
      setName(""); setVenue(""); setAdding(false);
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {partners.length > 0 && (
        <div className="space-y-2">
          {partners.map((p) => (
            <div key={p.id} className={`card space-y-3 ${p.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-bold text-slate-800">{p.name}{!p.active && <span className="text-[11px] text-slate-400 ml-2">ปิดใช้งาน</span>}</div>
                  <div className="text-[11px] text-slate-400">
                    {p.venue ? `${p.venue} · ` : ""}เริ่มสัญญา {thaiDate(p.start_date)}
                    {p.pos_categories.length > 0 ? ` · หมวด POS: ${p.pos_categories.join(", ")}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={`/admin/accounta/revshare/rounds?partner=${p.id}`}
                  className="rounded-full bg-brand text-white px-3 py-1.5 text-sm font-medium hover:bg-brand-dark">รอบยอดขาย / นำเข้าไฟล์</Link>
                <Link href={`/admin/accounta/revshare/settlement?partner=${p.id}`}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">สรุปยอด / สร้างใบวางบิล</Link>
                <Link href={`/admin/accounta/revshare/config?partner=${p.id}`}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">ตั้งค่าคู่ค้า</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="card space-y-3">
          <div className="text-sm font-bold text-slate-800">เพิ่มคู่ค้าใหม่</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="sm:col-span-1">
              <label className="label">ชื่อคู่ค้า</label>
              <input className="input" value={name} maxLength={120} placeholder="เช่น Groggy and Friends"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">จุดขาย/พื้นที่ (ถ้ามี)</label>
              <input className="input" value={venue} maxLength={120} placeholder="เช่น บาร์เครื่องดื่ม"
                onChange={(e) => setVenue(e.target.value)} />
            </div>
            <div>
              <label className="label">วันเริ่มสัญญา</label>
              <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          </div>
          <p className="text-[11px] text-slate-400">เมื่อสร้างแล้ว ระบบจะใส่ขั้นบันได GP + ยอดขั้นต่ำเริ่มต้น (แบบ Groggy) ให้ — แก้ไขได้ในหน้าตั้งค่า</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={create} disabled={busy || !name.trim()} className="btn-primary text-sm disabled:opacity-50">สร้างคู่ค้า</button>
            {partners.length > 0 && <button type="button" onClick={() => setAdding(false)} disabled={busy} className="btn-secondary text-sm">ยกเลิก</button>}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="btn-secondary text-sm">+ เพิ่มคู่ค้า</button>
      )}
    </div>
  );
}
