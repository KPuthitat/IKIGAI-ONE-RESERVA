"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type St = { code: string; name_th: string; passed: boolean };

// The employee's route through the stations. A station turns green ("ผ่านแล้ว") once it is recorded as passed: by the employee scanning the
// station's QR and confirming (so staff are not made to scan everyone), by the button here as a fallback, or by a clinic staff scan.
export default function StationChecklist({ roundId, stations }: { roundId: number; stations: St[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pass(st: St) {
    if (!window.confirm(`ยืนยันว่าท่านตรวจที่สถานี “${st.name_th}” เสร็จแล้ว?\\nเมื่อยืนยันแล้วยกเลิกเองไม่ได้`)) return;
    setBusy(st.code); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/annual-checkup/me/station"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roundId, code: st.code, marked: true }) });
      const j = await res.json().catch(() => ({} as { message?: string }));
      if (!res.ok) throw new Error(j.message ?? "fail");
      router.refresh();
    } catch (e) { setErr(e instanceof Error && e.message !== "fail" ? e.message : "บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"); }
    finally { setBusy(null); }
  }

  const done = stations.filter((s) => s.passed).length;
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-slate-700">สถานีที่ต้องไป ({done}/{stations.length})</div>
      <ol className="space-y-1.5">
        {stations.map((st, i) => (
          <li key={st.code} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${st.passed ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-slate-200 text-slate-800"}`}>
            <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold ${st.passed ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"}`}>{st.passed ? "✓" : i + 1}</span>
            <span className="grow">{st.name_th}</span>
            {st.passed ? <span className="text-xs">ผ่านแล้ว</span> : (
              <button type="button" onClick={() => pass(st)} disabled={busy === st.code}
                className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700">ผ่านการตรวจแล้ว</button>
            )}
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-slate-500">เมื่อตรวจเสร็จที่แต่ละสถานี ให้สแกน QR ที่ป้ายประจำสถานีด้วยกล้องโทรศัพท์ แล้วกดยืนยัน หรือกดปุ่ม “ผ่านการตรวจแล้ว” ที่นี่</p>
      {err && <p className="text-xs text-rose-600" role="alert">{err}</p>}
    </div>
  );
}
