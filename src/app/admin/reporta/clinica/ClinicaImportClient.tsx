"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Result = {
  filename: string; kind: "invoice" | "opd"; rangeStart: string; rangeEnd: string;
  bills?: number; items?: number; visits?: number; totalNet?: number; totalDue?: number;
};

const baht = (n: number) => `฿${n.toLocaleString("th-TH")}`;

export default function ClinicaImportClient({ onImported }: { onImported?: () => void }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [results, setResults] = useState<Result[]>([]);

  async function upload() {
    if (!files.length || busy) return;
    setBusy(true); setMsg(null); setResults([]);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const res = await fetch(apiUrl("/api/admin/reporta/clinica-import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setResults(j.imported as Result[]);
        setMsg({ kind: "ok", text: `นำเข้าสำเร็จ ${j.imported.length} ไฟล์` });
        setFiles([]);
        router.refresh();      // refresh server components (e.g. the imported-range hint)
        onImported?.();        // let an inline host (ReportaClient) re-fetch its report

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
      <label className="block">
        <span className="text-sm font-medium text-slate-700">เลือกไฟล์ (.xlsx) — เลือกทั้ง 2 ไฟล์พร้อมกันได้</span>
        <input type="file" accept=".xlsx" multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand/10 file:px-3 file:py-1.5 file:text-brand file:font-medium" />
      </label>
      {files.length > 0 && (
        <div className="text-xs text-slate-500">{files.map((f) => f.name).join(" · ")}</div>
      )}
      <button type="button" onClick={upload} disabled={busy || !files.length}
        className="btn-primary text-sm disabled:opacity-50">
        {busy ? "กำลังนำเข้า…" : "นำเข้าข้อมูล"}
      </button>
      {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
      {results.length > 0 && (
        <ul className="text-xs text-slate-600 space-y-1 border-t border-slate-200 pt-2">
          {results.map((r, i) => (
            <li key={i}>
              <b>{r.filename}</b> —{" "}
              {r.kind === "invoice"
                ? `บิล ${r.bills} ใบ · รายการ ${r.items} · ยอด ${baht(r.totalNet ?? 0)} · รอเบิก/ค้าง ${baht(r.totalDue ?? 0)}`
                : `OPD ${r.visits} รายการ`}
              {" · "}ช่วง {r.rangeStart || "—"}–{r.rangeEnd || "—"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
