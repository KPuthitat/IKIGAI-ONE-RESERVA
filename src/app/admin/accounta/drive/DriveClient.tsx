"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DriveRow = {
  branch_id: number;
  branch_name: string;
  company_name: string | null;
  enabled: boolean;
  connected: boolean;
  oauth_email: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export default function DriveClient({ rows, serverReady }: { rows: DriveRow[]; serverReady: boolean }) {
  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีสาขา</p>}
      {rows.map((r) => <BranchCard key={r.branch_id} row={r} serverReady={serverReady} />)}
    </div>
  );
}

function BranchCard({ row, serverReady }: { row: DriveRow; serverReady: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(row.enabled);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function toggleEnabled(next: boolean) {
    setEnabled(next);
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/accounta/drive/${row.branch_id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next })
      });
      if (!res.ok) { setEnabled(!next); setMsg({ ok: false, text: "บันทึกไม่สำเร็จ" }); }
    } finally { setBusy(false); }
  }

  async function test() {
    setTesting(true); setMsg(null);
    try {
      const res = await fetch(`/api/accounta/drive/${row.branch_id}/test`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      setMsg(j.ok ? { ok: true, text: "เชื่อมต่อใช้งานได้ ✓" } : { ok: false, text: j.message || "ทดสอบไม่สำเร็จ" });
      router.refresh();
    } finally { setTesting(false); }
  }

  async function disconnect() {
    if (!confirm("ยกเลิกการเชื่อมต่อ Google Drive ของสาขานี้?")) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/accounta/drive/${row.branch_id}/disconnect`, { method: "POST" });
      if (res.ok) router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-semibold text-slate-800">
            {row.branch_name}
            {row.company_name && <span className="text-slate-400 font-normal"> · {row.company_name}</span>}
          </div>
          {row.connected ? (
            <div className="text-[12px] text-emerald-600 mt-0.5">
              เชื่อมต่อแล้ว{row.oauth_email ? `: ${row.oauth_email}` : ""}
            </div>
          ) : (
            <div className="text-[12px] text-slate-400 mt-0.5">ยังไม่ได้เชื่อมต่อ</div>
          )}
        </div>
        {row.connected && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => toggleEnabled(e.target.checked)} />
            เปิดใช้งาน
          </label>
        )}
      </div>

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>}
      {!msg && row.last_error && <p className="text-[12px] text-red-500">ครั้งล่าสุด: {row.last_error}</p>}
      {!msg && !row.last_error && row.last_ok_at && (
        <p className="text-[12px] text-emerald-600">อัปล่าสุดสำเร็จ: {row.last_ok_at.slice(0, 16).replace("T", " ")}</p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {!row.connected ? (
          <a
            href={serverReady ? `/api/accounta/drive/${row.branch_id}/oauth/start` : undefined}
            aria-disabled={!serverReady}
            className={`rounded-md px-4 py-2 text-sm font-medium ${serverReady
              ? "bg-brand text-white hover:opacity-90"
              : "bg-slate-200 text-slate-400 pointer-events-none"}`}
          >
            เชื่อมต่อ Google Drive
          </a>
        ) : (
          <>
            <button type="button" disabled={testing} onClick={test}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
              {testing ? "กำลังทดสอบ…" : "ทดสอบ"}
            </button>
            <a href={serverReady ? `/api/accounta/drive/${row.branch_id}/oauth/start` : undefined}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
              เชื่อมบัญชีใหม่
            </a>
            <button type="button" disabled={busy} onClick={disconnect}
              className="rounded-md px-4 py-2 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50">
              ยกเลิกการเชื่อมต่อ
            </button>
          </>
        )}
      </div>
    </div>
  );
}
