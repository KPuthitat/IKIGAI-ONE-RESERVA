"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { Banner, post } from "./shared";

// The approver doctor types their licence number once; a signed cookie then unlocks verify / revise / release for 30 minutes.
export default function UnlockPanel({ unlockedUntil }: { unlockedUntil: number | null }) {
  const router = useRouter();
  const [license, setLicense] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });

  const unlock = async () => {
    setBusy(true);
    const r = await post("unlock", { license });
    setBusy(false);
    if (r.ok) { setLicense(""); setMsg(null); router.refresh(); } else setMsg({ ok: false, text: r.message ?? "ปลดล็อกไม่สำเร็จ" });
  };
  const lock = async () => { await fetch(apiUrl("/api/annual-checkup/unlock"), { method: "DELETE" }); router.refresh(); };

  if (unlockedUntil) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
        <span>ปลดล็อกการตรวจสอบและเปิดผลแล้ว จนถึง {hhmm(unlockedUntil)} น.</span>
        <button type="button" className="text-xs underline" onClick={lock}>ล็อกอีกครั้ง</button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
      <div className="font-semibold text-amber-900">ตรวจสอบ ทำฉบับแก้ไข และเปิดผลให้พนักงานดู ต้องปลดล็อกด้วยเลขใบประกอบวิชาชีพ (ใช้ได้ 30 นาที)</div>
      <div className="flex flex-wrap gap-2">
        <input className="input w-56" inputMode="numeric" placeholder="เลขใบประกอบวิชาชีพ" value={license} onChange={(e) => setLicense(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && license.trim()) unlock(); }} />
        <button type="button" className="btn-primary" disabled={busy || !license.trim()} onClick={unlock}>ปลดล็อก</button>
      </div>
      <Banner msg={msg} />
    </div>
  );
}
