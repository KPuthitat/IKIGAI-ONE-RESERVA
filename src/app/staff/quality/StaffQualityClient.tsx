"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { QUALITY_TYPE_LABEL, type StaffDocRow } from "@/lib/quality-docs";

export default function StaffQualityClient({ docs }: { docs: StaffDocRow[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pending = docs.filter((d) => !d.acknowledged_at);
  const acked = docs.filter((d) => d.acknowledged_at);

  async function ack(versionId: number) {
    setBusyId(versionId); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/staff/quality/ack"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version_id: versionId })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message || j.error || "ไม่สำเร็จ"); return; }
      router.refresh();
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusyId(null); }
  }

  if (docs.length === 0) {
    return <div className="card text-sm text-slate-400 text-center py-8">ยังไม่มีเอกสารที่ต้องอ่าน</div>;
  }

  return (
    <div className="space-y-4">
      {err && <div className="card text-sm text-rose-600">{err}</div>}

      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ยังไม่รับทราบ ({pending.length})</h2>
        {pending.length === 0 && <p className="text-sm text-slate-400">รับทราบครบทุกฉบับแล้ว</p>}
        {pending.map((d) => (
          <DocRow key={d.document_id} d={d} open={openId === d.document_id}
            onToggle={() => setOpenId(openId === d.document_id ? null : d.document_id)}
            busy={busyId === d.version_id} onAck={() => ack(d.version_id)} />
        ))}
      </div>

      {acked.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-slate-500 select-none">
            รับทราบแล้ว ({acked.length})
          </summary>
          <div className="space-y-2 mt-2">
            {acked.map((d) => (
              <DocRow key={d.document_id} d={d} open={openId === d.document_id}
                onToggle={() => setOpenId(openId === d.document_id ? null : d.document_id)}
                busy={false} onAck={() => {}} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function DocRow({
  d, open, onToggle, busy, onAck
}: { d: StaffDocRow; open: boolean; onToggle: () => void; busy: boolean; onAck: () => void }) {
  const done = !!d.acknowledged_at;
  return (
    <div className="border-t border-slate-100 pt-2 first:border-t-0">
      <button type="button" onClick={onToggle} className="w-full text-left flex items-start gap-2">
        <span className="font-mono text-[11px] text-slate-500 mt-0.5 whitespace-nowrap">{d.doc_code}</span>
        <span className="flex-1 min-w-0">
          <span className="font-medium text-slate-800">{d.title}</span>
          <span className="block text-[11px] text-slate-400">
            {QUALITY_TYPE_LABEL[d.doc_type]} · Rev {d.rev}
            {d.branch_name ? ` · ${d.branch_name}` : " · ทุกสาขา"}
            {d.effective_date ? ` · มีผล ${d.effective_date}` : ""}
          </span>
        </span>
        {done
          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 whitespace-nowrap">รับทราบแล้ว</span>
          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 whitespace-nowrap">ยังไม่อ่าน</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {d.content
            ? <div className="text-sm text-slate-700 whitespace-pre-wrap rounded bg-slate-50 p-3">{stripHtml(d.content)}</div>
            : <p className="text-sm text-slate-400 italic">— ไม่มีเนื้อหาในระบบ —</p>}
          {d.file_path && d.file_name && (
            <a href={d.file_path} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
              เปิดไฟล์แนบ ({d.file_name})
            </a>
          )}
          {!done && (
            <div className="flex justify-end">
              <button type="button" disabled={busy} onClick={onAck}
                className="text-sm px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-40">
                {busy ? "..." : "รับทราบ"}
              </button>
            </div>
          )}
          {done && (
            <p className="text-[11px] text-slate-400 text-right">รับทราบเมื่อ {d.acknowledged_at}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Content may be rich HTML or plain text; render a readable text preview.
function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}
