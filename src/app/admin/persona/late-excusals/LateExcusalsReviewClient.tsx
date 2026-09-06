"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";
import type { LateExcusalWithName } from "@/lib/late-excusals";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "รออนุมัติ", cls: "bg-amber-100 text-amber-700" },
  approved: { label: "อนุโลมแล้ว", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "ไม่อนุมัติ", cls: "bg-rose-100 text-rose-700" }
};

export default function LateExcusalsReviewClient({ rows }: { rows: LateExcusalWithName[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function decide(id: number, action: "approve" | "reject") {
    let note: string | null = null;
    if (action === "reject") {
      note = window.prompt("เหตุผลที่ไม่อนุมัติ (ถ้ามี):") ?? "";
    }
    setBusyId(id); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/late-excusals/${id}`), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note: note || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error === "branch_forbidden" ? "ไม่มีสิทธิ์อนุมัติของสาขานี้" : "ทำรายการไม่สำเร็จ"); return; }
      router.refresh();
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setBusyId(null); }
  }

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4">
      {err && <div className="card text-sm text-rose-600">{err}</div>}

      <div className="card overflow-x-auto">
        <h2 className="font-bold text-slate-800 text-sm mb-2">รอพิจารณา ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">ไม่มีคำขอค้าง</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">พนักงาน</th>
                <th className="py-2 pr-3">วันที่</th>
                <th className="py-2 pr-3">สาย(นาที)</th>
                <th className="py-2 pr-3">เหตุผล</th>
                <th className="py-2 pr-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <div className="font-medium text-slate-800">{nameWithPrefix(r.title_prefix, r.display_name)}</div>
                    <div className="text-[11px] text-slate-400">{r.branch_name ?? "—"}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-700">{r.work_date}</td>
                  <td className="py-2 pr-3 tabular-nums text-slate-600">{r.late_minutes > 0 ? r.late_minutes : "—"}</td>
                  <td className="py-2 pr-3 text-slate-600 max-w-[280px]">{r.reason}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    <button type="button" disabled={busyId === r.id} onClick={() => decide(r.id, "approve")}
                      className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-40 mr-1">
                      อนุโลม
                    </button>
                    <button type="button" disabled={busyId === r.id} onClick={() => decide(r.id, "reject")}
                      className="text-xs px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 disabled:opacity-40">
                      ไม่อนุมัติ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {decided.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-slate-500 select-none">
            ที่พิจารณาแล้ว ({decided.length})
          </summary>
          <table className="w-full text-sm mt-2">
            <tbody>
              {decided.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-700">{nameWithPrefix(r.title_prefix, r.display_name)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-slate-500">{r.work_date}</td>
                  <td className="py-1.5 pr-3 text-slate-500 max-w-[260px]">
                    {r.reason}
                    {r.decision_note && <span className="block text-[11px] text-slate-400">หมายเหตุ: {r.decision_note}</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
