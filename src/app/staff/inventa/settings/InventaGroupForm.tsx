"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Per-branch INVENTA LINE group (owner 2026-06-06). Stock notifications
// (PO approval, expiry alerts, count submit) route to this group instead
// of the shared cross-branch group. Empty = fall back to the global group.
export default function InventaGroupForm({
  branchName, groupId, groupName
}: { branchName: string; groupId: string; groupName: string }) {
  const router = useRouter();
  const [gid, setGid] = useState(groupId);
  const [gname, setGname] = useState(groupName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const pristine = gid.trim() === groupId.trim() && gname.trim() === groupName.trim();

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/settings/group"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: gid.trim() || null, group_name: gname.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error === "invalid_group_id"
          ? "Group ID ไม่ถูกต้อง (ขึ้นต้น C/R/U ตามด้วย 32 ตัวอักษร)" : "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      router.refresh();
    } finally { setBusy(false); }
  }

  const configured = groupId.trim().length > 0;

  return (
    <details className="card !p-0 overflow-hidden group">
      <summary className="cursor-pointer list-none select-none flex items-center justify-between px-4 py-3 hover:bg-slate-50">
        <span className="font-bold text-slate-800">
          กลุ่ม LINE สำหรับ INVENTA · {branchName}
          <span className={`ml-2 text-xs font-normal ${configured ? "text-emerald-600" : "text-slate-400"}`}>
            {configured ? "(ตั้งค่าแล้ว)" : "(ใช้กลุ่มรวม)"}
          </span>
        </span>
        <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-4 pt-2 space-y-3 border-t border-slate-100">
        <p className="text-xs text-slate-500">
          แจ้งเตือนสต๊อก (ขออนุมัติสั่งซื้อ · ของใกล้หมดอายุ · ส่งผลนับสต๊อก) จะถูกส่งไป
          <b>กลุ่มเฉพาะของสาขานี้</b> — ถ้าเว้นว่าง จะใช้กลุ่มรวมเหมือนเดิม ·
          <b>เชิญบอท IKIGAI OS เข้ากลุ่มก่อน</b> บอทจะพิมพ์ Group ID ออกมาให้
        </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">ชื่อกลุ่ม (label)</label>
          <input className="input text-sm" value={gname} maxLength={100}
            onChange={(e) => setGname(e.target.value)} placeholder="เช่น คลินิกบ่อวิน · สต๊อก" />
        </div>
        <div>
          <label className="label">LINE Group ID</label>
          <input className="input text-sm font-mono" value={gid} maxLength={100}
            onChange={(e) => setGid(e.target.value)} placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
        </div>
      </div>
      {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
      <button type="button" onClick={save} disabled={busy || pristine}
        className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
        {busy ? "กำลังบันทึก…" : "บันทึก"}
      </button>
      </div>
    </details>
  );
}
