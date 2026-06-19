"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DriveRow = {
  branch_id: number;
  branch_name: string;
  company_name: string | null;
  enabled: boolean;
  has_key: boolean;
  sa_client_email: string | null;
  root_folder_id: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export default function DriveClient({ rows }: { rows: DriveRow[] }) {
  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-sm text-slate-400">ยังไม่มีสาขา</p>}
      {rows.map((r) => <BranchCard key={r.branch_id} row={r} />)}
    </div>
  );
}

function BranchCard({ row }: { row: DriveRow }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(row.enabled);
  const [rootFolderId, setRootFolderId] = useState(row.root_folder_id ?? "");
  const [saJson, setSaJson] = useState("");           // empty = keep existing
  const [replaceKey, setReplaceKey] = useState(!row.has_key);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { enabled, rootFolderId: rootFolderId.trim() || null };
      // Only send saJson when the admin actually pasted a key. An empty
      // textarea must NOT wipe the stored credential — omit it so the
      // server keeps the existing key (saJson omitted = keep).
      if (replaceKey && saJson.trim()) body.saJson = saJson.trim();
      const res = await fetch(`/api/accounta/drive/${row.branch_id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: j.message || "บันทึกไม่สำเร็จ" }); return; }
      setMsg({ ok: true, text: "บันทึกแล้ว" });
      setSaJson("");
      router.refresh();
    } finally { setBusy(false); }
  }

  async function test() {
    setTesting(true); setMsg(null);
    try {
      const res = await fetch(`/api/accounta/drive/${row.branch_id}/test`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      setMsg(j.ok ? { ok: true, text: "เชื่อมต่อสำเร็จ ✓" } : { ok: false, text: j.message || "เชื่อมต่อไม่สำเร็จ" });
      router.refresh();
    } finally { setTesting(false); }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-semibold text-slate-800">
            {row.branch_name}
            {row.company_name && <span className="text-slate-400 font-normal"> · {row.company_name}</span>}
          </div>
          {row.has_key && row.sa_client_email && (
            <div className="text-[11px] text-slate-500 mt-0.5">service account: {row.sa_client_email}</div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          เปิดใช้งาน
        </label>
      </div>

      <label className="block">
        <span className="text-xs text-slate-500">Folder ID ปลายทาง (ใน Drive ของสาขา)</span>
        <input
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm font-mono"
          value={rootFolderId}
          onChange={(e) => setRootFolderId(e.target.value)}
          placeholder="เช่น 1A2b3C..."
        />
      </label>

      <div>
        {row.has_key && !replaceKey ? (
          <button type="button" className="text-xs text-brand hover:underline"
            onClick={() => setReplaceKey(true)}>
            เปลี่ยน service account key
          </button>
        ) : (
          <label className="block">
            <span className="text-xs text-slate-500">
              วางเนื้อหาไฟล์ JSON ของ service account
              {row.has_key && (
                <button type="button" className="ml-2 text-slate-400 hover:underline"
                  onClick={() => { setReplaceKey(false); setSaJson(""); }}>
                  (ยกเลิก ใช้ key เดิม)
                </button>
              )}
            </span>
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-mono"
              rows={3}
              value={saJson}
              onChange={(e) => setSaJson(e.target.value)}
              placeholder='{ "type": "service_account", "client_email": "...", "private_key": "..." }'
            />
          </label>
        )}
      </div>

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>
      )}
      {!msg && row.last_error && (
        <p className="text-[12px] text-red-500">ครั้งล่าสุด: {row.last_error}</p>
      )}
      {!msg && !row.last_error && row.last_ok_at && (
        <p className="text-[12px] text-emerald-600">อัปล่าสุดสำเร็จ: {row.last_ok_at.slice(0, 16).replace("T", " ")}</p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={save}
          className="rounded-md bg-brand text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
        <button type="button" disabled={testing || !row.has_key} onClick={test}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
          {testing ? "กำลังทดสอบ…" : "ทดสอบการเชื่อมต่อ"}
        </button>
      </div>
    </div>
  );
}
