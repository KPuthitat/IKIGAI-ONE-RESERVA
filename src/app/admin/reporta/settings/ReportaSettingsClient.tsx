"use client";

import { useState } from "react";

// REPORTA settings — bind the HOD LINE group id the daily/weekly cards push to
// (owner 2026-09-16). The IKIGAI OS platform OA must be a member of that group.

export default function ReportaSettingsClient({ initialGroupId, initialTarget }: { initialGroupId: string | null; initialTarget: number | null }) {
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [target, setTarget] = useState(initialTarget != null ? String(initialTarget) : "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setSaving(true); setMsg(null);
    const t = target.replace(/[, ]/g, "").trim();
    const targetNum = t === "" ? null : Number(t);
    if (targetNum != null && !Number.isFinite(targetNum)) { setMsg({ kind: "err", text: "เป้ายอดต้องเป็นตัวเลข" }); setSaving(false); return; }
    try {
      const r = await fetch("/api/admin/reporta/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineGroupId: groupId.trim() || null, monthlyTarget: targetNum })
      }).then((x) => x.json());
      if (r.ok) setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      else setMsg({ kind: "err", text: r.error ?? "บันทึกไม่สำเร็จ" });
    } catch { setMsg({ kind: "err", text: "บันทึกผิดพลาด" }); }
    setSaving(false);
  };

  return (
    <div className="card space-y-4">
      {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
      <div>
        <label className="label">LINE Group ID ของกลุ่มหัวหน้างาน (HOD)</label>
        <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="เช่น Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="input" />
        <p className="text-xs text-slate-500 mt-1.5">
          เพิ่มบัญชี IKIGAI OS (platform OA) เข้ากลุ่มก่อน แล้วนำ Group ID มาใส่ · เว้นว่างเพื่อปิดการส่ง
        </p>
      </div>
      <div>
        <label className="label">เป้ายอดขายต่อเดือน (บาท)</label>
        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="เช่น 500000" className="input !w-48" />
        <p className="text-xs text-slate-500 mt-1.5">
          ใช้แสดงแถบความคืบหน้า + คาดการณ์สิ้นเดือนในหน้าวิเคราะห์ · เว้นว่างเพื่อไม่ตั้งเป้า
        </p>
      </div>
      <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
    </div>
  );
}
