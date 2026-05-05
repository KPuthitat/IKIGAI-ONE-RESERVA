"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";

type TableOption = {
  id: number;
  label: string;
  capacity: number;
  shape: string;
  fitScore: number;
};

const SOURCES = ["Instagram", "Facebook", "TikTok", "Google Maps", "เพื่อนแนะนำ", "ผ่านมาเห็น", "อื่นๆ"];

export default function BookingForm({ branch }: { branch: Branch }) {
  const router = useRouter();
  const today = useMemo(() => {
    const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }, []);

  const [form, setForm] = useState({
    customer_name: "",
    customer_phone: "",
    party_size: 2,
    booking_date: today,
    booking_time: "18:00",
    source: "",
    notes: "",
    line_user_id: ""
  });
  const [step, setStep] = useState<"form" | "choose" | "done">("form");
  const [suggestions, setSuggestions] = useState<TableOption[]>([]);
  const [chosenTable, setChosenTable] = useState<number | "auto" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultId, setResultId] = useState<number | null>(null);

  const slots = useMemo(() => {
    const out: string[] = [];
    const [oh, om] = branch.open_time.split(":").map(Number);
    const [ch, cm] = branch.close_time.split(":").map(Number);
    const start = oh * 60 + om;
    const end = ch * 60 + cm;
    for (let m = start; m + branch.default_duration_minutes <= end; m += branch.slot_minutes) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
    return out;
  }, [branch]);

  async function findTables(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.customer_name.trim() || !form.customer_phone.trim()) {
      setError("กรุณากรอกชื่อและเบอร์โทรศัพท์");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/bookings/suggest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_slug: branch.slug,
          party_size: form.party_size,
          booking_date: form.booking_date,
          booking_time: form.booking_time
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "ขออภัย เกิดข้อผิดพลาด");
      if (data.suggestions.length === 0) {
        setError("ขออภัย ช่วงเวลานี้ไม่มีโต๊ะว่างสำหรับ " + form.party_size + " ที่นั่ง กรุณาเลือกเวลาอื่น");
        return;
      }
      setSuggestions(data.suggestions);
      setChosenTable("auto");
      setStep("choose");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เกิดข้อผิดพลาด");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmBooking() {
    setSubmitting(true);
    setError(null);
    try {
      const tableId = chosenTable === "auto" ? suggestions[0].id : chosenTable;
      const res = await fetch(apiUrl("/api/bookings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_slug: branch.slug,
          ...form,
          table_id: tableId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "เกิดข้อผิดพลาด");
      setResultId(data.id);
      setStep("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เกิดข้อผิดพลาด");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done" && resultId) {
    return (
      <div className="card text-center">
        <div className="text-5xl mb-3">✅</div>
        <h2 className="text-xl font-semibold mb-2">จองโต๊ะสำเร็จ!</h2>
        <p className="text-slate-600 mb-1">หมายเลขการจอง #{resultId}</p>
        <p className="text-slate-600 mb-6">
          {form.customer_name} · {form.party_size} ที่นั่ง<br />
          วันที่ {form.booking_date} เวลา {form.booking_time}
        </p>
        <p className="text-sm text-slate-500 mb-4">
          ทางร้านจะส่งแจ้งเตือนผ่าน LINE ก่อนถึงเวลานัด<br />
          กรุณา add LINE Official Account ของร้านเพื่อรับการแจ้งเตือน
        </p>
        <button onClick={() => router.push("/")} className="btn-secondary">กลับหน้าแรก</button>
      </div>
    );
  }

  if (step === "choose") {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold mb-3">เลือกโต๊ะที่ต้องการ</h2>
        <p className="text-sm text-slate-500 mb-4">
          ระบบเลือกโต๊ะที่ขนาดใกล้เคียงกับจำนวนคนของคุณที่สุด
        </p>

        <label className="border border-brand bg-brand/5 rounded-md p-3 mb-2 flex items-center cursor-pointer">
          <input
            type="radio" name="table" className="mr-3"
            checked={chosenTable === "auto"}
            onChange={() => setChosenTable("auto")}
          />
          <div>
            <div className="font-medium">ให้ระบบเลือกให้อัตโนมัติ (แนะนำ)</div>
            <div className="text-sm text-slate-500">
              โต๊ะ {suggestions[0].label} · {suggestions[0].capacity} ที่นั่ง
            </div>
          </div>
        </label>

        {suggestions.map((s) => (
          <label key={s.id} className="border border-slate-200 rounded-md p-3 mb-2 flex items-center cursor-pointer hover:border-brand">
            <input
              type="radio" name="table" className="mr-3"
              checked={chosenTable === s.id}
              onChange={() => setChosenTable(s.id)}
            />
            <div>
              <div className="font-medium">โต๊ะ {s.label}</div>
              <div className="text-sm text-slate-500">
                {s.capacity} ที่นั่ง {s.shape === "round" ? "(โต๊ะกลม)" : ""}
              </div>
            </div>
          </label>
        ))}

        {error && <div className="text-red-600 text-sm mt-2">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button onClick={() => setStep("form")} className="btn-secondary flex-1">ย้อนกลับ</button>
          <button
            onClick={confirmBooking}
            disabled={submitting || chosenTable === null}
            className="btn-primary flex-1"
          >
            {submitting ? "กำลังบันทึก..." : "ยืนยันการจอง"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={findTables} className="card space-y-4">
      <div>
        <label className="label">ชื่อ-นามสกุล *</label>
        <input
          className="input" required
          value={form.customer_name}
          onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
        />
      </div>

      <div>
        <label className="label">เบอร์โทรศัพท์ *</label>
        <input
          className="input" required type="tel" pattern="[0-9\-\s]+"
          placeholder="08X-XXX-XXXX"
          value={form.customer_phone}
          onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">วันที่ *</label>
          <input
            type="date" className="input" required min={today}
            value={form.booking_date}
            onChange={(e) => setForm({ ...form, booking_date: e.target.value })}
          />
        </div>
        <div>
          <label className="label">เวลา *</label>
          <select
            className="input" required
            value={form.booking_time}
            onChange={(e) => setForm({ ...form, booking_time: e.target.value })}
          >
            {slots.map((s) => <option key={s} value={s}>{s} น.</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">จำนวนที่นั่ง *</label>
        <input
          type="number" className="input" required min={1} max={20}
          value={form.party_size}
          onChange={(e) => setForm({ ...form, party_size: Number(e.target.value) })}
        />
      </div>

      <div>
        <label className="label">รู้จักร้านจากที่ไหน?</label>
        <select
          className="input"
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
        >
          <option value="">— เลือก —</option>
          {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div>
        <label className="label">หมายเหตุ (ถ้ามี)</label>
        <textarea
          className="input" rows={2}
          placeholder="เช่น ขอโต๊ะริมหน้าต่าง, มีเด็ก ฯลฯ"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}

      <button disabled={submitting} className="btn-primary w-full">
        {submitting ? "กำลังค้นหาโต๊ะว่าง..." : "ค้นหาโต๊ะว่าง"}
      </button>
    </form>
  );
}
