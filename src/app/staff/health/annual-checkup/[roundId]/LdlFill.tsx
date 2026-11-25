"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "../shared";

// Shown only when the owner has turned LDL calculation on: fills LDL for people whose three values were entered before the switch.
export default function LdlFill({ roundId }: { roundId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => { setBusy(true); setMsg(null); const r = await post("ldl-fill", { roundId }); setBusy(false); setMsg(r.ok ? `คำนวณให้ ${r.filled as number} คน` : (r.message as string) ?? "ไม่สำเร็จ"); if (r.ok) router.refresh(); };
  return (
    <div className="card flex flex-wrap items-center gap-3">
      <div className="text-sm text-slate-700 flex-1 min-w-[12rem]">โหมดคำนวณ LDL เปิดอยู่ — คนที่มีคอเลสเตอรอลรวม HDL และไตรกลีเซอไรด์ครบแต่ยังไม่มี LDL</div>
      <button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy} onClick={run}>{busy ? "กำลังคำนวณ…" : "คำนวณ LDL ที่ยังขาด"}</button>
      {msg && <div className="w-full text-sm text-slate-700" role="status">{msg}</div>}
    </div>
  );
}
