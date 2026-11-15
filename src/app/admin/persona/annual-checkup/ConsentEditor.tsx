"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

/** Owner only: publish a new PDPA text for the employee results page. Everyone is asked to accept the new version. */
export default function ConsentEditor({ version, body }: { version: string; body: string }) {
  const router = useRouter();
  const [v, setV] = useState("");
  const [text, setText] = useState(body);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await (await fetch(apiUrl("/api/admin/persona/annual-checkup/consent"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: v, body: text }) })).json();
      setMsg(r.ok ? { ok: true, text: "เผยแพร่ข้อความใหม่แล้ว พนักงานจะถูกขอให้ยอมรับอีกครั้ง" } : { ok: false, text: r.message ?? "ไม่สำเร็จ" });
      if (r.ok) { setV(""); router.refresh(); }
    } catch { setMsg({ ok: false, text: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }); }
    setBusy(false);
  };
  return (
    <div className="card p-4 space-y-2">
      <div className="font-semibold text-slate-800">ข้อตกลงคุ้มครองข้อมูล (PDPA) สำหรับหน้าผลตรวจของพนักงาน</div>
      <p className="text-xs text-slate-500">เวอร์ชันที่ใช้อยู่: {version} · เมื่อเผยแพร่เวอร์ชันใหม่ พนักงานทุกคนต้องยอมรับใหม่ก่อนดูผล</p>
      <textarea className="input w-full min-h-[160px]" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-32" placeholder="เลขเวอร์ชัน เช่น 2.0" value={v} onChange={(e) => setV(e.target.value)} />
        <button type="button" className="btn-primary text-sm" disabled={busy || !v.trim() || !text.trim()} onClick={publish}>เผยแพร่เวอร์ชันใหม่</button>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>}
    </div>
  );
}
