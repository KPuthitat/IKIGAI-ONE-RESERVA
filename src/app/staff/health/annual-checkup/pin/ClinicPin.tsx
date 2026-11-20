"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

export default function ClinicPin({ next }: { next: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/annual-checkup/clinic/pin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      const j = await res.json().catch(() => ({} as { message?: string }));
      if (!res.ok) throw new Error(j.message ?? "ไม่สำเร็จ");
      router.replace(next); router.refresh();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "ไม่สำเร็จ"); setPin(""); }
    finally { setBusy(false); }
  }

  return (
    <form className="card p-5 space-y-3" onSubmit={submit}>
      <h2 className="font-semibold text-slate-800">ยืนยันตัวตนก่อนเข้าส่วนคลินิก</h2>
      <p className="text-sm text-slate-600">กรอกรหัส PIN 4 หลักของท่าน (รหัสเดียวกับที่ใช้ลงเวลา) ระบบจะเปิดให้ใช้งานต่อเนื่อง 20 นาที เมื่อครบเวลาต้องกรอกใหม่</p>
      <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} autoFocus className="input text-center tracking-[0.5em] text-lg"
        value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label="รหัส PIN 4 หลัก" />
      {err && <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200" role="alert">{err}</div>}
      <button type="submit" className="btn-primary w-full" disabled={pin.length !== 4 || busy}>ยืนยัน</button>
    </form>
  );
}
