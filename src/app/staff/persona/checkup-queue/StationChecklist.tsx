"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type St = { code: string; name_th: string; passed: boolean; self_marked: boolean };

// The employee's route through the stations. A station is "ยืนยันโดยเจ้าหน้าที่" once the clinic has scanned it (official); otherwise the employee can
// press "ผ่านการตรวจแล้ว" themselves to keep track of where they are — their own note, which the clinic's scan overrides.
export default function StationChecklist({ roundId, stations }: { roundId: number; stations: St[] }) {
  const router = useRouter();
  const [marks, setMarks] = useState<Record<string, boolean>>(() => Object.fromEntries(stations.map((s) => [s.code, s.self_marked])));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(code: string) {
    const next = !marks[code];
    setBusy(code); setErr(null);
    setMarks((m) => ({ ...m, [code]: next }));
    try {
      const res = await fetch("/api/annual-checkup/me/station", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roundId, code, marked: next }) });
      if (!res.ok) throw new Error("fail");
      router.refresh();
    } catch {
      setMarks((m) => ({ ...m, [code]: !next }));
      setErr("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally { setBusy(null); }
  }

  const done = stations.filter((s) => s.passed || marks[s.code]).length;
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-slate-700">สถานีที่ต้องไป ({done}/{stations.length})</div>
      <ol className="space-y-1.5">
        {stations.map((st, i) => {
          const mine = !st.passed && marks[st.code];
          return (
            <li key={st.code} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${st.passed ? "bg-emerald-50 border-emerald-200 text-emerald-800" : mine ? "bg-sky-50 border-sky-200 text-sky-900" : "bg-white border-slate-200 text-slate-800"}`}>
              <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold ${st.passed ? "bg-emerald-600 text-white" : mine ? "bg-sky-600 text-white" : "bg-slate-200 text-slate-700"}`}>{st.passed || mine ? "✓" : i + 1}</span>
              <span className="grow">{st.name_th}</span>
              {st.passed ? <span className="text-xs">ยืนยันโดยเจ้าหน้าที่</span> : (
                <button type="button" onClick={() => toggle(st.code)} disabled={busy === st.code} aria-pressed={!!marks[st.code]}
                  className={`min-h-[36px] rounded-md border px-2.5 text-xs font-medium ${mine ? "border-sky-300 bg-white text-sky-800" : "border-slate-300 bg-white text-slate-700"}`}>
                  {mine ? "ยกเลิก" : "ผ่านการตรวจแล้ว"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-slate-500">กดปุ่ม “ผ่านการตรวจแล้ว” เพื่อบันทึกว่าท่านผ่านการตรวจที่สถานีใดแล้ว (สีฟ้า) ส่วนสีเขียว “ยืนยันโดยเจ้าหน้าที่” คือเจ้าหน้าที่คลินิกยืนยันแล้ว</p>
      {err && <p className="text-xs text-rose-600" role="alert">{err}</p>}
    </div>
  );
}
