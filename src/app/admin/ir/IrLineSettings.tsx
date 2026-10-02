"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";

// RM LINE group binding for the IR module (owner 2026-10-02): paste the group
// id, save, send a test card. Lives on the IR dashboard so the RM lead sets it
// up where they work.
export default function IrLineSettings({ initialGroupId }: { initialGroupId: string | null }) {
  const [open, setOpen] = useState(!initialGroupId);
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [saved, setSaved] = useState(initialGroupId ?? "");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function call(body: Record<string, unknown>, kind: "save" | "test") {
    setBusy(kind); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/ir/settings"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: humanizeApiError(j, "ไม่สำเร็จ") }); return; }
      if (kind === "save") { setSaved(j.lineGroupId ?? ""); setGroupId(j.lineGroupId ?? ""); setMsg({ kind: "ok", text: j.lineGroupId ? "บันทึกแล้ว — รายงานใหม่จะส่งเข้ากลุ่มนี้" : "ปิดการส่งแล้ว" }); }
      else setMsg({ kind: "ok", text: `ส่งการ์ดทดสอบแล้ว (${j.sent}) — เช็คในกลุ่ม LINE` });
    } catch {
      setMsg({ kind: "err", text: "เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card space-y-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
        <div>
          <h2 className="font-semibold text-slate-800 text-sm">แจ้งเตือน LINE ไปกลุ่มทีม RM</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {saved ? <>เปิดอยู่ · รายงานใหม่ทุกฉบับส่งเข้ากลุ่ม <span className="font-mono">{saved.slice(0, 6)}…</span></> : "ยังไม่ได้ตั้งค่า — รายงานใหม่จะไม่ส่งเข้า LINE"}
          </p>
        </div>
        <span className="text-xs text-brand">{open ? "ซ่อน" : "ตั้งค่า"}</span>
      </button>
      {open && (
        <div className="space-y-2.5 pt-1 border-t border-slate-100">
          {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
          <div>
            <label className="label">LINE Group ID ของกลุ่มทีม RM</label>
            <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="เช่น Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="input" />
            <p className="text-xs text-slate-500 mt-1.5">
              เพิ่มบัญชี NOKHOOK OS (platform OA) เข้ากลุ่มก่อน แล้วนำ Group ID มาใส่ · เว้นว่างเพื่อปิดการส่ง · ตั้งแยกต่อสาขา
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className="btn btn-primary text-sm" disabled={busy != null} onClick={() => call({ lineGroupId: groupId.trim() || null }, "save")}>
              {busy === "save" ? "กำลังบันทึก…" : "บันทึก"}
            </button>
            <button type="button" className="btn btn-secondary text-sm" disabled={busy != null || !saved} onClick={() => call({ test: true }, "test")}
              title={saved ? "ส่งรายงานล่าสุดของสาขาเป็นการ์ดทดสอบ" : "บันทึก Group ID ก่อน"}>
              {busy === "test" ? "กำลังส่ง…" : "ส่งการ์ดทดสอบ"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
