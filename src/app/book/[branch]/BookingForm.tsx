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

const SOURCES = [
  { value: "Instagram", label: "Instagram", emoji: "📷" },
  { value: "Facebook", label: "Facebook", emoji: "👍" },
  { value: "TikTok", label: "TikTok", emoji: "🎵" },
  { value: "Google Maps", label: "Google", emoji: "🔍" },
  { value: "เพื่อนแนะนำ", label: "เพื่อนแนะนำ", emoji: "👥" },
  { value: "ผ่านมาเห็น", label: "ผ่านมาเห็น", emoji: "👀" },
  { value: "อื่นๆ", label: "อื่นๆ", emoji: "✨" }
];

const ORIGINS = [
  { value: "sriracha", label: "ศรีราชา" },
  { value: "chonburi", label: "ชลบุรี (อื่นๆ)" },
  { value: "other_province", label: "ต่างจังหวัด" }
];

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
    customer_origin: "",
    is_member: null as 0 | 1 | null,
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
        <h2 className="text-xl font-bold mb-2 text-slate-800">จองโต๊ะสำเร็จ!</h2>
        <p className="text-slate-600 mb-1">หมายเลขการจอง <span className="font-bold">#{resultId}</span></p>
        <p className="text-slate-600 mb-6">
          {form.customer_name} · {form.party_size} ที่นั่ง<br />
          วันที่ {form.booking_date} เวลา {form.booking_time}
        </p>
        <p className="text-sm text-slate-500 mb-4">
          ทางร้านจะส่งแจ้งเตือนผ่าน LINE ก่อนถึงเวลานัด<br />
          กรุณา add LINE Official Account ของร้านเพื่อรับการแจ้งเตือน
        </p>

        {form.is_member === 0 && (
          <div className="bg-brand/5 border border-brand/30 rounded-xl p-4 mb-4 text-left">
            <div className="font-bold text-brand mb-1">🎟️ สมัครสมาชิกฟรี</div>
            <div className="text-sm text-slate-600">
              สะสมแต้ม รับสิทธิพิเศษ และส่วนลดทุกครั้งที่มา ทักทีมงานในร้านได้เลย
            </div>
          </div>
        )}

        <button onClick={() => router.push("/")} className="btn-secondary w-full">กลับหน้าแรก</button>
      </div>
    );
  }

  if (step === "choose") {
    return (
      <div className="card">
        <h2 className="text-lg font-bold mb-3 text-slate-800">เลือกโต๊ะที่ต้องการ</h2>
        <p className="text-sm text-slate-500 mb-4">
          ระบบเลือกโต๊ะที่ขนาดใกล้เคียงกับจำนวนคนของคุณที่สุด
        </p>

        <label className="border-[1.5px] border-brand bg-brand/5 rounded-xl p-3.5 mb-2 flex items-center cursor-pointer">
          <input
            type="radio" name="table" className="mr-3 w-5 h-5"
            checked={chosenTable === "auto"}
            onChange={() => setChosenTable("auto")}
          />
          <div>
            <div className="font-bold">ให้ระบบเลือกให้อัตโนมัติ (แนะนำ)</div>
            <div className="text-sm text-slate-500">
              โต๊ะ {suggestions[0].label} · {suggestions[0].capacity} ที่นั่ง
            </div>
          </div>
        </label>

        {suggestions.map((s) => (
          <label key={s.id} className="border-[1.5px] border-slate-200 rounded-xl p-3.5 mb-2 flex items-center cursor-pointer hover:border-brand">
            <input
              type="radio" name="table" className="mr-3 w-5 h-5"
              checked={chosenTable === s.id}
              onChange={() => setChosenTable(s.id)}
            />
            <div>
              <div className="font-bold">โต๊ะ {s.label}</div>
              <div className="text-sm text-slate-500">
                {s.capacity} ที่นั่ง {s.shape === "round" ? "(โต๊ะกลม)" : ""}
              </div>
            </div>
          </label>
        ))}

        {error && <div className="text-red-600 text-sm mt-2">{error}</div>}

        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={() => setStep("form")} className="btn-secondary">ย้อนกลับ</button>
          <button
            onClick={confirmBooking}
            disabled={submitting || chosenTable === null}
            className="btn-primary"
          >
            {submitting ? "กำลังบันทึก..." : "ยืนยันการจอง"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={findTables} className="space-y-4">
      <div className="card space-y-4">
        <div>
          <label className="label">ชื่อ-นามสกุล *</label>
          <input
            className="input" required
            autoComplete="name"
            value={form.customer_name}
            onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
          />
        </div>

        <div>
          <label className="label">เบอร์โทรศัพท์ *</label>
          <input
            className="input" required type="tel"
            inputMode="tel" autoComplete="tel"
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
          <PartySizePicker
            value={form.party_size}
            onChange={(n) => setForm({ ...form, party_size: n })}
          />
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
      </div>

      {/* ── คำถามเพิ่มเติม (ไม่บังคับ) ── */}
      <div className="bg-white/60 rounded-2xl p-5 space-y-4 border border-slate-200">
        <div className="text-center">
          <div className="text-sm font-bold text-slate-700">ช่วยตอบเพิ่มเติม</div>
          <div className="text-xs text-slate-500">3 คำถามสั้นๆ เพื่อพัฒนาบริการ (ไม่บังคับ)</div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">🌍 เดินทางมาจาก</div>
          <ChipGroup
            options={ORIGINS}
            value={form.customer_origin}
            onChange={(v) => setForm({ ...form, customer_origin: v ?? "" })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">💬 รู้จักร้านจาก</div>
          <ChipGroup
            options={SOURCES}
            value={form.source}
            onChange={(v) => setForm({ ...form, source: v ?? "" })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">🎟️ เคยเป็นสมาชิกร้านมั้ย</div>
          <ChipGroup
            options={[
              { value: "1", label: "เคยแล้ว" },
              { value: "0", label: "ยังไม่เคย" }
            ]}
            value={form.is_member === null ? "" : String(form.is_member)}
            onChange={(v) =>
              setForm({ ...form, is_member: v === null ? null : (Number(v) as 0 | 1) })
            }
          />
          {form.is_member === 0 && (
            <div className="mt-2 text-xs text-slate-500 bg-brand/5 border border-brand/20 rounded-lg p-2.5">
              💡 ทีมงานจะแนะนำสมัครสมาชิกฟรีให้ตอนถึงร้าน
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-red-600 text-sm text-center">{error}</div>}

      <button disabled={submitting} className="btn-primary w-full text-base py-3.5">
        {submitting ? "กำลังค้นหาโต๊ะว่าง..." : "ค้นหาโต๊ะว่าง"}
      </button>
    </form>
  );
}

// ── ChipGroup component ──
function ChipGroup({
  options,
  value,
  onChange
}: {
  options: Array<{ value: string; label: string; emoji?: string }>;
  value: string;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => onChange(selected ? null : o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >
            {o.emoji && <span className="mr-1">{o.emoji}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Stepper for party size (more thumb-friendly than typing) ──
function PartySizePicker({
  value,
  onChange
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="w-12 h-12 rounded-xl border-[1.5px] border-slate-200 bg-white text-2xl font-bold text-slate-600 hover:border-brand active:scale-95 disabled:opacity-50"
        disabled={value <= 1}
      >−</button>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={50}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
        className="input text-center text-xl font-bold flex-1 min-w-0"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(50, value + 1))}
        className="w-12 h-12 rounded-xl border-[1.5px] border-slate-200 bg-white text-2xl font-bold text-slate-600 hover:border-brand active:scale-95"
      >+</button>
    </div>
  );
}
