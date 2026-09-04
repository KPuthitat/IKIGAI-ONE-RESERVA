"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { QUALITY_STATUS_LABEL, type QualityVersion, type QualityVersionStatus } from "@/lib/quality-docs";

const STATUS_CLS: Record<QualityVersionStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  obsolete: "bg-slate-100 text-slate-400",
  rejected: "bg-rose-100 text-rose-700"
};

export default function QualityDocClient({
  documentId, versions, effectiveVersionId, ack
}: {
  documentId: number;
  versions: QualityVersion[];
  effectiveVersionId: number | null;
  ack: { total: number; acked: number; pending: Array<{ user_id: number; display_name: string }> } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline draft editor state (for the newest editable version).
  const editable = versions.find((v) => v.status === "draft" || v.status === "rejected");
  const pending = versions.find((v) => v.status === "pending");
  const hasApproved = versions.some((v) => v.status === "approved");
  const [content, setContent] = useState(editable?.content ?? "");
  const [effDate, setEffDate] = useState(editable?.effective_date ?? "");
  const [summary, setSummary] = useState(editable?.change_summary ?? "");

  async function call(url: string, body: unknown, method = "PATCH") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(url), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.message || j.error || "ไม่สำเร็จ"); return false; }
      router.refresh();
      return true;
    } catch { setErr("เชื่อมต่อไม่ได้"); return false; }
    finally { setBusy(false); }
  }

  const saveDraft = () => editable && call(`/api/admin/persona/quality/versions/${editable.id}`,
    { action: "edit", content, change_summary: summary || null, effective_date: effDate || null });
  const submit = () => editable && call(`/api/admin/persona/quality/versions/${editable.id}`, { action: "submit" });
  const approve = () => pending && call(`/api/admin/persona/quality/versions/${pending.id}`, { action: "approve", effective_date: effDate || undefined });
  const reject = () => {
    const reason = window.prompt("เหตุผลที่ตีกลับ:");
    if (reason && pending) call(`/api/admin/persona/quality/versions/${pending.id}`, { action: "reject", reject_reason: reason });
  };
  const newRevision = () => call(`/api/admin/persona/quality/documents/${documentId}`, {}, "POST");

  return (
    <div className="space-y-4">
      {err && <div className="card text-sm text-rose-600">{err}</div>}

      {/* Editable draft/rejected version */}
      {editable && (
        <div className="card space-y-2 border-l-4 border-amber-300">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CLS[editable.status]}`}>
              {QUALITY_STATUS_LABEL[editable.status]} · Rev {editable.rev}
            </span>
            {editable.status === "rejected" && editable.reject_reason && (
              <span className="text-[11px] text-rose-600">ตีกลับ: {editable.reject_reason}</span>
            )}
          </div>
          <div>
            <label className="label">เนื้อหา (เขียนในระบบ)</label>
            <textarea className="input" rows={8} value={content} onChange={(e) => setContent(e.target.value)} disabled={busy}
              placeholder="พิมพ์ขั้นตอน/วิธีปฏิบัติงานที่นี่ (หรือแนบไฟล์เพิ่มในเฟสถัดไป)" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">วันที่มีผลบังคับใช้</label>
              <input type="date" className="input" value={effDate} onChange={(e) => setEffDate(e.target.value)} disabled={busy} />
            </div>
            <div>
              <label className="label">สรุปการแก้ไขรอบนี้</label>
              <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} disabled={busy} placeholder="เช่น ปรับขั้นตอนที่ 3" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={saveDraft} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600">บันทึกร่าง</button>
            <button type="button" disabled={busy} onClick={submit} className="text-sm px-4 py-1.5 rounded-lg bg-amber-600 text-white font-medium disabled:opacity-40">ส่งอนุมัติ</button>
          </div>
        </div>
      )}

      {/* Pending approval */}
      {pending && (
        <div className="card space-y-2 border-l-4 border-amber-400">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CLS.pending}`}>รออนุมัติ · Rev {pending.rev}</span>
          </div>
          {pending.content && <div className="text-sm text-slate-700 whitespace-pre-wrap max-h-60 overflow-auto rounded bg-slate-50 p-3">{stripHtml(pending.content)}</div>}
          <div className="flex items-center justify-end gap-2">
            <input type="date" className="input max-w-[160px]" value={effDate} onChange={(e) => setEffDate(e.target.value)} disabled={busy} />
            <button type="button" disabled={busy} onClick={reject} className="text-sm px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600">ตีกลับ</button>
            <button type="button" disabled={busy} onClick={approve} className="text-sm px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-40">อนุมัติ / ให้มีผล</button>
          </div>
        </div>
      )}

      {/* Effective version + acknowledgement status */}
      {effectiveVersionId != null && (() => {
        const eff = versions.find((v) => v.id === effectiveVersionId)!;
        return (
          <div className="card space-y-2 border-l-4 border-emerald-400">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CLS.approved}`}>อนุมัติ/มีผล · Rev {eff.rev}</span>
              {eff.effective_date && <span className="text-[11px] text-slate-500">มีผล {eff.effective_date}</span>}
              {!editable && !pending && (
                <button type="button" disabled={busy} onClick={newRevision} className="ml-auto text-xs text-brand hover:underline">+ สร้างฉบับแก้ไขใหม่</button>
              )}
            </div>
            {eff.content && <div className="text-sm text-slate-700 whitespace-pre-wrap rounded bg-slate-50 p-3">{stripHtml(eff.content)}</div>}
            {ack && (
              <div className="text-xs text-slate-500 border-t border-slate-100 pt-2">
                รับทราบแล้ว <b className={ack.acked === ack.total ? "text-emerald-700" : "text-amber-700"}>{ack.acked}/{ack.total}</b> คน
                {ack.pending.length > 0 && (
                  <span className="block mt-0.5 text-slate-400">ยังไม่รับทราบ: {ack.pending.map((p) => p.display_name).join(", ")}</span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Revision history */}
      <div className="card">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">ประวัติเวอร์ชัน</h3>
        <table className="w-full text-sm">
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 font-mono text-slate-600">Rev {v.rev}</td>
                <td className="py-1.5 pr-3"><span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_CLS[v.status]}`}>{QUALITY_STATUS_LABEL[v.status]}</span></td>
                <td className="py-1.5 pr-3 text-xs text-slate-500">{v.change_summary ?? "—"}</td>
                <td className="py-1.5 pr-3 text-xs text-slate-400 whitespace-nowrap">{v.effective_date ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The content may be HTML (rich) or plain text; render a readable text preview.
function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}
