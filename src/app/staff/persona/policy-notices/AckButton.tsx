"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// The one thing an employee does with a notice. It sits at the end of the letter, so it is pressed after reading.
export default function AckButton({ noticeId }: { noticeId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ack() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl("/api/staff/persona/policy-notices/ack"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notice_id: noticeId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.message ?? "กดรับทราบไม่สำเร็จ ลองใหม่อีกครั้ง"); return; }
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 border-t border-[color:var(--card-border)] pt-3">
      {err && <div className="text-sm text-rose-600">{err}</div>}
      <p className="text-sm text-slate-500 text-center">อ่านครบแล้ว กดรับทราบด้านล่าง</p>
      <button type="button" className="btn btn-primary w-full" onClick={ack} disabled={busy}>{busy ? "กำลังบันทึก…" : "รับทราบ"}</button>
    </div>
  );
}
