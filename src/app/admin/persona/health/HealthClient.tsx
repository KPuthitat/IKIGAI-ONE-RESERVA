"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import {
  SN11_ITEMS,
  defaultCheckupItems,
  checkupStatus,
  statusLabel,
  type HealthCheckupItemRow,
  type HealthItemResult,
  type HealthOverall,
  type CheckupStatus
} from "@/lib/health-checkup";
import { nameWithPrefix } from "@/lib/name";

export type HealthRow = {
  id: number;
  username: string;
  display_name: string;
  title_prefix: string | null;
  role: "admin" | "staff" | "super_admin";
  employment_type: "pt" | "ft" | null;
  checkup_id: number | null;
  exam_type: string | null;
  checkup_date: string | null;
  expiry_date: string | null;
  overall_result: HealthOverall | null;
  clinic_name: string | null;
  doctor_name: string | null;
  cert_no: string | null;
  items_json: string | null;
  attachment_url: string | null;
  file_path: string | null;
  notes: string | null;
};

const STATUS_STYLE: Record<CheckupStatus, string> = {
  none: "bg-slate-100 text-slate-500",
  valid: "bg-emerald-100 text-emerald-700",
  expiring: "bg-amber-100 text-amber-700",
  expired: "bg-rose-100 text-rose-700"
};

// Occupational-health exam types (owner 2026-06-04). Pre-employment lives
// in RECRUITA; these three cover post-hire employees.
type ExamType = "pre_placement" | "periodic" | "return_to_work";
const EXAM_TYPES: ReadonlyArray<{ value: ExamType; label: string }> = [
  { value: "periodic", label: "ตรวจประจำปี" },
  { value: "pre_placement", label: "ก่อนเริ่มงาน (ปัจจัยเสี่ยง)" },
  { value: "return_to_work", label: "กลับเข้าทำงาน (หลังพัก)" }
];
const EXAM_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(EXAM_TYPES.map((e) => [e.value, e.label]));

function rowStatus(r: HealthRow): CheckupStatus {
  if (!r.checkup_id) return "none";
  return checkupStatus(r.expiry_date);
}

export default function HealthClient({ rows }: { rows: HealthRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [target, setTarget] = useState<HealthRow | null>(null);

  return (
    <>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3">พนักงาน</th>
              <th className="py-2 pr-3">ประเภทล่าสุด</th>
              <th className="py-2 pr-3">วันที่ตรวจล่าสุด</th>
              <th className="py-2 pr-3">หมดอายุ</th>
              <th className="py-2 pr-3">สถานะ</th>
              <th className="py-2 pr-3">ผล</th>
              <th className="py-2 pr-3 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = rowStatus(r);
              return (
                <tr key={r.id}
                  className={`border-b last:border-0 ${
                    st === "expired" ? "bg-rose-50/50"
                    : st === "expiring" ? "bg-amber-50/40"
                    : st === "none" ? "bg-slate-50/40"
                    : "hover:bg-slate-50"}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{nameWithPrefix(r.title_prefix, r.display_name)}</div>
                    <div className="text-xs text-slate-400">@{r.username}</div>
                  </td>
                  <td className="py-2 pr-3">
                    {r.checkup_id ? (
                      <span className="text-xs px-2 py-0.5 rounded font-medium bg-teal-100 text-teal-700">
                        {EXAM_TYPE_LABEL[r.exam_type ?? "periodic"] ?? "ประจำปี"}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">
                    {r.checkup_date ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">
                    {r.expiry_date ?? (r.checkup_id ? "ไม่ระบุ" : "—")}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_STYLE[st]}`}>
                      {statusLabel(st)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-700 text-xs">
                    {r.overall_result === "pass" ? "✓ ผ่าน"
                      : r.overall_result === "fail" ? "✗ ไม่ผ่าน"
                      : r.overall_result === "conditional" ? "△ มีเงื่อนไข"
                      : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button type="button"
                      onClick={() => setTarget(r)}
                      className="text-xs text-brand hover:underline">
                      {r.checkup_id ? "แก้ไข / บันทึกใหม่" : "บันทึกผลตรวจ"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-slate-400 text-sm">
                ไม่มีพนักงานในสาขานี้
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {target && (
        <CheckupModal
          row={target}
          onClose={() => setTarget(null)}
          onSaved={() => {
            setTarget(null);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </>
  );
}

function addOneYear(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function CheckupModal({
  row, onClose, onSaved
}: {
  row: HealthRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Edit the existing latest cert (PATCH) vs record a brand-new one
  // (POST). Default to "record new" — a fresh annual cert is the common
  // action; admin can switch to edit-current to fix a typo.
  const hasExisting = !!row.checkup_id;
  const [editMode, setEditMode] = useState<"new" | "edit">(
    hasExisting ? "edit" : "new"
  );
  const [examType, setExamType] = useState<ExamType>(
    (hasExisting && (row.exam_type as ExamType)) || "periodic"
  );

  const today = new Date().toISOString().slice(0, 10);

  const seedItems = useMemo<HealthCheckupItemRow[]>(() => {
    if (editMode === "edit" && row.items_json) {
      try {
        const parsed = JSON.parse(row.items_json) as HealthCheckupItemRow[];
        // Merge with the reference list so newly-added reference items
        // still appear even on an older saved record.
        const byKey = new Map(parsed.map((p) => [p.key, p]));
        return SN11_ITEMS.map((it) => byKey.get(it.key) ?? {
          key: it.key, label: it.label, result: "na" as HealthItemResult
        });
      } catch {
        return defaultCheckupItems();
      }
    }
    return defaultCheckupItems();
  }, [editMode, row.items_json]);

  const [checkupDate, setCheckupDate] = useState(
    editMode === "edit" ? (row.checkup_date ?? today) : today
  );
  const [expiryDate, setExpiryDate] = useState(
    editMode === "edit" ? (row.expiry_date ?? "") : addOneYear(today)
  );
  const [clinic, setClinic] = useState(editMode === "edit" ? (row.clinic_name ?? "") : "");
  const [doctor, setDoctor] = useState(editMode === "edit" ? (row.doctor_name ?? "") : "");
  const [certNo, setCertNo] = useState(editMode === "edit" ? (row.cert_no ?? "") : "");
  const [overall, setOverall] = useState<HealthOverall>(
    editMode === "edit" ? (row.overall_result ?? "pass") : "pass"
  );
  const [items, setItems] = useState<HealthCheckupItemRow[]>(seedItems);
  const [attachmentUrl, setAttachmentUrl] =
    useState(editMode === "edit" ? (row.attachment_url ?? "") : "");
  const [notes, setNotes] = useState(editMode === "edit" ? (row.notes ?? "") : "");
  // Actual exam-result file (PDF/image) to upload after the row is saved.
  const [file, setFile] = useState<File | null>(null);
  const hasFile = editMode === "edit" && !!row.file_path;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function switchMode(m: "new" | "edit") {
    setEditMode(m);
    setExamType(m === "edit" ? ((row.exam_type as ExamType) || "periodic") : "periodic");
    if (m === "new") {
      setCheckupDate(today);
      setExpiryDate(addOneYear(today));
      setClinic(""); setDoctor(""); setCertNo("");
      setOverall("pass");
      setItems(defaultCheckupItems());
      setAttachmentUrl(""); setNotes("");
    } else {
      setCheckupDate(row.checkup_date ?? today);
      setExpiryDate(row.expiry_date ?? "");
      setClinic(row.clinic_name ?? "");
      setDoctor(row.doctor_name ?? "");
      setCertNo(row.cert_no ?? "");
      setOverall(row.overall_result ?? "pass");
      try {
        const parsed = row.items_json
          ? (JSON.parse(row.items_json) as HealthCheckupItemRow[]) : [];
        const byKey = new Map(parsed.map((p) => [p.key, p]));
        setItems(SN11_ITEMS.map((it) => byKey.get(it.key) ?? {
          key: it.key, label: it.label, result: "na" as HealthItemResult
        }));
      } catch { setItems(defaultCheckupItems()); }
      setAttachmentUrl(row.attachment_url ?? "");
      setNotes(row.notes ?? "");
    }
  }

  function setItemResult(key: string, result: HealthItemResult) {
    setItems((prev) => prev.map((it) =>
      it.key === key ? { ...it, result } : it));
  }

  async function save() {
    setErr(null);
    if (!checkupDate) { setErr("กรอกวันที่ตรวจ"); return; }
    setBusy(true);
    try {
      const body = {
        exam_type: examType,
        checkup_date: checkupDate,
        expiry_date: expiryDate || null,
        clinic_name: clinic.trim() || null,
        doctor_name: doctor.trim() || null,
        cert_no: certNo.trim() || null,
        overall_result: overall,
        items,
        attachment_url: attachmentUrl.trim() || null,
        notes: notes.trim() || null
      };
      let res: Response;
      if (editMode === "edit" && row.checkup_id) {
        res = await fetch(apiUrl(`/api/admin/persona/health/${row.checkup_id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      } else {
        res = await fetch(apiUrl("/api/admin/persona/health"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: row.id, ...body })
        });
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setErr(j?.error ?? "เกิดข้อผิดพลาด");
        return;
      }
      // Upload the actual exam file (if chosen) against the saved row.
      const checkupId: number | null =
        editMode === "edit" && row.checkup_id ? row.checkup_id
          : typeof j.id === "number" ? j.id : null;
      if (file && checkupId) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await fetch(apiUrl(`/api/admin/persona/health/${checkupId}/file`), {
          method: "POST", body: fd
        });
        const uj = await up.json().catch(() => ({}));
        if (!up.ok || !uj?.ok) {
          setErr(uj?.message ?? "บันทึกผลแล้ว แต่แนบไฟล์ไม่สำเร็จ — ลองแนบใหม่อีกครั้ง");
          return;
        }
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const prohibited = items.filter((i) =>
    SN11_ITEMS.find((s) => s.key === i.key)?.group === "prohibited");
  const lab = items.filter((i) =>
    SN11_ITEMS.find((s) => s.key === i.key)?.group === "lab");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800">
            บันทึกผลตรวจสุขภาพ
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {nameWithPrefix(row.title_prefix, row.display_name)} <span className="text-slate-400">@{row.username}</span>
          </p>
        </div>

        <div>
          <label className="label">ประเภทการตรวจ *</label>
          <select className="input" value={examType}
            onChange={(e) => setExamType(e.target.value as ExamType)}>
            {EXAM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-slate-400 mt-1">
            {examType === "periodic"
              ? "ตรวจประจำปี — รวมใบรับรองผู้สัมผัสอาหาร (ส.ณ.11) มีรายการโรคให้บันทึกด้านล่าง"
              : examType === "pre_placement"
                ? "ก่อนเริ่มงาน — ตรวจตามปัจจัยเสี่ยงของตำแหน่ง"
                : "ประเมินความพร้อมกลับเข้าทำงานหลังหยุดพัก/เจ็บป่วย"}
          </p>
        </div>

        {hasExisting && (
          <div className="flex gap-2 text-xs">
            <button type="button"
              onClick={() => switchMode("edit")}
              className={`px-3 py-1.5 rounded-lg border ${
                editMode === "edit"
                  ? "border-brand text-brand bg-rose-50 font-bold"
                  : "border-slate-300 text-slate-600"}`}>
              แก้ไขใบล่าสุด
            </button>
            <button type="button"
              onClick={() => switchMode("new")}
              className={`px-3 py-1.5 rounded-lg border ${
                editMode === "new"
                  ? "border-brand text-brand bg-rose-50 font-bold"
                  : "border-slate-300 text-slate-600"}`}>
              + บันทึกใบใหม่ (ต่ออายุ)
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">วันที่ตรวจ *</label>
            <input type="date" className="input" value={checkupDate}
              onChange={(e) => setCheckupDate(e.target.value)} />
          </div>
          <div>
            <label className="label">วันหมดอายุใบรับรอง</label>
            <input type="date" className="input" value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              ปกติใบรับรองผู้สัมผัสอาหารมีอายุ 1 ปี
            </p>
          </div>
          <div>
            <label className="label">สถานพยาบาล</label>
            <input className="input" value={clinic}
              onChange={(e) => setClinic(e.target.value)}
              placeholder="เช่น รพ. สมเด็จ ณ ศรีราชา" maxLength={200} />
          </div>
          <div>
            <label className="label">แพทย์ผู้ตรวจ</label>
            <input className="input" value={doctor}
              onChange={(e) => setDoctor(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label className="label">เลขที่ใบรับรอง</label>
            <input className="input" value={certNo}
              onChange={(e) => setCertNo(e.target.value)} maxLength={100} />
          </div>
          <div>
            <label className="label">ผลโดยรวม *</label>
            <select className="input" value={overall}
              onChange={(e) => setOverall(e.target.value as HealthOverall)}>
              <option value="pass">ผ่าน</option>
              <option value="conditional">ผ่านแบบมีเงื่อนไข</option>
              <option value="fail">ไม่ผ่าน</option>
            </select>
          </div>
        </div>

        {/* Per-disease checklist is the ส.ณ.11 food-handler form — only
            meaningful for the periodic exam. Other exam types record the
            outcome + attach the result file instead. */}
        {examType === "periodic" && (
          <div className="border-t border-slate-200 pt-3 space-y-3">
            <ItemGroup title="โรคต้องห้ามสำหรับผู้สัมผัสอาหาร (แพทย์รับรองว่าไม่เป็น)"
              items={prohibited} onChange={setItemResult} />
            <ItemGroup title="การตรวจทางห้องปฏิบัติการ / เพิ่มเติม"
              items={lab} onChange={setItemResult} />
          </div>
        )}

        <div>
          <label className="label">แนบไฟล์ผลตรวจ (PDF / รูปภาพ)</label>
          <input type="file" accept="application/pdf,image/*" className="input text-xs"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="text-[10px] text-slate-400 mt-1">
            {hasFile && !file
              ? "มีไฟล์แนบอยู่แล้ว — เลือกไฟล์ใหม่เพื่อแทนที่ · พนักงานเปิดดูได้ในเมนูผลตรวจสุขภาพของตัวเอง"
              : "อัปโหลดไฟล์ผลตรวจจริง (สูงสุด 12 MB) · พนักงานจะเปิดดูได้เฉพาะผลของตัวเอง"}
          </p>
          {hasFile && (
            <a href={apiUrl(`/api/health/exam-file/${row.checkup_id}`)}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-brand hover:underline">ดูไฟล์ปัจจุบัน</a>
          )}
        </div>
        <div>
          <label className="label">หรือใส่ลิงก์ไฟล์ภายนอก (ถ้ามี)</label>
          <input className="input text-xs" value={attachmentUrl}
            onChange={(e) => setAttachmentUrl(e.target.value)}
            placeholder="https://drive.google.com/..." maxLength={500} />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="input text-sm" rows={2} value={notes}
            onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </div>

        {err && <div className="text-rose-600 text-sm">✗ {err}</div>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            ยกเลิก
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-full bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
            {busy ? "กำลังบันทึก..." : editMode === "edit" ? "บันทึกการแก้ไข" : "บันทึกผลตรวจ"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ItemGroup({
  title, items, onChange
}: {
  title: string;
  items: HealthCheckupItemRow[];
  onChange: (key: string, result: HealthItemResult) => void;
}) {
  const opts: Array<{ v: HealthItemResult; label: string; cls: string }> = [
    { v: "pass", label: "ปกติ", cls: "peer-checked:bg-emerald-500 peer-checked:text-white peer-checked:border-emerald-500" },
    { v: "fail", label: "ผิดปกติ", cls: "peer-checked:bg-rose-500 peer-checked:text-white peer-checked:border-rose-500" },
    { v: "na", label: "ไม่ได้ตรวจ", cls: "peer-checked:bg-slate-400 peer-checked:text-white peer-checked:border-slate-400" }
  ];
  return (
    <div>
      <div className="text-xs font-bold text-slate-700 mb-1.5">{title}</div>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.key}
            className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-slate-700 flex-1 min-w-[140px]">
              {it.label}
            </span>
            <div className="flex gap-1">
              {opts.map((o) => (
                <label key={o.v} className="cursor-pointer">
                  <input type="radio" className="sr-only peer"
                    name={`item-${it.key}`}
                    checked={it.result === o.v}
                    onChange={() => onChange(it.key, o.v)} />
                  <span className={`inline-block text-[11px] px-2.5 py-1 rounded-md border border-slate-300 text-slate-600 ${o.cls}`}>
                    {o.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
