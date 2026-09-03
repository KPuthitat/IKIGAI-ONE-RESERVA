"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { ManagerReportRow } from "@/lib/manager-reports";

const ERR_TH: Record<string, string> = {
  empty_report: "กรอกอย่างน้อย 1 ช่องก่อนบันทึก",
  no_active_branch: "ยังไม่ได้เลือกสาขา",
  invalid_body: "ข้อมูลไม่ถูกต้อง",
  not_author: "แก้ได้เฉพาะรายงานที่ตัวเองเพิ่ม",
  no_pin: "ยังไม่ได้ตั้ง PIN",
  wrong_pin: "PIN ไม่ถูกต้อง",
  forbidden: "ไม่มีสิทธิ์"
};

export default function ManagerReportsClient({
  reports, currentUserId, today, canCompanyWide = false
}: {
  reports: ManagerReportRow[];
  currentUserId: number;
  today: string;
  canCompanyWide?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [date, setDate] = useState(today);
  const [shift, setShift] = useState("");
  const [situation, setSituation] = useState("");
  const [topics, setTopics] = useState("");
  const [companyWide, setCompanyWide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const ready = /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (shift.trim() !== "" || situation.trim() !== "" || topics.trim() !== "");

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/manager-reports"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_date: date,
          shift_summary: shift.trim(),
          situation: situation.trim(),
          meeting_topics: topics.trim(),
          company_wide: companyWide
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(ERR_TH[j.error] ?? j.error ?? "บันทึกไม่สำเร็จ"); return; }
      setSaved(true);
      // เคลียร์กล่องข้อความ เพื่อเพิ่มเรื่องใหม่ได้เลย (owner 2026-09-03).
      setShift(""); setSituation(""); setTopics("");
      startTransition(() => router.refresh());
    } catch {
      setErr("เกิดข้อผิดพลาด");
    } finally {
      setBusy(false);
    }
  }

  async function del(id: number) {
    if (!confirm("ลบรายงานนี้?")) return;
    const res = await fetch(apiUrl(`/api/admin/persona/manager-reports/${id}`), { method: "DELETE" });
    if (res.ok) startTransition(() => router.refresh());
    else alert("ลบไม่สำเร็จ");
  }

  return (
    <div className="space-y-5">
      {/* ── ฟอร์มส่งรายงาน ── */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-800">ส่งรายงาน</span>
          <span className="text-[11px] text-slate-400">เพิ่มได้หลายเรื่องต่อวัน · บันทึกแล้วกล่องจะว่างให้เพิ่มเรื่องใหม่</span>
          <span className="flex-1" />
          <label className="text-xs text-slate-500 flex items-center gap-1">
            วันที่
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs" />
          </label>
        </div>

        <Field label="สรุปปิดกะ / ยอดขาย" value={shift} onChange={setShift}
          placeholder="เช่น ยอดขายวันนี้ ฿xx,xxx · ลูกค้าเยอะช่วงเย็น · เงินสดในลิ้นชักครบ" />
        <Field label="สถานการณ์ / ปัญหา / เหตุการณ์ประจำวัน" value={situation} onChange={setSituation}
          placeholder="เช่น แอร์โซนสองเสีย · พนักงานลา 1 คน · ของหมดสต๊อก 2 รายการ" />
        <Field label="เรื่องที่อยากเสนอเข้าประชุมประจำสัปดาห์" value={topics} onChange={setTopics}
          placeholder="เช่น ขอเพิ่มคนช่วงเสาร์-อาทิตย์ · เสนอปรับเมนู · ปัญหาคิวครัวช้า" />

        <div className="flex items-center gap-3 flex-wrap">
          {canCompanyWide && (
            <label className="text-xs text-slate-600 flex items-center gap-1.5">
              <input type="checkbox" checked={companyWide} onChange={(e) => setCompanyWide(e.target.checked)} />
              รายงานระดับบริษัท (ทุกสาขาเห็น)
            </label>
          )}
          <span className="flex-1" />
          {err && <span className="text-xs text-rose-600">{err}</span>}
          {saved && !err && <span className="text-xs text-emerald-600">✓ บันทึกแล้ว</span>}
          <button type="button" disabled={!ready || busy} onClick={save}
            className="text-sm px-4 py-1.5 rounded-full bg-brand text-white font-bold hover:opacity-90 disabled:opacity-40">
            {busy ? "กำลังบันทึก…" : "บันทึกรายงาน"}
          </button>
        </div>
      </div>

      {/* ── รายการย้อนหลัง (14 วัน) ── */}
      <div>
        <h2 className="text-sm font-bold text-slate-700 mb-2">รายงานล่าสุด (14 วัน)</h2>
        <div className="space-y-2">
          {reports.length === 0 ? (
            <div className="card text-sm text-slate-400 text-center py-8">ยังไม่มีรายงาน</div>
          ) : reports.map((r) => (
            <div key={r.id} className="card space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-400 font-mono">{r.report_date}</span>
                <span className="text-xs font-bold text-slate-700">
                  {nameWithPrefix(r.author_prefix, r.author_name ?? "") || "—"}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {r.branch_name ?? "ทั้งบริษัท"}
                </span>
                {r.updated_at && <span className="text-[10px] text-slate-400">(แก้ไขแล้ว)</span>}
                <span className="flex-1" />
                {r.author_user_id === currentUserId && editingId !== r.id && (
                  <>
                    <button type="button" onClick={() => setEditingId(r.id)}
                      className="text-[11px] text-brand hover:underline mr-2">แก้ไข</button>
                    <button type="button" onClick={() => del(r.id)}
                      className="text-[11px] text-rose-500 hover:text-rose-700">ลบ</button>
                  </>
                )}
              </div>
              {editingId === r.id ? (
                <EditReport row={r} endpoint={`/api/admin/persona/manager-reports/${r.id}`}
                  onDone={() => { setEditingId(null); startTransition(() => router.refresh()); }}
                  onCancel={() => setEditingId(null)} />
              ) : (
                <>
                  {r.shift_summary && <ReportLine label="ปิดกะ" text={r.shift_summary} />}
                  {r.situation && <ReportLine label="สถานการณ์" text={r.situation} />}
                  {r.meeting_topics && <ReportLine label="เข้าประชุม" text={r.meeting_topics} accent />}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// แก้ไขรายงานของตัวเอง — ยืนยันด้วย PIN (owner 2026-09-03).
export function EditReport({ row, endpoint, onDone, onCancel }: {
  row: ManagerReportRow; endpoint: string; onDone: () => void; onCancel: () => void;
}) {
  const [shift, setShift] = useState(row.shift_summary);
  const [situation, setSituation] = useState(row.situation);
  const [topics, setTopics] = useState(row.meeting_topics);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = /^\d{4}$/.test(pin) &&
    (shift.trim() !== "" || situation.trim() !== "" || topics.trim() !== "");

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(endpoint), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, shift_summary: shift.trim(), situation: situation.trim(), meeting_topics: topics.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(ERR_TH[j.error] ?? j.message ?? j.error ?? "แก้ไขไม่สำเร็จ"); return; }
      onDone();
    } catch { setErr("เกิดข้อผิดพลาด"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 rounded-lg bg-[#faf6ef] border border-[#EFE4D3] p-3">
      <Field label="สรุปปิดกะ / ยอดขาย" value={shift} onChange={setShift} />
      <Field label="สถานการณ์ / ปัญหา / เหตุการณ์ประจำวัน" value={situation} onChange={setSituation} />
      <Field label="เรื่องที่อยากเสนอเข้าประชุมประจำสัปดาห์" value={topics} onChange={setTopics} />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-slate-600 flex items-center gap-1.5">
          PIN
          <input type="password" inputMode="numeric" maxLength={4} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="••••" className="border border-slate-300 rounded px-2 py-1 text-sm w-20 tracking-widest" />
        </label>
        <span className="flex-1" />
        {err && <span className="text-xs text-rose-600">{err}</span>}
        <button type="button" onClick={onCancel} className="text-xs px-3 py-1.5 rounded-full border border-slate-300 text-slate-600">ยกเลิก</button>
        <button type="button" disabled={!ready || busy} onClick={save}
          className="text-xs px-4 py-1.5 rounded-full bg-brand text-white font-bold hover:opacity-90 disabled:opacity-40">
          {busy ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2}
        placeholder={placeholder}
        className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm resize-y
                   focus:border-brand focus:ring-1 focus:ring-brand outline-none" />
    </label>
  );
}

function ReportLine({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className={`flex-shrink-0 font-bold ${accent ? "text-amber-700" : "text-slate-400"}`}>
        {label}:
      </span>
      <span className="text-slate-700 whitespace-pre-wrap">{text}</span>
    </div>
  );
}
