"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

// "ดูแทน (มุมมองพนักงาน)" — start an impersonation session for this employee so
// the admin/owner sees exactly what the employee sees (their PERSONA portal,
// payslips, etc.). Backend + the orange "หยุดดูแทน" banner already exist (owner
// 2026-09-05); this is the missing start trigger. On success we go to /staff so
// the employee's own home renders immediately.
export default function ImpersonateButton({
  targetId, targetName
}: { targetId: number; targetName: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ERR_TH: Record<string, string> = {
    admin_can_only_impersonate_staff: "ดูแทนได้เฉพาะพนักงาน (Staff) เท่านั้น",
    target_not_in_your_branch: "พนักงานคนนี้ไม่ได้อยู่สาขาที่คุณดูแล",
    cannot_impersonate_self: "ดูแทนตัวเองไม่ได้",
    forbidden: "ไม่มีสิทธิ์ดูแทน"
  };

  async function start() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/impersonate/${targetId}`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(ERR_TH[j.error] ?? j.error ?? "เริ่มดูแทนไม่สำเร็จ"); return; }
      // Full reload to /staff so every server component re-reads the impersonated
      // session and the "หยุดดูแทน" banner appears.
      window.location.href = "/staff";
    } catch {
      setErr("เชื่อมต่อไม่ได้"); setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={start} disabled={busy}
        className="text-sm px-3 py-1.5 rounded-lg border border-brand/50 text-brand font-medium hover:bg-amber-50 disabled:opacity-50 whitespace-nowrap">
        {busy ? "กำลังเข้าสู่มุมมองพนักงาน..." : "ดูแทน (มุมมองพนักงาน)"}
      </button>
      {err && <span className="text-[11px] text-rose-600">{err}</span>}
      <span className="text-[10px] text-slate-400 max-w-[220px] text-right">
        จะเข้าเห็นระบบแบบที่ {targetName} เห็น · กด “หยุดดูแทน” ที่แถบด้านบนเพื่อกลับ
      </span>
    </div>
  );
}
