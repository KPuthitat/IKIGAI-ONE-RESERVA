"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

type TableOption = {
  id: number;
  label: string;
  capacity: number;
  shape: string;
  fitScore: number;
};

// Source values (เก็บใน DB ใช้ key คงที่) + i18n key สำหรับ display
const SOURCE_DEFS: Array<{ value: string; key: string }> = [
  { value: "Instagram", key: "booking.source.Instagram" },
  { value: "Facebook", key: "booking.source.Facebook" },
  { value: "TikTok", key: "booking.source.TikTok" },
  { value: "Google Maps", key: "booking.source.GoogleMaps" },
  { value: "เพื่อนแนะนำ", key: "booking.source.friend" },
  { value: "ผ่านมาเห็น", key: "booking.source.passing" },
  { value: "อื่นๆ", key: "booking.source.other" }
];

const ORIGIN_DEFS: Array<{ value: string; key: string }> = [
  { value: "sriracha", key: "booking.origin.sriracha" },
  { value: "chonburi", key: "booking.origin.chonburi" },
  { value: "other_province", key: "booking.origin.other_province" }
];

export default function BookingForm({ branch }: { branch: Branch }) {
  const router = useRouter();
  const { t, formatDate } = useLang();

  const SOURCES = SOURCE_DEFS.map((s) => ({ value: s.value, label: t(s.key) }));
  const ORIGINS = ORIGIN_DEFS.map((o) => ({ value: o.value, label: t(o.key) }));

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
    sources: [] as string[],
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

  // ครัวปิด 30 นาทีก่อนร้านปิด — เป็น last slot ที่จองได้
  const KITCHEN_CLOSE_OFFSET = 30;

  const slots = useMemo(() => {
    const out: string[] = [];
    const [oh, om] = branch.open_time.split(":").map(Number);
    const [ch, cm] = branch.close_time.split(":").map(Number);
    const start = oh * 60 + om;
    const end = ch * 60 + cm;
    const lastBookable = end - KITCHEN_CLOSE_OFFSET;  // = เวลาครัวปิด
    for (let m = start; m <= lastBookable; m += branch.slot_minutes) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
    return out;
  }, [branch]);


  async function findTables(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.customer_name.trim() || !form.customer_phone.trim()) {
      setError(t("booking.error.missingNamePhone"));
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
      if (!res.ok) throw new Error(data.error || t("common.error"));
      if (data.suggestions.length === 0) {
        setError(t("booking.error.noTable", { n: form.party_size }));
        return;
      }
      setSuggestions(data.suggestions);
      setChosenTable("auto");
      setStep("choose");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("common.error"));
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
          source: form.sources.length > 0 ? JSON.stringify(form.sources) : "",
          table_id: tableId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("common.error"));
      setResultId(data.id);
      setStep("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done" && resultId) {
    return (
      <div className="card text-center">
        <div className="text-5xl mb-3">✅</div>
        <h2 className="text-xl font-bold mb-2 text-slate-800">{t("booking.success.title")}</h2>
        <p className="text-slate-600 mb-1">
          <span dangerouslySetInnerHTML={{
            __html: t("booking.success.bookingId", { id: `<span class="font-bold">${resultId}</span>` })
          }} />
        </p>
        <p className="text-slate-600 mb-6">
          {t("booking.success.summary", { name: form.customer_name, n: form.party_size })}<br />
          {t("booking.success.dateTime", { date: formatDate(form.booking_date), time: form.booking_time })}
        </p>
        <p className="text-sm text-slate-500 mb-4">
          {t("booking.success.lineNotice")}
        </p>

        {form.is_member === 0 && (
          <div className="bg-brand/5 border border-brand/30 rounded-xl p-4 mb-4 text-left">
            <div className="font-bold text-brand mb-1">{t("booking.success.memberCta.title")}</div>
            <div className="text-sm text-slate-600">{t("booking.success.memberCta.body")}</div>
          </div>
        )}

        <button onClick={() => router.push("/reserva")} className="btn-secondary w-full">
          {t("booking.success.backToBranch")}
        </button>
      </div>
    );
  }

  if (step === "choose") {
    return (
      <div className="card">
        <h2 className="text-lg font-bold mb-3 text-slate-800">{t("booking.choose.title")}</h2>
        <p className="text-sm text-slate-500 mb-4">{t("booking.choose.subtitle")}</p>

        <label className="border-[1.5px] border-brand bg-brand/5 rounded-xl p-3.5 mb-2 flex items-center cursor-pointer">
          <input
            type="radio" name="table" className="mr-3 w-5 h-5"
            checked={chosenTable === "auto"}
            onChange={() => setChosenTable("auto")}
          />
          <div>
            <div className="font-bold">{t("booking.choose.auto")}</div>
            <div className="text-sm text-slate-500">
              {t("booking.choose.tableX", { label: suggestions[0].label })} · {t("booking.choose.seats", { n: suggestions[0].capacity })}
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
              <div className="font-bold">{t("booking.choose.tableX", { label: s.label })}</div>
              <div className="text-sm text-slate-500">
                {t("booking.choose.seats", { n: s.capacity })} {s.shape === "round" ? t("booking.choose.round") : ""}
              </div>
            </div>
          </label>
        ))}

        {error && <div className="text-red-600 text-sm mt-2">{error}</div>}

        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={() => setStep("form")} className="btn-secondary">{t("common.back")}</button>
          <button
            onClick={confirmBooking}
            disabled={submitting || chosenTable === null}
            className="btn-primary"
          >
            {submitting ? t("booking.cta.confirming") : t("booking.cta.confirm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={findTables} className="space-y-4">
      <div className="card space-y-4">
        <div>
          <label className="label">{t("booking.field.name")} *</label>
          <input
            className="input" required
            autoComplete="name"
            value={form.customer_name}
            onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
          />
        </div>

        <div>
          <label className="label">{t("booking.field.phone")} *</label>
          <input
            className="input" required type="tel"
            inputMode="tel" autoComplete="tel"
            placeholder={t("booking.field.phonePlaceholder")}
            value={form.customer_phone}
            onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("booking.field.date")} *</label>
            <input
              type="date" className="input" required min={today}
              value={form.booking_date}
              onChange={(e) => setForm({ ...form, booking_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("booking.field.time")} *</label>
            <select
              className="input" required
              value={form.booking_time}
              onChange={(e) => setForm({ ...form, booking_time: e.target.value })}
            >
              {slots.map((s) => (
                <option key={s} value={s}>{t("booking.field.timeUnit", { time: s })}</option>
              ))}
            </select>
            {/* แจ้งเตือนเมื่อเลือก slot สุดท้าย = ใกล้เวลาครัวปิด */}
            {slots.length > 0 && form.booking_time === slots[slots.length - 1] && (
              <div className="mt-1.5 text-xs px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
                ⚠ {t("booking.kitchenCloseWarn")}
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="label">{t("booking.field.partySize")} *</label>
          <PartySizePicker
            value={form.party_size}
            onChange={(n) => setForm({ ...form, party_size: n })}
          />
        </div>

        <div>
          <label className="label">{t("booking.field.notes")}</label>
          <textarea
            className="input" rows={2}
            placeholder={t("booking.field.notesPlaceholder")}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
      </div>

      {/* คำถามเพิ่มเติม */}
      <div className="bg-white/60 rounded-2xl p-5 space-y-4 border border-slate-200">
        <div className="text-center">
          <div className="text-sm font-bold text-slate-700">{t("booking.helpUs.title")}</div>
          <div className="text-xs text-slate-500">{t("booking.helpUs.subtitle")}</div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.origin")}</div>
          <ChipGroup
            options={ORIGINS}
            value={form.customer_origin}
            onChange={(v) => setForm({ ...form, customer_origin: v ?? "" })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.source")}</div>
          <MultiChipGroup
            options={SOURCES}
            values={form.sources}
            onChange={(vs) => setForm({ ...form, sources: vs })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.member")}</div>
          <ChipGroup
            options={[
              { value: "1", label: t("booking.member.yes") },
              { value: "0", label: t("booking.member.no") }
            ]}
            value={form.is_member === null ? "" : String(form.is_member)}
            onChange={(v) =>
              setForm({ ...form, is_member: v === null ? null : (Number(v) as 0 | 1) })
            }
          />
          {form.is_member === 0 && (
            <div className="mt-2 text-xs text-slate-500 bg-brand/5 border border-brand/20 rounded-lg p-2.5">
              {t("booking.member.hint")}
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-red-600 text-sm text-center">{error}</div>}

      <button disabled={submitting} className="btn-primary w-full text-base py-3.5">
        {submitting ? t("booking.cta.searching") : t("booking.cta.findTable")}
      </button>
    </form>
  );
}

function ChipGroup({
  options, value, onChange
}: {
  options: Array<{ value: string; label: string }>;
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
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function MultiChipGroup({
  options, values, onChange
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (vs: string[]) => void;
}) {
  function toggle(v: string) {
    if (values.includes(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = values.includes(o.value);
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => toggle(o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >
            {selected && <span className="mr-1">✓</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PartySizePicker({
  value, onChange
}: { value: number; onChange: (n: number) => void }) {
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
        min={1} max={50}
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
