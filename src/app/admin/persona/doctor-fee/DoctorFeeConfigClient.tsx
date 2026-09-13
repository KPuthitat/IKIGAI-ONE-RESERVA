"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import type { DfRule } from "@/lib/df-db";
import { RulesEditor } from "./DfRulesEditor";

type Span = { min: string | null; max: string | null; count: number };

// Doctor-Fee settings page (owner 2026-09-13): the calculation setup moved off
// the landing page onto its own page — import the clinic sales file + define
// which service codes earn DF and at what rate.
export default function DoctorFeeConfigClient({
  initialRules, span
}: {
  initialRules: DfRule[];
  span: Span;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<DfRule[]>(initialRules);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr("เลือกไฟล์ Invoice Report (.xlsx) ก่อน"); return; }
    setBusy(true); setErr(null); setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "นำเข้าไฟล์ไม่สำเร็จ")); return; }
      setUploadMsg(`นำเข้าสำเร็จ: ใหม่ ${j.inserted} · อัปเดต ${j.updated} · รวม ${j.total} บรรทัด (${j.periodStart} – ${j.periodEnd})`);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch { setErr("นำเข้าไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {err && <div className="card !py-3 text-sm text-rose-600">{err}</div>}

      {/* Bulk import of the clinic sales file */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-700 text-sm">นำเข้าไฟล์ยอดขายคลินิก (Invoice Report .xlsx)</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            className="text-sm file:mr-3 file:rounded-full file:border-0 file:bg-brand file:text-white file:px-4 file:py-2 file:text-sm" />
          <button type="button" className="btn btn-primary text-sm" onClick={upload} disabled={busy}>
            {busy ? "กำลังนำเข้า…" : "นำเข้า"}
          </button>
          {span.count > 0 && <span className="text-[11px] text-slate-400">มีข้อมูลแล้ว {span.count} บรรทัด ({span.min} – {span.max})</span>}
        </div>
        {uploadMsg && <div className="text-xs text-emerald-700">{uploadMsg}</div>}
        <p className="text-[11px] text-slate-400">ระบบดึงเฉพาะบรรทัดที่ตรงรหัสในหัวข้อ (เช่น HSC, HSC-GRP) · นำเข้าซ้ำได้ ระบบอัปเดตทับให้เอง · หรือใช้หน้า “รอบจ่ายรายสัปดาห์” นำเข้ารายวัน</p>
      </div>

      <RulesEditor rules={rules} onChange={setRules} onSaved={() => router.refresh()} />
    </div>
  );
}
