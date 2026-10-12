"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import ActionBar from "@/app/components/ActionBar";

// The one thing an employee does with a notice. Sits in the sticky bottom bar.
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
    <>
      {err && <div className="text-sm text-rose-600">{err}</div>}
      <ActionBar left="อ่านครบแล้วกดรับทราบ">
        <button type="button" className="btn btn-primary" onClick={ack} disabled={busy}>{busy ? "กำลังบันทึก…" : "รับทราบ"}</button>
      </ActionBar>
    </>
  );
}
