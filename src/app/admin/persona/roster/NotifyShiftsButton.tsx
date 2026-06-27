"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { useConfirm } from "@/app/components/useConfirm";

// "แจ้งเตือนเวรวันนี้" — fires the personal-LINE shift reminder for
// today on demand (the admin's active branch). Mirrors the automatic
// morning cron; useful for testing or an ad-hoc resend. Shows a
// one-line result so the admin sees how many messages went out.
export default function NotifyShiftsButton() {
  const { confirm, ConfirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    if (busy) return;
    const ok = await confirm({ title: "ยืนยัน", body: "ส่งแจ้งเตือนเวรวันนี้เข้าไลน์ส่วนตัวพนักงานที่มีเวร?", confirmLabel: "ตกลง", cancelLabel: "ยกเลิก", variant: "default" });
    if (ok === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/notify-shifts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg(j.error ? `ส่งไม่สำเร็จ: ${j.error}` : "ส่งไม่สำเร็จ");
        return;
      }
      setMsg(
        j.recipients === 0
          ? "วันนี้ไม่มีพนักงานที่มีเวร (หรือยังไม่ได้เชื่อมต่อ LINE)"
          : `ส่งแล้ว ${j.sent}/${j.recipients} คน${j.skipped ? ` · ส่งไม่สำเร็จ ${j.skipped}` : ""}`
      );
    } catch {
      setMsg("ส่งไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {ConfirmDialog}
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className="text-xs px-3 py-1.5 rounded border border-brand text-brand font-bold hover:bg-rose-50 disabled:opacity-50"
      >
        {busy ? "กำลังส่ง…" : "แจ้งเตือนเวรวันนี้"}
      </button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </span>
  );
}
