"use client";

import { useState } from "react";

// PDPA controls on the member card: marketing-consent toggle and delete.
// Token-gated like the page itself (the token is the customer's own link).

export default function MemberActions({ token, consentMarketing }: { token: string; consentMarketing: boolean }) {
  const [consent, setConsent] = useState(consentMarketing);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  async function toggleConsent() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/insigna/members/consent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, consent_marketing: !consent })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setConsent(!consent); setMsg(!consent ? "เปิดรับข่าวสารแล้ว" : "ปิดรับข่าวสารแล้ว"); }
      else setMsg("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } catch { setMsg("เชื่อมต่อไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm("ลบข้อมูลสมาชิกทั้งหมดของท่าน รวมถึงประวัติการมาใช้บริการและสิทธิ์ที่มี การลบนี้ย้อนกลับไม่ได้ ยืนยันหรือไม่")) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/insigna/members/delete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setGone(true);
      else setMsg("ลบไม่สำเร็จ ลองใหม่อีกครั้ง");
    } catch { setMsg("เชื่อมต่อไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  if (gone) {
    return <div className="mt-3 rounded-lg bg-slate-50 text-sm text-slate-600 px-3 py-2">ลบข้อมูลสมาชิกของท่านเรียบร้อยแล้ว ขอบคุณที่เคยใช้บริการค่ะ</div>;
  }
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={consent} disabled={busy} onChange={toggleConsent} className="h-4 w-4" />
        ยินดีรับข่าวสารและสิทธิพิเศษทาง LINE
      </label>
      <button type="button" onClick={remove} disabled={busy} className="text-[11px] text-rose-500 underline disabled:opacity-50">
        ลบข้อมูลสมาชิกของฉัน
      </button>
      {msg && <div className="text-[11px] text-slate-500">{msg}</div>}
    </div>
  );
}
