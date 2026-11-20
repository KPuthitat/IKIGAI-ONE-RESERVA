"use client";

import { useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/url";

export default function StationScanConfirm({ roundId, code, name, already, official }: { roundId: number; code: string; name: string; already: boolean; official: boolean }) {
  const [done, setDone] = useState(already);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/annual-checkup/me/station"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roundId, code, marked: true }) });
      const j = await res.json().catch(() => ({} as { message?: string }));
      if (!res.ok) throw new Error(j.message ?? "fail");
      setDone(true);
    } catch (e) { setErr(e instanceof Error && e.message !== "fail" ? e.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card p-5 space-y-4 text-center">
      <div className="text-sm text-slate-500">สถานี</div>
      <div className="text-2xl font-bold text-slate-900">{name}</div>
      {done ? (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-3">
          {official ? "เจ้าหน้าที่ยืนยันการผ่านสถานีนี้แล้ว" : "บันทึกว่าท่านผ่านการตรวจที่สถานีนี้แล้ว"}
        </div>
      ) : (
        <button type="button" onClick={confirm} disabled={busy} className="btn-primary w-full min-h-[48px] text-base">ยืนยันผ่านการตรวจที่สถานีนี้</button>
      )}
      {err && <p className="text-sm text-rose-600" role="alert">{err}</p>}
      <Link href="/staff/persona/checkup-queue" className="btn-secondary text-sm inline-block">กลับไปหน้าลำดับตรวจ</Link>
    </div>
  );
}
