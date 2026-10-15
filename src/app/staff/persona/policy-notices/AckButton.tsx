"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { Field } from "@/app/components/FormKit";

// The one thing an employee does with a notice. It sits at the end of the letter, so it is pressed after reading.
export default function AckButton({ noticeId }: { noticeId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function ack() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl("/api/staff/persona/policy-notices/ack"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notice_id: noticeId, suggestion }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.message ?? "กดรับทราบไม่สำเร็จ ลองใหม่อีกครั้ง"); return; }
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 border-t border-[color:var(--card-border)] pt-3">
      {err && <div className="text-sm text-rose-600">{err}</div>}
      <Field label="ข้อเสนอแนะ" hint="ถ้ามี · ไม่ระบุชื่อ">
        <textarea rows={3} maxLength={2000} value={suggestion} onChange={(e) => setSuggestion(e.target.value)} placeholder="มีอะไรอยากเสนอ หรือไม่กล้าพูดในที่ประชุม เขียนไว้ได้ที่นี่" />
      </Field>
      <p className="text-xs text-slate-500">ฝ่ายบริหารเห็นข้อความของท่านโดยไม่เห็นว่าใครเป็นผู้เขียน (ระบบรู้เพียงว่าท่านกดรับทราบแล้ว)</p>
      <button type="button" className="btn btn-primary w-full" onClick={ack} disabled={busy}>{busy ? "กำลังบันทึก…" : "รับทราบ"}</button>
    </div>
  );
}
