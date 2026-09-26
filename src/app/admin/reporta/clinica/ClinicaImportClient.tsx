"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Result = { filename: string; kind: "invoice" | "opd"; rangeStart: string; rangeEnd: string };

// Same drag-and-drop drop zone as the restaurant POS import (owner 2026-09-27:
// "กรอบให้นำเข้าไฟล์สองระบบให้เหมือนกัน") — only the labels + the endpoint differ.
// onImported hands the host the latest imported date so it can jump the month
// browser to that data, exactly as the restaurant POS import does (owner
// 2026-09-27: "เลียนแบบให้หมด อย่าแหวกมาก").
export default function ClinicaImportClient({ onImported }: { onImported?: (target?: string) => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const incoming = Array.from(list).filter((f) => /\.xlsx$/i.test(f.name));
    if (incoming.length === 0) { setMsg({ kind: "err", text: "รองรับเฉพาะไฟล์ .xlsx" }); return; }
    const key = (f: File) => `${f.name}\u0000${f.size}`;   // delimiter so distinct files can't collide
    setFiles((prev) => {
      const seen = new Set(prev.map(key));
      const next = [...prev];
      for (const f of incoming) if (!seen.has(key(f))) { seen.add(key(f)); next.push(f); }  // dedup within the batch too
      return next;
    });
    setMsg(null);
  }

  async function upload() {
    if (!files.length || busy) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        const imported = (j.imported ?? []) as Result[];
        // Which of the two HIS exports came in, and which is still missing — the
        // restaurant POS import reports the same "ไฟล์ไหนแล้ว / ขาดไฟล์อะไร" so the
        // clinic mirrors it (owner 2026-09-27). A missing kind is a gentle amber
        // note, not an error: importing one at a time is allowed.
        const hasInv = imported.some((r) => r.kind === "invoice");
        const hasOpd = imported.some((r) => r.kind === "opd");
        const got = [hasInv ? "Invoice" : null, hasOpd ? "OPD" : null].filter(Boolean).join(" + ");
        if (hasInv && hasOpd) {
          setMsg({ kind: "ok", text: "นำเข้าสำเร็จ · Invoice + OPD ครบแล้ว" });
        } else {
          const missing = hasInv ? "OPD Report" : "Invoice Report";
          setMsg({ kind: "warn", text: `นำเข้าสำเร็จ · ${got} · ⚠️ ยังไม่ได้นำเข้า ${missing}` });
        }
        setFiles([]);
        // Latest imported date → let the host jump its month browser to that data
        // (owner 2026-09-27: after import, เด้งไปเดือนที่นำเข้า).
        const target = imported.map((r) => r.rangeEnd).filter(Boolean).sort().pop();
        router.refresh();      // refresh server components (e.g. the imported-range hint)
        onImported?.(target);  // let an inline host (ReportaClient) jump + re-fetch
      } else {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "นำเข้าไม่สำเร็จ" });
      }
    } catch {
      setMsg({ kind: "err", text: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-bold text-slate-800">นำเข้าไฟล์จาก APSX (HIS)</h2>
        <span className="text-[11px] text-slate-400">รองรับ .xlsx · Invoice / OPD Report · นำเข้าเป็นช่วงวันแล้วเขียนทับได้</span>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx" multiple className="hidden"
        onChange={(e) => addFiles(e.target.files)} />
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
          dragOver ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-slate-50/60 hover:border-emerald-300 hover:bg-emerald-50/40"
        }`}
      >
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
          </svg>
        </div>
        <div className="text-sm font-semibold text-slate-700">ลากไฟล์มาวางที่นี่ หรือ <span className="text-emerald-600 underline">เลือกไฟล์</span></div>
        <div className="mt-1 text-xs text-slate-400">ไฟล์ <b>Invoice Report</b> · <b>OPD Report</b> (.xlsx) — ระบบแยกประเภทและวันที่ให้เอง เลือกทั้ง 2 ไฟล์พร้อมกันได้ · นำเข้าเป็นช่วงวันแล้วเขียนทับได้</div>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={f.name + i} className="inline-flex items-center gap-1.5 rounded-full bg-white border border-slate-200 pl-3 pr-1.5 py-1 text-xs text-slate-600 shadow-sm">
              <span className="truncate max-w-[220px]">📄 {f.name}</span>
              <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={upload} disabled={busy || files.length === 0}
          className="btn-primary text-sm disabled:opacity-50">{busy ? "กำลังนำเข้า…" : `นำเข้าข้อมูล${files.length ? ` (${files.length})` : ""}`}</button>
        {files.length > 0 && !busy && (
          <button type="button" onClick={() => setFiles([])} className="text-xs text-slate-400 hover:text-slate-600">ล้างรายการ</button>
        )}
      </div>

      {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-600" : msg.kind === "warn" ? "text-amber-600" : "text-rose-600"}`}>{msg.text}</p>}
    </div>
  );
}
