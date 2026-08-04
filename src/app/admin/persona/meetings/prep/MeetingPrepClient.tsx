"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { ManagerReportRow } from "@/lib/manager-reports";
import type { PrepSummaryRow } from "@/lib/meeting-prep";

const fmtDateTime = (iso: string) => {
  const d = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
};

export default function MeetingPrepClient({
  initialFrom, initialTo, reports: initialReports, latest, aiEnabled, canCompanyWide = false
}: {
  initialFrom: string;
  initialTo: string;
  reports: ManagerReportRow[];
  latest: PrepSummaryRow | null;
  aiEnabled: boolean;
  canCompanyWide?: boolean;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [companyWide, setCompanyWide] = useState(false);
  const [reports, setReports] = useState(initialReports);

  const [summary, setSummary] = useState<string>(latest?.summary ?? "");
  const [summaryMeta, setSummaryMeta] = useState<string>(
    latest ? `สรุปล่าสุด ${fmtDateTime(latest.created_at)} · ${latest.report_count} รายงาน` : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function reloadReports(f: string, t: string) {
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/manager-reports?from=${f}&to=${t}`));
      const j = await res.json().catch(() => ({}));
      if (res.ok) setReports(j.reports ?? []);
    } catch { /* keep current preview on error */ }
  }

  async function summarize() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/meeting-prep/summarize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, company_wide: companyWide })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message ?? j.error ?? "สรุปไม่สำเร็จ"); return; }
      setSummary(j.summary);
      setSummaryMeta(`สรุปเมื่อสักครู่ · ${j.reportCount} รายงาน · ${j.model}`);
    } catch {
      setErr("เกิดข้อผิดพลาด ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  async function createMeeting() {
    if (!summary.trim()) return;
    setCreating(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/meetings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `ประชุมประจำสัปดาห์ ${to}`,
          meeting_date: to,
          summary,
          company_wide: companyWide
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message ?? j.error ?? "สร้างประชุมไม่สำเร็จ"); return; }
      router.push(`/admin/persona/meetings/${j.id}`);
    } catch {
      setErr("เกิดข้อผิดพลาด");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── ควบคุมช่วง + ปุ่มสรุป ── */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-bold text-slate-700">ช่วงรายงาน</span>
          <input type="date" value={from} max={to}
            onChange={(e) => { setFrom(e.target.value); reloadReports(e.target.value, to); }}
            className="border border-slate-300 rounded px-2 py-1 text-xs" />
          <span className="text-slate-400">ถึง</span>
          <input type="date" value={to} min={from}
            onChange={(e) => { setTo(e.target.value); reloadReports(from, e.target.value); }}
            className="border border-slate-300 rounded px-2 py-1 text-xs" />
          {canCompanyWide && (
            <label className="text-xs text-slate-600 flex items-center gap-1.5 ml-1">
              <input type="checkbox" checked={companyWide}
                onChange={(e) => setCompanyWide(e.target.checked)} />
              ระดับบริษัท
            </label>
          )}
          <span className="flex-1" />
          <button type="button" disabled={busy || !aiEnabled || reports.length === 0} onClick={summarize}
            className="text-sm px-4 py-1.5 rounded-md bg-brand text-white font-bold hover:opacity-90 disabled:opacity-40">
            {busy ? "AI กำลังสรุป…" : "✨ สรุปด้วย AI"}
          </button>
        </div>
        {!aiEnabled && (
          <p className="text-[11px] text-amber-600">ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ — ปุ่มสรุปจะใช้ไม่ได้</p>
        )}
        <p className="text-xs text-slate-500">
          พบ <b>{reports.length}</b> รายงานในช่วงนี้{reports.length === 0 ? " — ยังไม่มีรายงานให้สรุป" : ""}
        </p>
        {err && <p className="text-xs text-rose-600">{err}</p>}
      </div>

      {/* ── ผลสรุปจาก AI ── */}
      {summary && (
        <div className="card space-y-2 border-brand/30">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-800">📋 วาระประชุม (จาก AI)</span>
            {summaryMeta && <span className="text-[11px] text-slate-400">{summaryMeta}</span>}
            <span className="flex-1" />
            <button type="button" disabled={creating} onClick={createMeeting}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white font-bold hover:opacity-90 disabled:opacity-40">
              {creating ? "กำลังสร้าง…" : "＋ สร้างประชุมจากสรุปนี้"}
            </button>
          </div>
          <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{summary}</div>
          <p className="text-[10px] text-slate-400">
            * AI ช่วยเรียบเรียงจากรายงานจริง โปรดตรวจทานก่อนใช้ประชุม
          </p>
        </div>
      )}

      {/* ── รายงานดิบในช่วง ── */}
      <div>
        <h2 className="text-sm font-bold text-slate-700 mb-2">รายงานในช่วงนี้</h2>
        <div className="space-y-2">
          {reports.length === 0 ? (
            <div className="card text-sm text-slate-400 text-center py-6">ไม่มีรายงาน</div>
          ) : reports.map((r) => (
            <div key={r.id} className="card space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-400 font-mono">{r.report_date}</span>
                <span className="text-xs font-bold text-slate-700">
                  {nameWithPrefix(r.author_prefix, r.author_name ?? "") || "—"}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {r.branch_name ?? "ทั้งบริษัท"}
                </span>
              </div>
              {r.shift_summary && <Line label="ปิดกะ" text={r.shift_summary} />}
              {r.situation && <Line label="สถานการณ์" text={r.situation} />}
              {r.meeting_topics && <Line label="เข้าประชุม" text={r.meeting_topics} accent />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Line({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className={`flex-shrink-0 font-bold ${accent ? "text-amber-700" : "text-slate-400"}`}>{label}:</span>
      <span className="text-slate-700 whitespace-pre-wrap">{text}</span>
    </div>
  );
}
