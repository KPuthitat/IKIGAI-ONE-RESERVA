"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function PinManageClient({ hasPin }: { hasPin: boolean }) {
  const router = useRouter();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function save() {
    setMsg(null);
    if (!/^\d{4,6}$/.test(newPin)) {
      setMsg({ kind: "err", text: "PIN ต้องเป็นตัวเลข 4-6 หลัก" });
      return;
    }
    if (newPin !== confirmPin) {
      setMsg({ kind: "err", text: "PIN ใหม่กับยืนยัน PIN ไม่ตรงกัน" });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = { new_pin: newPin };
      if (hasPin) body.current_pin = currentPin;
      const res = await fetch(apiUrl("/api/admin/me/pin"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: hasPin ? "✓ เปลี่ยน PIN เรียบร้อย" : "✓ ตั้ง PIN เรียบร้อย" });
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      {!hasPin && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-md p-3">
          คุณยังไม่ได้ตั้ง PIN — ตั้ง PIN ก่อนใช้งานการอนุมัติเปลี่ยน stage ในใบสมัคร
        </div>
      )}
      {hasPin && (
        <div>
          <label className="label">PIN เดิม</label>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={currentPin}
            onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
            className="input font-mono text-center text-xl tracking-[8px]" />
        </div>
      )}
      <div>
        <label className="label">PIN ใหม่ (4-6 หลัก)</label>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
          className="input font-mono text-center text-xl tracking-[8px]" />
      </div>
      <div>
        <label className="label">ยืนยัน PIN ใหม่</label>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
          className="input font-mono text-center text-xl tracking-[8px]" />
      </div>
      <p className="text-[10px] text-slate-400">
        เคล็ดลับ: อย่าใช้เลข 4 หลักที่เดาง่าย (1234, วันเดือนปีเกิด ฯลฯ).
        ถ้าใส่ผิดเกิน 5 ครั้งจะถูกล็อก 15 นาที
      </p>
      {msg && (
        <p className={`text-sm font-bold ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.text}
        </p>
      )}
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="btn-primary w-full disabled:opacity-50">
        {busy ? "กำลังบันทึก…" : (hasPin ? "เปลี่ยน PIN" : "ตั้ง PIN")}
      </button>
    </div>
  );
}
