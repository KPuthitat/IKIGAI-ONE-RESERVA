"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type Res = { ok: boolean; message?: string };
async function call(path: string, method: string, body?: unknown): Promise<Res> {
  try {
    const r = await fetch(apiUrl(`/api/annual-checkup/me/${path}`), { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return await r.json();
  } catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

/** Step 1 (consent) and step 2 (PIN) before the results are shown; also the "lock again" button once they are. */
export default function AnnualGate({ step, consent }: { step: "consent" | "pin" | "lock"; consent?: { version: string; body: string } }) {
  const router = useRouter();
  const [agree, setAgree] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<Res>) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { setPin(""); router.refresh(); } else setErr(r.message ?? "ไม่สำเร็จ");
  };

  if (step === "lock") {
    return <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => run(() => call("unlock", "DELETE"))}>ปิดหน้าผล (ล็อก)</button>;
  }
  if (step === "consent" && consent) {
    return (
      <div className="card p-5 space-y-3 max-w-2xl">
        <h2 className="font-semibold text-slate-800">ข้อตกลงการคุ้มครองข้อมูลส่วนบุคคล (เวอร์ชัน {consent.version})</h2>
        <p className="text-sm text-slate-700 whitespace-pre-line">{consent.body}</p>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>ข้าพเจ้าได้อ่านและยอมรับข้อตกลงข้างต้น</span>
        </label>
        {err && <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">{err}</div>}
        <button type="button" className="btn-primary" disabled={!agree || busy} onClick={() => run(() => call("consent", "POST", {}))}>ยอมรับและดำเนินการต่อ</button>
      </div>
    );
  }
  return (
    <form className="card p-5 space-y-3 max-w-sm" onSubmit={(e) => { e.preventDefault(); run(() => call("unlock", "POST", { pin })); }}>
      <h2 className="font-semibold text-slate-800">ยืนยันตัวตนเพื่อดูผลตรวจ</h2>
      <p className="text-sm text-slate-600">กรอกรหัส PIN 4 หลักของท่าน (รหัสเดียวกับที่ใช้ลงเวลา)</p>
      <input type="password" inputMode="numeric" autoComplete="off" maxLength={4} className="input text-center tracking-[0.5em] text-lg" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} aria-label="รหัส PIN" />
      {err && <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">{err}</div>}
      <button type="submit" className="btn-primary" disabled={pin.length !== 4 || busy}>ยืนยัน</button>
    </form>
  );
}
