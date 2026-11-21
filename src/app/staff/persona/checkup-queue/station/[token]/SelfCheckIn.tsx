"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// The registration poster's page: the employee sees their own number and confirms their check-in with one tap.
export default function SelfCheckIn({ roundId, roundName, queueNo, token }: { roundId: number; roundName: string; queueNo: number; token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/annual-checkup/me/checkin"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roundId, token }) });
      const j = await res.json().catch(() => ({} as { message?: string }));
      if (!res.ok) throw new Error(j.message ?? "fail");
      router.replace("/staff/persona/checkup-queue"); router.refresh();
    } catch (e) { setErr(e instanceof Error && e.message !== "fail" ? e.message : "ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือแจ้งเจ้าหน้าที่"); setBusy(false); }
  }

  return (
    <div className="card p-5 space-y-4 text-center">
      <div className="text-sm font-semibold text-slate-700">{roundName}</div>
      <div>
        <div className="text-xs text-slate-500">ลำดับของท่าน</div>
        <div className="text-7xl font-extrabold leading-none text-brand tabular-nums">{queueNo}</div>
      </div>
      <p className="text-sm text-slate-600">กดปุ่มด้านล่างเพื่อลงทะเบียนเช็กอินด้วยตนเอง จากนั้นระบบจะแสดงสถานีที่ท่านต้องไป เจ้าหน้าที่จะบันทึกหมายเลขชุดเก็บตัวอย่างให้ท่านอีกครั้ง</p>
      <button type="button" onClick={go} disabled={busy} className="btn-primary w-full min-h-[52px] text-lg">ยืนยันลงทะเบียน (เช็กอิน)</button>
      {err && <p className="text-sm text-rose-600" role="alert">{err}</p>}
    </div>
  );
}
